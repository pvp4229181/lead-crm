export type ScoreInputs = {
  messageCount: number;
  hasName: boolean;
  hasCompany: boolean;
  hasBudget: boolean;
  hasTimeline: boolean;
  requestedPricing: boolean;
  requestedDemo: boolean;
  requestedMeeting: boolean;
  buyingIntent: boolean;
};

export type LeadTemperature = 'Cold' | 'Warm' | 'Hot' | 'Very Hot';

export function calculateLeadScore(input: ScoreInputs): number {
  let score = 0;
  if (input.messageCount > 0) score += 10; // customer responds
  if (input.hasName) score += 10;
  if (input.hasCompany) score += 10;
  if (input.hasBudget) score += 10;
  if (input.hasTimeline) score += 10;
  if (input.requestedPricing) score += 10;
  if (input.requestedDemo) score += 15;
  if (input.requestedMeeting) score += 15;
  if (input.buyingIntent) score += 20;
  // Sustained engagement is itself a signal, independent of the discrete events above.
  score += Math.min(10, Math.max(0, input.messageCount - 1) * 2);
  return Math.min(100, score);
}

export function classifyTemperature(score: number): LeadTemperature {
  if (score >= 81) return 'Very Hot';
  if (score >= 61) return 'Hot';
  if (score >= 31) return 'Warm';
  return 'Cold';
}
