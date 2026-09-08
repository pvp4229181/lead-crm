// Provider-agnostic interface the rest of the app codes against. Swapping the LLM
// vendor means adding a file under ai/providers and registering it in ai/index.ts —
// nothing in services/ or webhooks/ needs to change.

export type ChatRole = 'user' | 'assistant';
export type ChatTurn = { role: ChatRole; content: string };

export type GenerateReplyInput = {
  systemPrompt: string;
  history: ChatTurn[];
  message: string;
  temperature: number;
  maxOutputTokens: number;
};

export type GenerateReplyResult = { text: string; confidence: number };

export type AnalysisInput = {
  transcript: string; // formatted "Customer: ...\nAgent: ..." conversation so far
};

export type IntentLabel =
  | 'GENERAL_INQUIRY' | 'PRODUCT_INQUIRY' | 'PRICING_REQUEST' | 'DEMO_REQUEST' | 'MEETING_REQUEST'
  | 'CALLBACK_REQUEST' | 'PURCHASE_INTENT' | 'NEGOTIATION' | 'SUPPORT_REQUEST' | 'COMPLAINT'
  | 'HUMAN_REQUEST' | 'NOT_INTERESTED' | 'OTHER';

export type SentimentLabel = 'positive' | 'neutral' | 'negative';

export type ConversationAnalysis = {
  intent: IntentLabel;
  sentiment: SentimentLabel;
  sentimentConfidence: number;
  language: 'en' | 'hi' | 'hinglish';
  customerName?: string;
  companyName?: string;
  email?: string;
  location?: string;
  budget?: string;
  purchaseTimeline?: string;
  quantity?: string;
  requirements: string[];
  productInterest: string[];
  painPoints: string[];
  objections: string[];
  buyingIntent: boolean;
  wantsMeeting: boolean;
  wantsDemo: boolean;
  wantsPricing: boolean;
  wantsHuman: boolean;
  summary: string;
  recommendedNextAction: string;
  salesProbability: number;
};

export interface AIProvider {
  readonly name: string;
  generateReply(input: GenerateReplyInput): Promise<GenerateReplyResult>;
  analyzeConversation(input: AnalysisInput): Promise<ConversationAnalysis>;
}

export const emptyAnalysis = (): ConversationAnalysis => ({
  intent: 'GENERAL_INQUIRY', sentiment: 'neutral', sentimentConfidence: 0.5, language: 'en',
  requirements: [], productInterest: [], painPoints: [], objections: [],
  buyingIntent: false, wantsMeeting: false, wantsDemo: false, wantsPricing: false, wantsHuman: false,
  summary: '', recommendedNextAction: '', salesProbability: 10,
});
