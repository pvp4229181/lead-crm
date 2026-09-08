import { type ConversationAnalysis, emptyAnalysis } from './provider.js';

// LLMs sometimes wrap JSON in prose or a ```json fence despite instructions.
// Pull out the first {...} block rather than trusting response.trim() === json.
export function extractJson(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try { return JSON.parse(candidate.slice(start, end + 1)); } catch { return null; }
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : []);
const bool = (v: unknown) => v === true;
const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

const INTENTS = new Set(['GENERAL_INQUIRY', 'PRODUCT_INQUIRY', 'PRICING_REQUEST', 'DEMO_REQUEST', 'MEETING_REQUEST', 'CALLBACK_REQUEST', 'PURCHASE_INTENT', 'NEGOTIATION', 'SUPPORT_REQUEST', 'COMPLAINT', 'HUMAN_REQUEST', 'NOT_INTERESTED', 'OTHER']);

export function parseAnalysis(raw: Record<string, unknown> | null): ConversationAnalysis {
  const base = emptyAnalysis();
  if (!raw) return base;
  return {
    intent: typeof raw.intent === 'string' && INTENTS.has(raw.intent) ? (raw.intent as ConversationAnalysis['intent']) : base.intent,
    sentiment: raw.sentiment === 'positive' || raw.sentiment === 'negative' ? raw.sentiment : 'neutral',
    sentimentConfidence: Math.min(1, Math.max(0, num(raw.sentimentConfidence, base.sentimentConfidence))),
    language: raw.language === 'hi' || raw.language === 'hinglish' ? raw.language : 'en',
    customerName: str(raw.customerName), companyName: str(raw.companyName), email: str(raw.email), location: str(raw.location),
    budget: str(raw.budget), purchaseTimeline: str(raw.purchaseTimeline), quantity: str(raw.quantity),
    requirements: arr(raw.requirements), productInterest: arr(raw.productInterest), painPoints: arr(raw.painPoints), objections: arr(raw.objections),
    buyingIntent: bool(raw.buyingIntent), wantsMeeting: bool(raw.wantsMeeting), wantsDemo: bool(raw.wantsDemo), wantsPricing: bool(raw.wantsPricing), wantsHuman: bool(raw.wantsHuman),
    summary: str(raw.summary) ?? '', recommendedNextAction: str(raw.recommendedNextAction) ?? '',
    salesProbability: Math.min(100, Math.max(0, Math.round(num(raw.salesProbability, base.salesProbability)))),
  };
}
