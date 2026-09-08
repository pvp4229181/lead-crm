import mongoose from 'mongoose';
import { AIConversationSummary, Lead, User, WhatsAppConversation, WhatsAppMessage } from '../models/index.js';
import { appendMessage, buildTranscript, identifyOrCreateForPhone, recentHistory } from '../services/conversation.service.js';
import { analyzeConversation, generateAgentReply, getActiveAIConfig, isWithinBusinessHours } from '../services/ai.service.js';
import { markAsRead, sendInteractiveButtons, sendTextMessage } from '../services/whatsapp.service.js';
import { WA_ACTION } from '../services/whatsapp.actions.js';
import { sendServiceCatalogue } from '../services/greeting.service.js';
import { applyAnalysisToLead } from '../services/lead.service.js';
import { createFollowUpActivity } from '../services/automation.service.js';
import { notifyUsers } from '../services/notification.service.js';
import { emitToConversation } from '../realtime.js';
import type { ConversationAnalysis } from '../ai/provider.js';

export type NormalizedInboundMessage = {
  from: string; profileName?: string; whatsappMessageId: string; timestamp: Date; type: string;
  text?: string; mediaId?: string; mimeType?: string; caption?: string; filename?: string;
  location?: { lat: number; lng: number; name?: string; address?: string };
  interactiveId?: string;
};

// Never invent facts the customer never provided, don't leak internal instructions,
// and keep the message a normal WhatsApp length. Cheap guardrail after generation
// rather than trusting the prompt alone.
function validateResponse(text: string, maxLength: number): string {
  const safeFallback = "Happy to help — could you tell me a bit more about what you're looking for?";
  // Reasoning models emit their chain of thought either in <think> tags or as a plain
  // preamble; both would be shown verbatim to the customer, so strip the tagged form and
  // reject anything still reading as internal deliberation.
  let clean = text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<\/?think>/gi, '').trim();
  const reasoningLeak = /^(here'?s?|okay|let me|first,?)\s+(a |my |the )?(thinking|thought|reasoning)|^(analysis|reasoning|thought process)\s*:|^\d+\.\s+\*\*/i;
  const promptLeak = /system prompt|as an ai language model|i am an ai|my instructions (are|were)/i;
  if (!clean || reasoningLeak.test(clean) || promptLeak.test(clean)) clean = safeFallback;
  if (clean.length > maxLength) clean = clean.slice(0, maxLength - 1).trim() + '…';
  return clean || "Sorry, could you rephrase that?";
}

async function adminAndManagerIds(): Promise<string[]> {
  const users = await User.find({ active: true }).populate('role', 'name').select('_id role').lean();
  return users.filter((u: any) => ['Administrator', 'Sales Manager'].includes(u.role?.name)).map(u => String(u._id));
}

function escalationTrigger(analysis: ConversationAnalysis, config: Awaited<ReturnType<typeof getActiveAIConfig>>, leadScore: number, aiMessageCount: number, confidence: number): string | null {
  const rules = config.escalationRules ?? ({} as NonNullable<typeof config.escalationRules>);
  if (rules.onHumanRequest !== false && analysis.wantsHuman) return 'Customer asked for a human agent';
  if (rules.onSeriousComplaint !== false && analysis.intent === 'COMPLAINT' && analysis.sentiment === 'negative') return 'Customer reported a serious problem';
  if (rules.onNegativeSentiment !== false && analysis.sentiment === 'negative' && analysis.sentimentConfidence >= 0.7) return 'Customer sentiment turned negative';
  if (rules.onComplexPricing !== false && analysis.intent === 'NEGOTIATION') return 'Complex pricing negotiation in progress';
  if (rules.onVipLead !== false && leadScore >= (rules.vipLeadScoreThreshold ?? 80)) return 'High-value / VIP lead detected';
  if (rules.onLowConfidence !== false && confidence < (rules.lowConfidenceThreshold ?? 0.45)) return 'AI confidence too low to continue safely';
  if (aiMessageCount >= (config.maxAiMessagesBeforeEscalation ?? 20)) return 'Reached maximum AI messages for this conversation';
  return null;
}

// The orchestrator described in the spec: receiveMessage → … → notifySalesperson.
// Called once per normalized inbound WhatsApp message from the webhook handler.
export async function processInboundMessage(input: NormalizedInboundMessage) {
  if (await WhatsAppMessage.exists({ whatsappMessageId: input.whatsappMessageId })) return; // duplicate delivery from Meta's retries

  const { lead, conversation, isNewLead, isNewConversation } = await identifyOrCreateForPhone(input.from, input.profileName);

  const inbound = await appendMessage({
    conversation, direction: 'INBOUND', type: input.type, text: input.text,
    whatsappMessageId: input.whatsappMessageId, mediaId: input.mediaId, mediaMimeType: input.mimeType,
    caption: input.caption, filename: input.filename, location: input.location, timestamp: input.timestamp,
  });
  if (input.mediaId) await WhatsAppMessage.updateOne({ _id: inbound._id }, { mediaUrl: `/api/whatsapp/messages/${inbound._id}/media` });
  // Show the customer their message was read (blue ticks) rather than leaving it delivered.
  void markAsRead(input.whatsappMessageId).catch(() => undefined);

  if (isNewLead) {
    const recipients = await adminAndManagerIds();
    await notifyUsers(recipients, 'new_whatsapp_lead', 'New WhatsApp lead', `${input.profileName || input.from} started a conversation`, '/whatsapp');
  }

  const config = await getActiveAIConfig();
  const conv = await WhatsAppConversation.findById(conversation._id);
  if (!conv) return;

  // A control button the customer tapped ("Talk to a human" / "Back to AI") switches the
  // mode directly — it must be handled before any AI reply, and short-circuits the rest.
  if (input.interactiveId === WA_ACTION.HUMAN || input.interactiveId === WA_ACTION.AI) {
    await applyCustomerModeChoice(conv, lead, input.interactiveId, config);
    return;
  }

  const withinHours = isWithinBusinessHours(config);
  const aiShouldReply = Boolean(input.text) && config.globalAiEnabled && conv.aiEnabled && conv.controlStatus === 'AI_ACTIVE';

  // The lead was auto-greeted by template and has now replied, which opens WhatsApp's
  // 24-hour window — the only point at which we may send the service list with links.
  if (conv.greetedAt && !conv.serviceListSentAt) {
    await sendServiceCatalogue(conv).catch(error => console.error('[whatsapp pipeline] service catalogue failed', error));
  }

  // First contact gets the welcome menu, so the choice between AI and a human is offered
  // up front rather than depending on the customer knowing to ask.
  if (isNewConversation && aiShouldReply && withinHours && config.welcomeMenuEnabled) {
    const labels = config.menuButtonLabels ?? ({} as NonNullable<typeof config.menuButtonLabels>);
    const buttons = [
      { id: WA_ACTION.QUESTION, title: labels.question || 'Ask a question' },
      { id: WA_ACTION.PRICING, title: labels.pricing || 'Pricing' },
      ...(config.humanHandoffButtonEnabled !== false ? [{ id: WA_ACTION.HUMAN, title: labels.human || 'Talk to a human' }] : []),
    ];
    const result = await sendInteractiveButtons(conv.phoneNumber, config.welcomeMessage, buttons);
    await appendMessage({ conversation: conv, direction: 'OUTBOUND', type: 'interactive', text: config.welcomeMessage, aiGenerated: true, status: result.ok ? 'SENT' : 'FAILED', whatsappMessageId: result.whatsappMessageId });
  }

  if (aiShouldReply && !withinHours) {
    const reply = await sendTextMessage(conv.phoneNumber, config.outsideHoursMessage);
    await appendMessage({ conversation: conv, direction: 'OUTBOUND', text: config.outsideHoursMessage, aiGenerated: false, status: reply.ok ? 'SENT' : 'FAILED', whatsappMessageId: reply.whatsappMessageId });
  } else if (aiShouldReply && input.text) {
    const history = (await recentHistory(conv._id, 20)).filter(m => String(m._id) !== String(inbound._id));
    const chatHistory = history.filter(m => m.text).map(m => ({ role: m.direction === 'INBOUND' ? ('user' as const) : ('assistant' as const), content: m.text! }));

    let safeText: string | null = null;
    let confidence = 0;
    try {
      const generated = await generateAgentReply({ message: input.text, history: chatHistory, language: conv.language });
      safeText = validateResponse(generated.text, config.maxResponseLength ?? 700);
      confidence = generated.confidence;
    } catch (error) {
      // Model unavailable (rate limit, timeout, bad credentials). Never leave the customer
      // on silent read: hand the conversation to a human instead of guessing a reply.
      console.error('[whatsapp pipeline] AI reply generation failed', error);
      await escalateForFailure(conv, lead, 'The AI model could not be reached, so this conversation needs a human reply');
      return;
    }

    const sendResult = await sendTextMessage(conv.phoneNumber, safeText);
    await appendMessage({ conversation: conv, direction: 'OUTBOUND', text: safeText, aiGenerated: true, status: sendResult.ok ? 'SENT' : 'FAILED', whatsappMessageId: sendResult.whatsappMessageId });
    if (!sendResult.ok) await escalateForFailure(conv, lead, `The reply could not be delivered to WhatsApp (${sendResult.error ?? 'unknown error'})`);

    const transcriptMessages = [...history, inbound, { direction: 'OUTBOUND', text: safeText } as any];
    await runAnalysis(conv, lead, buildTranscript(transcriptMessages), transcriptMessages.length, confidence, config);
  } else if (input.text) {
    // Human is handling this conversation — still analyze so the CRM sidebar stays current, but never auto-reply.
    const history = await recentHistory(conv._id, 20);
    await runAnalysis(conv, lead, buildTranscript(history), history.length, 0.9, config);
  }
}

// The customer tapped a mode button. "Talk to a human" parks the AI and alerts the team;
// "Back to AI" hands control back. Either way the customer gets an explicit confirmation,
// so they are never left wondering who they are talking to.
async function applyCustomerModeChoice(
  conv: InstanceType<typeof WhatsAppConversation>, lead: InstanceType<typeof Lead>,
  action: string, config: Awaited<ReturnType<typeof getActiveAIConfig>>,
) {
  const wantsHuman = action === WA_ACTION.HUMAN;
  const update = wantsHuman
    ? { controlStatus: 'WAITING_HUMAN' as const, aiEnabled: false }
    : { controlStatus: 'AI_ACTIVE' as const, aiEnabled: true, humanTakeover: false, aiMessageCount: 0 };
  await WhatsAppConversation.updateOne({ _id: conv._id }, update);

  const body = wantsHuman ? config.humanRequestedMessage : config.aiResumedMessage;
  // While a human is handling the chat, keep a visible way back to the assistant.
  const result = wantsHuman
    ? await sendInteractiveButtons(conv.phoneNumber, body, [{ id: WA_ACTION.AI, title: config.menuButtonLabels?.ai || 'Back to AI' }])
    : await sendTextMessage(conv.phoneNumber, body);
  await appendMessage({
    conversation: conv, direction: 'OUTBOUND', type: wantsHuman ? 'interactive' : 'text', text: body,
    aiGenerated: true, status: result.ok ? 'SENT' : 'FAILED', whatsappMessageId: result.whatsappMessageId,
  });
  // appendMessage counts every aiGenerated message toward the escalation budget, but this
  // is a control confirmation rather than a sales reply — re-zero it so resuming the AI
  // actually gives it a fresh allowance.
  if (!wantsHuman) await WhatsAppConversation.updateOne({ _id: conv._id }, { aiMessageCount: 0 });

  if (wantsHuman) {
    const recipients = lead.salesperson ? [lead.salesperson] : await adminAndManagerIds();
    await notifyUsers(recipients, 'human_handoff', 'Customer asked for a human', `${lead.contactName || conv.phoneNumber} tapped “talk to a human” in WhatsApp`, '/whatsapp');
  }
  emitToConversation(String(conv._id), 'conversation:updated', { conversation: { ...conv.toObject(), ...update } });
}

// Analysis is a best-effort enrichment: if the model fails here the customer has already
// been answered, so log and move on rather than failing the whole webhook delivery.
async function runAnalysis(
  conv: InstanceType<typeof WhatsAppConversation>, lead: InstanceType<typeof Lead>,
  transcript: string, messageCount: number, confidence: number, config: Awaited<ReturnType<typeof getActiveAIConfig>>,
) {
  try {
    const analysis = await analyzeConversation(transcript);
    await handleAnalysis(conv, lead, analysis, messageCount, confidence, config);
  } catch (error) {
    console.error('[whatsapp pipeline] conversation analysis failed', error);
  }
}

async function escalateForFailure(conv: InstanceType<typeof WhatsAppConversation>, lead: InstanceType<typeof Lead>, reason: string) {
  await WhatsAppConversation.updateOne({ _id: conv._id }, { controlStatus: 'WAITING_HUMAN', aiEnabled: false });
  const recipients = lead.salesperson ? [lead.salesperson] : await adminAndManagerIds();
  await notifyUsers(recipients, 'human_handoff', 'WhatsApp conversation needs a human', `${lead.contactName || conv.phoneNumber}: ${reason}`, '/whatsapp');
  emitToConversation(String(conv._id), 'conversation:updated', { conversation: { ...conv.toObject(), controlStatus: 'WAITING_HUMAN', aiEnabled: false } });
}

async function handleAnalysis(
  conv: InstanceType<typeof WhatsAppConversation>, lead: InstanceType<typeof Lead>,
  analysis: ConversationAnalysis, messageCount: number, confidence: number, config: Awaited<ReturnType<typeof getActiveAIConfig>>,
) {
  conv.sentiment = analysis.sentiment; conv.sentimentConfidence = analysis.sentimentConfidence; conv.detectedIntent = analysis.intent;
  if (analysis.language) conv.language = analysis.language;

  const { lead: updatedLead } = await applyAnalysisToLead(lead._id, analysis, messageCount);

  // Historical record of each analysis, separate from the latest-values snapshot the
  // Lead itself carries — so the summary trail survives later overwrites.
  if (analysis.summary) {
    await AIConversationSummary.create({
      conversation: conv._id, lead: lead._id, summary: analysis.summary,
      requirement: analysis.requirements.join('; ') || undefined,
      painPoints: analysis.painPoints, productInterest: analysis.productInterest,
      budget: analysis.budget, timeline: analysis.purchaseTimeline, objections: analysis.objections,
      nextAction: analysis.recommendedNextAction, salesProbability: analysis.salesProbability, sentiment: analysis.sentiment,
    });
  }

  const reason = conv.controlStatus === 'AI_ACTIVE' ? escalationTrigger(analysis, config, updatedLead.leadScore, conv.aiMessageCount, confidence) : null;
  if (reason) {
    conv.controlStatus = 'WAITING_HUMAN'; conv.aiEnabled = false;
    const recipients = updatedLead.salesperson ? [updatedLead.salesperson] : await adminAndManagerIds();
    await notifyUsers(recipients, 'human_handoff', 'Human handoff requested', `${updatedLead.contactName || conv.phoneNumber}: ${reason}`, '/whatsapp');
    // When the customer asked for a person in their own words, confirm it to them and leave
    // a way back to the assistant. Other escalation reasons stay internal — the customer
    // never asked, so an unprompted "connecting you to a human" would only confuse them.
    if (analysis.wantsHuman) {
      const result = await sendInteractiveButtons(conv.phoneNumber, config.humanRequestedMessage, [{ id: WA_ACTION.AI, title: config.menuButtonLabels?.ai || 'Back to AI' }]);
      await appendMessage({ conversation: conv, direction: 'OUTBOUND', type: 'interactive', text: config.humanRequestedMessage, aiGenerated: true, status: result.ok ? 'SENT' : 'FAILED', whatsappMessageId: result.whatsappMessageId });
    }
  }
  await conv.save();

  if (analysis.wantsMeeting) await createFollowUpActivity({ leadId: lead._id, assignedTo: updatedLead.salesperson, kind: 'Meeting', summary: `Schedule meeting with ${updatedLead.contactName || conv.phoneNumber}` }).then(() => notifyUsers(updatedLead.salesperson ? [updatedLead.salesperson] : [], 'meeting_requested', 'Meeting requested', `${updatedLead.contactName || conv.phoneNumber} asked for a meeting`, '/whatsapp'));
  if (analysis.intent === 'CALLBACK_REQUEST') await createFollowUpActivity({ leadId: lead._id, assignedTo: updatedLead.salesperson, kind: 'Callback', summary: `Call back ${updatedLead.contactName || conv.phoneNumber}` });
  if (analysis.wantsDemo) await createFollowUpActivity({ leadId: lead._id, assignedTo: updatedLead.salesperson, kind: 'Demo', summary: `Prepare demo for ${updatedLead.contactName || conv.phoneNumber}` });
  if (analysis.wantsPricing && updatedLead.salesperson) await notifyUsers([updatedLead.salesperson], 'pricing_request', 'Pricing requested', `${updatedLead.contactName || conv.phoneNumber} asked about pricing`, '/whatsapp');
  if (analysis.intent === 'COMPLAINT' && updatedLead.salesperson) await notifyUsers([updatedLead.salesperson], 'complaint', 'Customer complaint', `${updatedLead.contactName || conv.phoneNumber} reported a problem`, '/whatsapp');
  if (updatedLead.qualificationStatus === 'won' && updatedLead.salesperson) await notifyUsers([updatedLead.salesperson], 'purchase_confirmed', 'Purchase confirmed', `${updatedLead.contactName || conv.phoneNumber} confirmed a purchase`, '/whatsapp');

  emitToConversation(String(conv._id), 'conversation:updated', { conversation: conv.toObject(), lead: { _id: updatedLead._id, leadScore: updatedLead.leadScore, leadTemperature: updatedLead.leadTemperature, qualificationStatus: updatedLead.qualificationStatus } });
}
