// Maps what the model reported onto ARIA's own intent vocabulary, and routes the numeric
// replies the follow-up and feedback templates ask for ("Reply 1-4", "rate 1 to 5").
import { AutomationTemplate, Lead, TimelineEvent, WhatsAppMessage } from '../models/index.js';
import type { ConversationAnalysis } from '../ai/provider.js';
import { ensureSystemUser } from '../utils/systemUser.js';
import type { AriaIntent } from '../automation/trigger.service.js';

const ANALYSIS_TO_ARIA: Record<ConversationAnalysis['intent'], AriaIntent> = {
  GENERAL_INQUIRY: 'unknown',
  PRODUCT_INQUIRY: 'product_enquiry',
  PRICING_REQUEST: 'pricing',
  DEMO_REQUEST: 'demo_request',
  MEETING_REQUEST: 'appointment_request',
  CALLBACK_REQUEST: 'appointment_request',
  PURCHASE_INTENT: 'purchase_interest',
  NEGOTIATION: 'purchase_interest',
  SUPPORT_REQUEST: 'support',
  COMPLAINT: 'complaint',
  HUMAN_REQUEST: 'human_agent',
  NOT_INTERESTED: 'not_interested',
  OTHER: 'unknown',
};

const GREETING = /^\s*(hi|hii+|hey|hello|helo|namaste|namaskar|salaam|good (morning|afternoon|evening))[\s!.,]*$/i;

/** The ARIA intent for a conversation turn. `message` only refines the neutral cases. */
export function detectAriaIntent(analysis: ConversationAnalysis, message?: string): AriaIntent {
  const mapped = ANALYSIS_TO_ARIA[analysis.intent] ?? 'unknown';
  if (mapped === 'unknown' && message && GREETING.test(message)) return 'greeting';
  if (mapped === 'unknown' && analysis.wantsPricing) return 'pricing';
  if (mapped === 'unknown' && analysis.productInterest.length) return 'product_enquiry';
  return mapped;
}

/** The most recent template ARIA sent on this conversation, used to interpret a bare number. */
async function lastAutomationTemplateKey(conversationId: unknown): Promise<string | null> {
  const message = await WhatsAppMessage.findOne({
    conversation: conversationId, direction: 'OUTBOUND', automationTemplate: { $exists: true, $ne: null },
  }).sort({ timestamp: -1 }).select('automationTemplate').lean();
  if (!message?.automationTemplate) return null;
  const template = await AutomationTemplate.findById(message.automationTemplate).select('templateKey').lean();
  return template?.templateKey ?? null;
}

export type NumericReply =
  | { kind: 'follow_up'; choice: 'interested' | 'follow_up_later' | 'human_handoff' | 'not_interested' }
  | { kind: 'feedback'; rating: number }
  | null;

const FOLLOW_UP_CHOICES = ['interested', 'follow_up_later', 'human_handoff', 'not_interested'] as const;

/**
 * Interprets a reply that is nothing but a digit, in the context of the template that
 * asked for it. Anything else (or a digit with no matching preceding template) returns
 * null and is handled as an ordinary message by the AI.
 */
export async function matchNumericReply(conversationId: unknown, text?: string): Promise<NumericReply> {
  const digit = /^\s*([1-5])\s*[.)]?\s*$/.exec(text ?? '');
  if (!digit) return null;
  const value = Number(digit[1]);
  const key = await lastAutomationTemplateKey(conversationId);
  if (key === 'no_response_follow_up' && value >= 1 && value <= 4) return { kind: 'follow_up', choice: FOLLOW_UP_CHOICES[value - 1]! };
  if (key === 'customer_feedback') return { kind: 'feedback', rating: value };
  return null;
}

const RATING_LABELS = ['Poor', 'Fair', 'Good', 'Very Good', 'Excellent'];

/** Stores a customer's 1-5 rating on the lead's timeline and notes so the CRM keeps it. */
export async function recordFeedback(leadId: unknown, rating: number, comment?: string) {
  const systemUserId = await ensureSystemUser();
  const label = RATING_LABELS[rating - 1] ?? String(rating);
  await TimelineEvent.create({
    createdBy: systemUserId, relatedModel: 'Lead', relatedId: leadId,
    eventType: 'feedback_received', message: `Customer rated their experience ${rating}/5 (${label})${comment ? ` — ${comment}` : ''}`,
    metadata: { rating, label, comment },
  });
  await Lead.updateOne({ _id: leadId }, { $set: { recommendedNextAction: `Customer feedback: ${rating}/5 (${label})` } });
}
