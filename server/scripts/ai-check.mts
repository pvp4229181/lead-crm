// Verifies the configured AI provider actually answers, using the real credentials
// from server/.env — both the sales reply and the structured JSON analysis path.
import 'dotenv/config';
import { getAIProvider } from '../dist/ai/index.js';

const provider = await getAIProvider(process.env.AI_PROVIDER, process.env.AI_MODEL);
console.log(`provider = ${provider.name}, model = ${process.env.AI_MODEL}`);

const reply = await provider.generateReply({
  systemPrompt: 'You are Aria, a friendly sales assistant at Orbit. Only use the knowledge below. Knowledge: Business Website starts at ₹25,000. Reply in 1-2 short sentences.',
  history: [],
  message: 'Hi, I want a website for my real estate business',
  temperature: 0.4,
  maxOutputTokens: 300,
});
console.log('\n--- generateReply ---');
console.log(reply.text);
console.log(`confidence: ${reply.confidence}`);

const analysis = await provider.analyzeConversation({
  transcript: 'Customer: Hi, I want a website for my real estate company\nAgent: Happy to help! What kind of site?\nCustomer: A property listing portal with enquiry management. Budget around 1.5 lakh, want to launch in 2 months. Can we do a demo next Tuesday?',
});
console.log('\n--- analyzeConversation ---');
console.log(JSON.stringify({
  intent: analysis.intent, sentiment: analysis.sentiment, language: analysis.language,
  budget: analysis.budget, timeline: analysis.purchaseTimeline,
  requirements: analysis.requirements, productInterest: analysis.productInterest,
  wantsDemo: analysis.wantsDemo, wantsMeeting: analysis.wantsMeeting,
  salesProbability: analysis.salesProbability, summary: analysis.summary,
}, null, 2));
