// The ARIA orchestrator (spec §3). One call per normalized inbound WhatsApp message:
//
//   identify contact → create/load lead + conversation → store the message →
//   detect intent → run the matching automation (or answer with the model) →
//   update the lead, score, stage and conversation → schedule follow-ups.
//
// Deliberately holds no customer-facing copy: every word ARIA sends comes from an
// AutomationTemplate resolved at run time, so admins can change the messaging from the CRM.
import { AIConversationSummary, Lead, WhatsAppConversation, WhatsAppMessage } from '../models/index.js';
import { appendMessage, buildTranscript, identifyOrCreateForPhone, recentHistory } from '../services/conversation.service.js';
import { analyzeConversation, generateAgentReply, getActiveAIConfig, isWithinBusinessHours } from '../services/ai.service.js';
import { markAsRead, sendTextMessage } from '../services/whatsapp.service.js';
import { WA_ACTION } from '../services/whatsapp.actions.js';
import { sendServiceCatalogue } from '../services/greeting.service.js';
import { applyAnalysisToLead, missingQualificationFields } from '../services/lead.service.js';
import { createFollowUpActivity } from '../services/activity.service.js';
import { detectAriaIntent, matchNumericReply, recordFeedback } from '../services/intent.service.js';
import { adminAndManagerIds, notifyUsers } from '../services/notification.service.js';
import { dispatchTrigger } from '../automation/automation.service.js';
import { sentTemplateRecently } from '../automation/template.service.js';
import { stopFollowUps } from '../automation/scheduler.service.js';
import { INTENT_TRIGGER } from '../automation/trigger.service.js';
import { emitToConversation } from '../realtime.js';
import type { ConversationAnalysis } from '../ai/provider.js';

export type NormalizedInboundMessage = {
  from: string; profileName?: string; whatsappMessageId: string; timestamp: Date; type: string;
  text?: string; mediaId?: string; mimeType?: string; caption?: string; filename?: string;
  location?: { lat: number; lng: number; name?: string; address?: string };
  interactiveId?: string;
};

// An intent template that just fired stays quiet for this long; the model's own replies
// carry the conversation from there instead of repeating the same card.
const INTENT_TEMPLATE_COOLDOWN_MS = 12 * 3600_000;
const QUALIFICATION_COOLDOWN_MS = 24 * 3600_000;
// Below this many missing fields, ARIA asks conversationally rather than sending the form.
const QUALIFICATION_FORM_THRESHOLD = 3;

// Guardrail after generation, rather than trusting the prompt alone: don't leak internal
// instructions and keep the message a normal WhatsApp length.
//
// Returns null when the output cannot be used. There is deliberately no canned filler to
// fall back on — a substitute sentence would be customer-facing copy hardcoded here, and
// the honest response to an unusable reply is to fetch a human, not to say something bland.
function validateResponse(text: string, maxLength: number): string | null {
  // Reasoning models emit their chain of thought either in <think> tags or as a plain
  // preamble; both would be shown verbatim to the customer, so strip the tagged form and
  // reject anything still reading as internal deliberation.
  const clean = text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<\/?think>/gi, '').trim();
  const reasoningLeak = /^(here'?s?|okay|let me|first,?)\s+(a |my |the )?(thinking|thought|reasoning)|^(analysis|reasoning|thought process)\s*:|^\d+\.\s+\*\*/i;
  const promptLeak = /system prompt|as an ai language model|i am an ai|my instructions (are|were)/i;
  if (!clean || reasoningLeak.test(clean) || promptLeak.test(clean)) return null;
  return clean.length > maxLength ? `${clean.slice(0, maxLength - 1).trim()}…` : clean;
}

// Reasons ARIA must stop and fetch a person. Low confidence is checked separately, after
// generation, because it is a property of the reply rather than of the conversation.
function escalationTrigger(analysis: ConversationAnalysis, config: Awaited<ReturnType<typeof getActiveAIConfig>>, leadScore: number, aiMessageCount: number): string | null {
  const rules = config.escalationRules ?? ({} as NonNullable<typeof config.escalationRules>);
  if (rules.onHumanRequest !== false && analysis.wantsHuman) return 'Customer asked for a human agent';
  if (rules.onSeriousComplaint !== false && analysis.intent === 'COMPLAINT' && analysis.sentiment === 'negative') return 'Customer reported a serious problem';
  if (rules.onNegativeSentiment !== false && analysis.sentiment === 'negative' && analysis.sentimentConfidence >= 0.7) return 'Customer sentiment turned negative';
  if (rules.onComplexPricing !== false && analysis.intent === 'NEGOTIATION') return 'Complex pricing negotiation in progress';
  if (rules.onVipLead !== false && leadScore >= (rules.vipLeadScoreThreshold ?? 80)) return 'High-value / VIP lead detected';
  if (aiMessageCount >= (config.maxAiMessagesBeforeEscalation ?? 20)) return 'Reached maximum AI messages for this conversation';
  return null;
}

/**
 * Hands the conversation to a person.
 *
 * The customer-facing handoff template only goes out when they actually asked for a human
 * — an unprompted "I'm transferring you to our team" would only confuse someone who never
 * asked. Every other escalation reason (negative sentiment, VIP, model outage) is internal.
 */
async function escalateToHuman(conv: any, lead: any, reason: string, customerAsked = false, occurrenceKey?: string) {
  if (customerAsked) {
    await dispatchTrigger('human_agent_requested', { conversation: conv, lead, data: { reason }, occurrenceKey });
  }
  await stopFollowUps(conv._id, `escalated: ${reason}`);
  // Belt and braces: even if an admin deactivated the handoff automation, ARIA must not
  // keep answering a conversation that has been escalated.
  await WhatsAppConversation.updateOne({ _id: conv._id }, { controlStatus: 'WAITING_HUMAN', mode: 'human', aiEnabled: false, automationPaused: true, status: 'human_handoff' });
  const recipients = lead?.salesperson ? [lead.salesperson] : await adminAndManagerIds();
  await notifyUsers(recipients, 'human_handoff', 'WhatsApp conversation needs a human', `${lead?.contactName || conv.phoneNumber}: ${reason}`, '/whatsapp');
  emitToConversation(String(conv._id), 'conversation:updated', { conversation: { ...conv.toObject(), controlStatus: 'WAITING_HUMAN', mode: 'human', aiEnabled: false } });
}

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

  // Every automation fired for this message shares its id as the idempotency key, so a
  // retried webhook delivery can never produce a second copy of the same automated reply.
  const occurrenceKey = input.whatsappMessageId;

  // Spec §7: any reply from the lead cancels every pending follow-up attempt.
  await stopFollowUps(conv._id, 'lead replied');

  // A control button the customer tapped ("Talk to a human" / "Back to AI") switches the
  // mode directly — it must be handled before any AI reply, and short-circuits the rest.
  if (input.interactiveId === WA_ACTION.HUMAN) {
    await dispatchTrigger('human_agent_requested', { conversation: conv, lead, occurrenceKey });
    const recipients = lead.salesperson ? [lead.salesperson] : await adminAndManagerIds();
    await notifyUsers(recipients, 'human_handoff', 'Customer asked for a human', `${lead.contactName || conv.phoneNumber} tapped “talk to a human” in WhatsApp`, '/whatsapp');
    return;
  }
  if (input.interactiveId === WA_ACTION.AI) {
    await dispatchTrigger('ai_resumed', { conversation: conv, lead, occurrenceKey });
    return;
  }

  // A bare digit only means something in the context of the template that asked for it.
  const numeric = await matchNumericReply(conv._id, input.text);
  if (numeric?.kind === 'feedback') {
    await recordFeedback(lead._id, numeric.rating);
    return;
  }
  if (numeric?.kind === 'follow_up') {
    if (numeric.choice === 'human_handoff') { await dispatchTrigger('human_agent_requested', { conversation: conv, lead, occurrenceKey }); return; }
    if (numeric.choice === 'not_interested') { await dispatchTrigger('lead_not_interested', { conversation: conv, lead, occurrenceKey }); return; }
    if (numeric.choice === 'follow_up_later') {
      await createFollowUpActivity({ leadId: lead._id, assignedTo: lead.salesperson, kind: 'Follow-up', summary: `${lead.contactName || conv.phoneNumber} asked to be contacted later`, dueInHours: 72 });
      return;
    }
    // "1 — Yes, I'm interested" falls through to the normal AI handling below.
  }

  const withinHours = isWithinBusinessHours(config);
  const aiShouldReply = Boolean(input.text) && config.globalAiEnabled && conv.aiEnabled && conv.mode === 'ai' && conv.controlStatus === 'AI_ACTIVE';

  // The lead was auto-greeted by Meta template and has now replied, which opens WhatsApp's
  // 24-hour window — the only point at which we may send the service list with links.
  if (conv.greetedAt && !conv.serviceListSentAt) {
    await sendServiceCatalogue(conv).catch(error => console.error('[whatsapp pipeline] service catalogue failed', error));
  }

  // First contact gets the welcome template, which carries the AI-vs-human choice as
  // buttons rather than making the customer phrase it.
  if (isNewConversation && aiShouldReply && withinHours) {
    await dispatchTrigger('new_whatsapp_lead', { conversation: conv, lead, intent: 'greeting', occurrenceKey });
  }

  if (aiShouldReply && !withinHours) {
    await dispatchTrigger('outside_business_hours', { conversation: conv, lead, occurrenceKey });
    return;
  }

  if (!input.text) return;

  if (!aiShouldReply) {
    // Human is handling this conversation — still analyze so the CRM sidebar stays current,
    // but never auto-reply.
    const history = await recentHistory(conv._id, 20);
    await runAnalysis(conv, lead, buildTranscript(history), history.length, config);
    return;
  }

  const history = (await recentHistory(conv._id, 20)).filter(m => String(m._id) !== String(inbound._id));
  const chatHistory = history.filter(m => m.text).map(m => ({ role: m.direction === 'INBOUND' ? ('user' as const) : ('assistant' as const), content: m.text! }));
  const transcriptMessages = [...history, inbound];

  // Intent first (spec §3): what ARIA does next depends on what the customer wants, so the
  // analysis runs before any reply is composed.
  const analysis = await runAnalysis(conv, lead, buildTranscript(transcriptMessages), transcriptMessages.length, config);
  if (!analysis) {
    // Model unreachable (rate limit, timeout, bad credentials). Never leave the customer on
    // silent read: hand the conversation to a human instead of guessing a reply.
    await escalateToHuman(conv, lead, 'The AI model could not be reached, so this conversation needs a human reply');
    return;
  }

  const freshLead = await Lead.findById(lead._id) ?? lead;
  const reason = escalationTrigger(analysis, config, freshLead.leadScore ?? 0, conv.aiMessageCount ?? 0);
  if (reason) { await escalateToHuman(conv, freshLead, reason, analysis.wantsHuman, occurrenceKey); return; }

  // The automation matching the detected intent answers instead of the model whenever one
  // is configured, active and hasn't just fired.
  const intent = detectAriaIntent(analysis, input.text);
  if (await runIntentAutomation(conv, freshLead, intent, occurrenceKey)) return;
  if (await runQualificationAutomation(conv, freshLead, intent, occurrenceKey)) return;

  let safeText: string | null;
  let confidence = 0;
  try {
    const generated = await generateAgentReply({ message: input.text, history: chatHistory, language: conv.language });
    safeText = validateResponse(generated.text, config.maxResponseLength ?? 650);
    confidence = generated.confidence;
  } catch (error) {
    console.error('[whatsapp pipeline] AI reply generation failed', error);
    await escalateToHuman(conv, freshLead, 'The AI model could not be reached, so this conversation needs a human reply');
    return;
  }

  if (!safeText) {
    await escalateToHuman(conv, freshLead, 'The AI reply could not be used safely, so this conversation needs a human reply', false, occurrenceKey);
    return;
  }

  // A reply the model itself is unsure of is never sent — the conversation goes to a person.
  const rules = config.escalationRules;
  if (rules?.onLowConfidence !== false && confidence < (rules?.lowConfidenceThreshold ?? 0.45)) {
    await escalateToHuman(conv, freshLead, 'AI confidence too low to continue safely');
    return;
  }

  const sendResult = await sendTextMessage(conv.phoneNumber, safeText);
  await appendMessage({ conversation: conv, direction: 'OUTBOUND', text: safeText, aiGenerated: true, status: sendResult.ok ? 'SENT' : 'FAILED', whatsappMessageId: sendResult.whatsappMessageId });
  if (!sendResult.ok) await escalateToHuman(conv, freshLead, `The reply could not be delivered to WhatsApp (${sendResult.error ?? 'unknown error'})`);
}

/** Fires the automation for a detected intent. Returns true when it actually replied. */
async function runIntentAutomation(conv: any, lead: any, intent: string, occurrenceKey?: string): Promise<boolean> {
  const trigger = INTENT_TRIGGER[intent as keyof typeof INTENT_TRIGGER];
  if (!trigger) return false;
  if (trigger === 'lead_not_interested') {
    await dispatchTrigger(trigger, { conversation: conv, lead, intent, occurrenceKey });
    return true;
  }
  if (trigger === 'human_agent_requested') {
    await dispatchTrigger(trigger, { conversation: conv, lead, intent, occurrenceKey });
    return true;
  }
  // Templates keyed to a trigger stay quiet for a while after firing, so a customer asking
  // three pricing questions in a row gets one card and then real answers.
  const { AutomationTemplate } = await import('../models/index.js');
  const template = await AutomationTemplate.findOne({ trigger, status: 'active' }).select('templateKey').lean();
  if (!template) return false;
  if (await sentTemplateRecently(conv._id, template.templateKey, INTENT_TEMPLATE_COOLDOWN_MS)) return false;

  const result = await dispatchTrigger(trigger, { conversation: conv, lead, intent, occurrenceKey });
  return result.delivered > 0;
}

/**
 * Asks for missing qualification details — but only when enough of them are missing to be
 * worth a structured ask, and not if ARIA already asked today. Spec §4: never re-ask for
 * something the CRM already knows.
 */
async function runQualificationAutomation(conv: any, lead: any, intent: string, occurrenceKey?: string): Promise<boolean> {
  if (!['product_enquiry', 'pricing', 'purchase_interest', 'quotation'].includes(intent)) return false;
  const missing = missingQualificationFields(lead);
  if (missing.length < QUALIFICATION_FORM_THRESHOLD) return false;
  if (await sentTemplateRecently(conv._id, 'lead_qualification', QUALIFICATION_COOLDOWN_MS)) return false;
  const result = await dispatchTrigger('lead_requires_qualification', { conversation: conv, lead, intent, data: { missing_fields: missing.join(', ') }, occurrenceKey });
  return result.delivered > 0;
}

/**
 * Analyzes the conversation and folds the result into the CRM: lead facts, score,
 * temperature, stage, summary trail, and the automations those changes should raise.
 * Returns null when the model could not be reached.
 */
async function runAnalysis(
  conv: any, lead: any, transcript: string, messageCount: number,
  config: Awaited<ReturnType<typeof getActiveAIConfig>>,
): Promise<ConversationAnalysis | null> {
  let analysis: ConversationAnalysis;
  try {
    analysis = await analyzeConversation(transcript);
  } catch (error) {
    console.error('[whatsapp pipeline] conversation analysis failed', error);
    return null;
  }

  conv.sentiment = analysis.sentiment;
  conv.sentimentConfidence = analysis.sentimentConfidence;
  conv.detectedIntent = analysis.intent;
  if (analysis.language) conv.language = analysis.language;
  await conv.save();

  const { lead: updatedLead, becameHot } = await applyAnalysisToLead(lead._id, analysis, messageCount);

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

  // Internal hot-lead alert, on the crossing only — a lead that stays hot is not re-announced.
  if (becameHot) await dispatchTrigger('lead_score_threshold_reached', { conversation: conv, lead: updatedLead });

  if (analysis.wantsMeeting) {
    await createFollowUpActivity({ leadId: lead._id, assignedTo: updatedLead.salesperson, kind: 'Meeting', summary: `Schedule meeting with ${updatedLead.contactName || conv.phoneNumber}` });
    if (updatedLead.salesperson) await notifyUsers([updatedLead.salesperson], 'meeting_requested', 'Meeting requested', `${updatedLead.contactName || conv.phoneNumber} asked for a meeting`, '/whatsapp');
  }
  if (analysis.intent === 'CALLBACK_REQUEST') await createFollowUpActivity({ leadId: lead._id, assignedTo: updatedLead.salesperson, kind: 'Callback', summary: `Call back ${updatedLead.contactName || conv.phoneNumber}` });
  if (analysis.wantsDemo) await createFollowUpActivity({ leadId: lead._id, assignedTo: updatedLead.salesperson, kind: 'Demo', summary: `Prepare demo for ${updatedLead.contactName || conv.phoneNumber}` });
  if (analysis.wantsPricing && updatedLead.salesperson) await notifyUsers([updatedLead.salesperson], 'pricing_request', 'Pricing requested', `${updatedLead.contactName || conv.phoneNumber} asked about pricing`, '/whatsapp');
  if (analysis.intent === 'COMPLAINT' && updatedLead.salesperson) await notifyUsers([updatedLead.salesperson], 'complaint', 'Customer complaint', `${updatedLead.contactName || conv.phoneNumber} reported a problem`, '/whatsapp');
  if (updatedLead.qualificationStatus === 'won' && updatedLead.salesperson) await notifyUsers([updatedLead.salesperson], 'purchase_confirmed', 'Purchase confirmed', `${updatedLead.contactName || conv.phoneNumber} confirmed a purchase`, '/whatsapp');

  emitToConversation(String(conv._id), 'conversation:updated', {
    conversation: conv.toObject(),
    lead: { _id: updatedLead._id, leadScore: updatedLead.leadScore, leadTemperature: updatedLead.leadTemperature, qualificationStatus: updatedLead.qualificationStatus },
  });
  return analysis;
}
