import OpenAI from 'openai';
import type { AIProvider, AnalysisInput, ConversationAnalysis, GenerateReplyInput, GenerateReplyResult } from '../provider.js';
import { ANALYSIS_INSTRUCTIONS } from '../prompts.js';
import { extractJson, parseAnalysis } from '../json.js';

// Also used for OpenRouter (openrouter.ai), which serves an OpenAI-compatible API —
// only the base URL, default model, and a couple of routing headers differ. See
// ai/index.ts for how AI_PROVIDER=openrouter constructs this with those overrides.
export class OpenAIProvider implements AIProvider {
  readonly name: string;
  private client: OpenAI;
  private model: string;
  private fallbackModels: string[];

  constructor(apiKey: string, model = 'gpt-4o-mini', options?: { baseURL?: string; name?: string; defaultHeaders?: Record<string, string>; fallbackModels?: string[] }) {
    this.client = new OpenAI({ apiKey, baseURL: options?.baseURL, defaultHeaders: options?.defaultHeaders });
    this.model = model;
    this.name = options?.name ?? 'openai';
    this.fallbackModels = options?.fallbackModels ?? [];
  }

  // OpenRouter accepts a `models` array and transparently falls through the list when a
  // model is rate-limited or unavailable — important on free tiers, whose shared pools
  // return 429 often. Plain OpenAI ignores the extra field, so it is safe to always send
  // when configured. Nothing is added by default: routing to a paid model must be a
  // deliberate choice, never a silent cost.
  private routing() {
    return this.fallbackModels.length ? { models: [this.model, ...this.fallbackModels] } : {};
  }

  async generateReply(input: GenerateReplyInput): Promise<GenerateReplyResult> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      temperature: input.temperature,
      max_tokens: Math.min(1024, Math.max(64, Math.round(input.maxOutputTokens))),
      messages: [
        { role: 'system', content: input.systemPrompt },
        ...input.history.map(turn => ({ role: turn.role, content: turn.content }) as const),
        { role: 'user', content: input.message },
      ],
      ...this.routing(),
    } as Parameters<typeof this.client.chat.completions.create>[0]);
    const completion = response as OpenAI.Chat.Completions.ChatCompletion;
    const text = completion.choices[0]?.message?.content?.trim() ?? '';
    return { text: text || "Sorry, could you say that again?", confidence: completion.choices[0]?.finish_reason === 'stop' ? 0.8 : 0.55 };
  }

  async analyzeConversation(input: AnalysisInput): Promise<ConversationAnalysis> {
    const response = await this.client.chat.completions.create({
      model: this.model, temperature: 0,
      messages: [{ role: 'system', content: ANALYSIS_INSTRUCTIONS }, { role: 'user', content: input.transcript }],
      ...this.routing(),
    } as Parameters<typeof this.client.chat.completions.create>[0]);
    const completion = response as OpenAI.Chat.Completions.ChatCompletion;
    const text = completion.choices[0]?.message?.content ?? '';
    return parseAnalysis(extractJson(text));
  }
}
