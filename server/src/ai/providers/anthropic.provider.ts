import Anthropic from '@anthropic-ai/sdk';
import type { AIProvider, AnalysisInput, ConversationAnalysis, GenerateReplyInput, GenerateReplyResult } from '../provider.js';
import { ANALYSIS_INSTRUCTIONS } from '../prompts.js';
import { extractJson, parseAnalysis } from '../json.js';

export class AnthropicProvider implements AIProvider {
  readonly name = 'anthropic';
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model = 'claude-sonnet-5') {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async generateReply(input: GenerateReplyInput): Promise<GenerateReplyResult> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: Math.min(1024, Math.max(64, Math.round(input.maxOutputTokens))),
      temperature: input.temperature,
      system: input.systemPrompt,
      messages: [...input.history.map(turn => ({ role: turn.role, content: turn.content })), { role: 'user' as const, content: input.message }],
    });
    const text = response.content.filter(block => block.type === 'text').map(block => (block as { text: string }).text).join('\n').trim();
    return { text: text || "Sorry, could you say that again?", confidence: response.stop_reason === 'end_turn' ? 0.8 : 0.55 };
  }

  async analyzeConversation(input: AnalysisInput): Promise<ConversationAnalysis> {
    const response = await this.client.messages.create({
      model: this.model, max_tokens: 1024, temperature: 0,
      system: ANALYSIS_INSTRUCTIONS,
      messages: [{ role: 'user', content: input.transcript }],
    });
    const text = response.content.filter(block => block.type === 'text').map(block => (block as { text: string }).text).join('\n');
    return parseAnalysis(extractJson(text));
  }
}
