import { AIConfiguration } from '../models/index.js';
import { getAIProvider, type ChatTurn, type ConversationAnalysis } from '../ai/index.js';
import { buildSystemPrompt } from '../ai/prompts.js';
import { RECOMMENDED_AGENT_TEMPLATE, RECOMMENDED_AGENT_TEMPLATE_VERSION } from '../ai/agent-template.js';
import { retrieveKnowledge } from './knowledge.service.js';

// The stored configuration is authoritative once it exists (admins edit it in
// Settings → WhatsApp → AI Agent). AI_PROVIDER/AI_MODEL only seed the first document,
// so a fresh deployment picks up the credentials already present in the environment
// instead of silently defaulting to the mock provider.
const envProvider = () => {
  const name = (process.env.AI_PROVIDER ?? '').toLowerCase();
  const supported = ['anthropic', 'openai', 'openrouter', 'mock'];
  return supported.includes(name) && (name === 'mock' || process.env.AI_API_KEY) ? name : 'mock';
};

export async function getActiveAIConfig() {
  const existing = await AIConfiguration.findOne({ active: true }).sort('-createdAt');
  if (existing) {
    if ((existing.agentTemplateVersion ?? 0) < RECOMMENDED_AGENT_TEMPLATE_VERSION) {
      Object.assign(existing, RECOMMENDED_AGENT_TEMPLATE, { agentTemplateVersion: RECOMMENDED_AGENT_TEMPLATE_VERSION });
      existing.customTone = undefined;
      await existing.save();
    }
    return existing;
  }
  return AIConfiguration.create({
    agentName: 'Aria', companyName: 'Our Company', ...RECOMMENDED_AGENT_TEMPLATE,
    agentTemplateVersion: RECOMMENDED_AGENT_TEMPLATE_VERSION,
    provider: envProvider(), aiModel: process.env.AI_MODEL || undefined,
    globalAiEnabled: true, active: true,
  });
}

export async function replaceWithRecommendedAgentTemplate() {
  const config = await getActiveAIConfig();
  Object.assign(config, RECOMMENDED_AGENT_TEMPLATE, { agentTemplateVersion: RECOMMENDED_AGENT_TEMPLATE_VERSION });
  config.customTone = undefined;
  await config.save();
  return config;
}

export function isWithinBusinessHours(config: Awaited<ReturnType<typeof getActiveAIConfig>>, now = new Date()): boolean {
  const days = config.businessHours?.days ?? [];
  if (!days.length) return true; // no hours configured = always on
  const tz = config.businessHours?.timezone || 'Asia/Kolkata';
  const local = new Date(now.toLocaleString('en-US', { timeZone: tz }));
  const day = days.find(d => d.day === local.getDay() && d.enabled !== false);
  if (!day || !day.start || !day.end) return false;
  const minutes = local.getHours() * 60 + local.getMinutes();
  const [sh, sm] = day.start.split(':').map(Number);
  const [eh, em] = day.end.split(':').map(Number);
  return minutes >= (sh! * 60 + (sm ?? 0)) && minutes <= (eh! * 60 + (em ?? 0));
}

export async function generateAgentReply(params: {
  message: string; history: ChatTurn[]; language: string;
}): Promise<{ text: string; confidence: number; config: Awaited<ReturnType<typeof getActiveAIConfig>> }> {
  const config = await getActiveAIConfig();
  const knowledgeContext = await retrieveKnowledge(params.message);
  const systemPrompt = buildSystemPrompt({
    agentName: config.agentName, agentRole: config.agentRole, companyName: config.companyName,
    companyDescription: config.companyDescription ?? undefined, tone: config.tone, customTone: config.customTone ?? undefined,
    qualificationQuestions: config.qualificationQuestions ?? [], knowledgeContext,
    language: params.language !== 'en' ? params.language : config.language,
  });
  const provider = await getAIProvider(config.provider, config.aiModel ?? undefined);
  const result = await provider.generateReply({
    systemPrompt, history: params.history, message: params.message,
    temperature: config.creativity ?? 0.4, maxOutputTokens: config.maxResponseLength ?? 700,
  });
  return { ...result, config };
}

export async function analyzeConversation(transcript: string): Promise<ConversationAnalysis> {
  const config = await getActiveAIConfig();
  const provider = await getAIProvider(config.provider, config.aiModel ?? undefined);
  return provider.analyzeConversation({ transcript });
}
