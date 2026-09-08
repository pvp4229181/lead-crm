import type { AIProvider } from './provider.js';
import { MockProvider } from './providers/mock.provider.js';

export * from './provider.js';

let cached: { key: string; provider: AIProvider } | null = null;

// AI_PROVIDER selects the vendor (anthropic | openai | openrouter | mock); AI_API_KEY
// authenticates it; AI_MODEL optionally overrides the default model id. Falls back to
// the mock provider (rather than throwing) whenever no key is configured, so the rest
// of the pipeline stays runnable before credentials exist.
export async function getAIProvider(preferred?: string, preferredModel?: string): Promise<AIProvider> {
  const name = (preferred ?? process.env.AI_PROVIDER ?? 'mock').toLowerCase();
  const apiKey = process.env.AI_API_KEY;
  // The admin-configured model (Settings → WhatsApp → AI Agent) wins over AI_MODEL.
  const model = preferredModel || process.env.AI_MODEL || undefined;
  const cacheKey = `${name}:${apiKey ?? ''}:${model ?? ''}:${process.env.AI_FALLBACK_MODELS ?? ''}`;
  if (cached?.key === cacheKey) return cached.provider;

  let provider: AIProvider;
  if (name === 'anthropic' && apiKey) {
    const { AnthropicProvider } = await import('./providers/anthropic.provider.js');
    provider = new AnthropicProvider(apiKey, model);
  } else if (name === 'openai' && apiKey) {
    const { OpenAIProvider } = await import('./providers/openai.provider.js');
    provider = new OpenAIProvider(apiKey, model);
  } else if (name === 'openrouter' && apiKey) {
    // OpenRouter (https://openrouter.ai) is an OpenAI-compatible gateway to many models
    // (e.g. "openai/gpt-4o-mini", "anthropic/claude-sonnet-5", "meta-llama/llama-3.3-70b-instruct").
    // Referer/title headers are OpenRouter's own convention for attributing usage on their dashboard.
    const { OpenAIProvider } = await import('./providers/openai.provider.js');
    const referer = process.env.APP_URL || process.env.CLIENT_URL || 'http://localhost:5173';
    provider = new OpenAIProvider(apiKey, model || 'openai/gpt-4o-mini', {
      baseURL: 'https://openrouter.ai/api/v1', name: 'openrouter',
      defaultHeaders: { 'HTTP-Referer': referer, 'X-Title': 'Lead CRM WhatsApp AI Agent' },
      // Comma-separated AI_FALLBACK_MODELS, tried in order when the primary is rate-limited.
      fallbackModels: (process.env.AI_FALLBACK_MODELS ?? '').split(',').map(m => m.trim()).filter(Boolean),
    });
  } else {
    provider = new MockProvider();
  }
  cached = { key: cacheKey, provider };
  return provider;
}
