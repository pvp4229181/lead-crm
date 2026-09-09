// Lead scoring (spec §5). The point values and the band thresholds are stored on the AI
// configuration document, so a CRM admin can retune scoring from WhatsApp Automation →
// AI Settings without a deploy. The defaults below match the specified scheme.

export type ScoreInputs = {
  messageCount: number;
  hasCompany: boolean;
  hasEmail: boolean;
  hasBudget: boolean;
  /** Timeline the customer stated resolves to under 30 days. */
  timelineUnder30Days: boolean;
  requestedPricing: boolean;
  requestedDemo: boolean;
  requestedQuotation: boolean;
  requestedHuman: boolean;
};

export type LeadTemperature = 'Cold' | 'Warm' | 'Qualified' | 'Hot';

export type ScoringRules = {
  requestedPricing: number; requestedDemo: number; requestedQuotation: number;
  providedBudget: number; timelineUnder30Days: number; providedCompany: number;
  providedEmail: number; repeatedEngagement: number; requestedHuman: number;
  warmThreshold: number; qualifiedThreshold: number; hotThreshold: number;
};

export const DEFAULT_SCORING: ScoringRules = {
  requestedPricing: 10, requestedDemo: 20, requestedQuotation: 25,
  providedBudget: 15, timelineUnder30Days: 15, providedCompany: 5,
  providedEmail: 5, repeatedEngagement: 5, requestedHuman: 10,
  warmThreshold: 31, qualifiedThreshold: 61, hotThreshold: 81,
};

export const scoringRules = (config?: { leadScoring?: Partial<ScoringRules> | null }): ScoringRules => ({
  ...DEFAULT_SCORING,
  ...Object.fromEntries(Object.entries(config?.leadScoring ?? {}).filter(([, value]) => typeof value === 'number')),
});

/** "in 2 weeks", "next month", "by Friday" — anything that lands inside 30 days. */
export function isNearTermTimeline(timeline?: string | null): boolean {
  if (!timeline) return false;
  const text = timeline.toLowerCase();
  if (/(asap|immediately|urgent|right away|this week|next week|today|tomorrow)/.test(text)) return true;
  if (/\b(mon|tues|wednes|thurs|fri|satur|sun)day\b/.test(text)) return true;
  const days = /(\d+)\s*(day|days)/.exec(text);
  if (days) return Number(days[1]) <= 30;
  const weeks = /(\d+)\s*(week|weeks)/.exec(text);
  if (weeks) return Number(weeks[1]) <= 4;
  const months = /(\d+)\s*(month|months)/.exec(text);
  if (months) return Number(months[1]) <= 1;
  return /\b(a|one)\s+(week|month)\b/.test(text);
}

/** Additive scoring, capped at 100. Each signal contributes at most once. */
export function calculateLeadScore(input: ScoreInputs, rules: ScoringRules = DEFAULT_SCORING): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  const add = (points: number, label: string) => { if (points) { score += points; reasons.push(`${label} (+${points})`); } };

  if (input.requestedPricing) add(rules.requestedPricing, 'Requested pricing');
  if (input.requestedDemo) add(rules.requestedDemo, 'Requested a demo');
  if (input.requestedQuotation) add(rules.requestedQuotation, 'Requested a quotation');
  if (input.hasBudget) add(rules.providedBudget, 'Provided a budget');
  if (input.timelineUnder30Days) add(rules.timelineUnder30Days, 'Timeline under 30 days');
  if (input.hasCompany) add(rules.providedCompany, 'Provided a company');
  if (input.hasEmail) add(rules.providedEmail, 'Provided an email');
  if (input.messageCount > 2) add(rules.repeatedEngagement, 'Repeated engagement');
  if (input.requestedHuman) add(rules.requestedHuman, 'Asked to speak with the team');

  return { score: Math.min(100, score), reasons };
}

export function classifyTemperature(score: number, rules: ScoringRules = DEFAULT_SCORING): LeadTemperature {
  if (score >= rules.hotThreshold) return 'Hot';
  if (score >= rules.qualifiedThreshold) return 'Qualified';
  if (score >= rules.warmThreshold) return 'Warm';
  return 'Cold';
}

export const isHotTemperature = (temperature?: string | null) => temperature === 'Hot' || temperature === 'Very Hot';
