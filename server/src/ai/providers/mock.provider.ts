import type { AIProvider, AnalysisInput, ConversationAnalysis, GenerateReplyInput, GenerateReplyResult } from '../provider.js';
import { emptyAnalysis } from '../provider.js';

// Default provider when no AI_API_KEY is configured. Keeps the whole pipeline
// (webhook → save → reply → save → lead update) exercisable end-to-end without
// live credentials, using deterministic heuristics instead of a real model.
export class MockProvider implements AIProvider {
  readonly name = 'mock';

  async generateReply(input: GenerateReplyInput): Promise<GenerateReplyResult> {
    const msg = input.message.toLowerCase();
    let text = "Thanks for your message! Could you tell me a bit more about what you're looking for?";
    if (/price|cost|kitna|budget/.test(msg)) text = "Happy to help with pricing — it depends a little on your exact requirements. Could you share what you need so I can point you to the right option?";
    else if (/demo|trial/.test(msg)) text = "Sure, I can set up a demo for you. What day and time works best?";
    else if (/hi|hello|hey|namaste/.test(msg) && input.history.length === 0) text = "Hi there! Thanks for reaching out — how can I help you today?";
    else if (/human|agent|representative|talk to (someone|person)/.test(msg)) text = "Of course — I'll connect you with a member of our team right away.";
    return { text: text.slice(0, input.maxOutputTokens * 4), confidence: 0.55 };
  }

  async analyzeConversation(input: AnalysisInput): Promise<ConversationAnalysis> {
    const t = input.transcript.toLowerCase();
    const base = emptyAnalysis();
    const wantsPricing = /price|cost|budget|quote|kitna|rate/.test(t);
    const wantsDemo = /demo|trial|walkthrough/.test(t);
    const wantsMeeting = /\bmeet\b|meeting|schedule|book a|appointment|call me|catch up/.test(t);
    const wantsHuman = /human|real person|representative|talk to someone|talk to (a|your) team|speak to someone/.test(t);
    const buyingIntent = /\bbuy\b|purchase|order|confirm|proceed|go ahead|let'?s do it/.test(t);
    const negative = /angry|frustrat|worst|bad experience|not happy|refund|complaint/.test(t);
    // Rough entity extraction so the offline provider still drives qualification/stage
    // movement — a real model does this far better, this just keeps the flow exercisable.
    const budget = /(?:₹|rs\.?|inr)?\s?([\d.,]+)\s?(lakh|lakhs|crore|k\b|thousand)/i.exec(input.transcript)?.[0]?.trim();
    const timeline = /(?:within|in|by|next)\s+(?:a\s+)?(\d+\s+)?(day|days|week|weeks|month|months|tuesday|monday|wednesday|thursday|friday|quarter)/i.exec(input.transcript)?.[0]?.trim();
    let intent: ConversationAnalysis['intent'] = 'GENERAL_INQUIRY';
    if (wantsHuman) intent = 'HUMAN_REQUEST';
    else if (buyingIntent) intent = 'PURCHASE_INTENT';
    else if (wantsMeeting) intent = 'MEETING_REQUEST';
    else if (wantsDemo) intent = 'DEMO_REQUEST';
    else if (wantsPricing) intent = 'PRICING_REQUEST';
    else if (negative) intent = 'COMPLAINT';
    return {
      ...base, intent, wantsPricing, wantsDemo, wantsMeeting, wantsHuman, buyingIntent,
      budget, purchaseTimeline: timeline,
      requirements: wantsPricing || wantsDemo ? ['Stated interest during WhatsApp conversation'] : [],
      sentiment: negative ? 'negative' : buyingIntent ? 'positive' : 'neutral',
      sentimentConfidence: 0.5,
      summary: input.transcript.slice(-400),
      recommendedNextAction: wantsHuman ? 'Hand off to a salesperson' : wantsMeeting ? 'Confirm a meeting slot' : 'Continue qualifying the lead',
      salesProbability: buyingIntent ? 65 : wantsPricing ? 40 : 15,
    };
  }
}
