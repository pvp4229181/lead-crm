import { z } from 'zod';
import { objectId, optionalId } from './index.js';

export const conversationListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  search: z.string().max(100).optional(),
  filter: z.enum(['all', 'unread', 'ai', 'human', 'hot', 'archived']).default('all'),
  assignedTo: objectId.optional(),
});

export const sendMessageInput = z.object({ text: z.string().trim().min(1).max(4096) });

// Business-initiated send. WhatsApp only permits opening a conversation with an approved
// template, so free-form text is deliberately not accepted here — use the conversation
// composer for that, which is only reachable inside the 24-hour customer session window.
export const sendTemplateInput = z.object({
  phone: z.string().trim().min(6).max(20).optional(),
  lead: objectId.optional(),
  template: objectId.optional(),
  // Escape hatch for templates that exist at Meta but not in our local library —
  // notably the `hello_world` sample every test number ships with.
  templateName: z.string().trim().min(1).max(120).optional(),
  language: z.string().trim().max(20).optional(),
  variables: z.array(z.string().max(500)).max(10).default([]),
}).refine(input => input.phone || input.lead, { message: 'Provide a phone number or a lead' })
  .refine(input => input.template || input.templateName, { message: 'Select a template' });

export const aiToggleInput = z.object({ aiEnabled: z.boolean() });

export const aiConfigurationInput = z.object({
  agentName: z.string().min(1).max(80).optional(),
  agentRole: z.string().min(1).max(120).optional(),
  companyName: z.string().min(1).max(160).optional(),
  companyDescription: z.string().max(4000).optional(),
  welcomeMessage: z.string().max(1000).optional(),
  tone: z.enum(['Professional', 'Friendly', 'Casual', 'Sales-focused', 'Custom']).optional(),
  customTone: z.string().max(500).optional(),
  language: z.enum(['en', 'hi', 'hinglish', 'auto']).optional(),
  qualificationQuestions: z.array(z.string().max(300)).max(20).optional(),
  businessHours: z.object({
    timezone: z.string().optional(),
    days: z.array(z.object({ day: z.number().int().min(0).max(6), start: z.string().optional(), end: z.string().optional(), enabled: z.boolean().optional() })).optional(),
  }).optional(),
  outsideHoursMessage: z.string().max(1000).optional(),
  welcomeMenuEnabled: z.boolean().optional(),
  humanHandoffButtonEnabled: z.boolean().optional(),
  // WhatsApp rejects the whole message if a reply-button title exceeds 20 characters.
  menuButtonLabels: z.object({
    question: z.string().max(20).optional(), pricing: z.string().max(20).optional(),
    human: z.string().max(20).optional(), ai: z.string().max(20).optional(),
  }).optional(),
  humanRequestedMessage: z.string().max(1000).optional(),
  aiResumedMessage: z.string().max(1000).optional(),
  autoGreetNewLeads: z.boolean().optional(),
  autoGreetTemplate: optionalId,
  sendServiceListOnReply: z.boolean().optional(),
  serviceListIntro: z.string().max(500).optional(),
  provider: z.enum(['anthropic', 'openai', 'openrouter', 'mock']).optional(),
  aiModel: z.string().max(80).optional(),
  creativity: z.coerce.number().min(0).max(1).optional(),
  maxResponseLength: z.coerce.number().int().min(50).max(4000).optional(),
  maxAiMessagesBeforeEscalation: z.coerce.number().int().min(1).max(200).optional(),
  globalAiEnabled: z.boolean().optional(),
  escalationRules: z.object({
    onHumanRequest: z.boolean().optional(), onNegativeSentiment: z.boolean().optional(), onLowConfidence: z.boolean().optional(),
    onComplexPricing: z.boolean().optional(), onSeriousComplaint: z.boolean().optional(), onVipLead: z.boolean().optional(),
    vipLeadScoreThreshold: z.coerce.number().min(0).max(100).optional(), lowConfidenceThreshold: z.coerce.number().min(0).max(1).optional(),
  }).optional(),
});

export const productInput = z.object({ name: z.string().min(1).max(160), description: z.string().max(4000).optional(), category: z.string().max(80).optional(), price: z.coerce.number().min(0).optional(), currency: z.string().max(6).optional(), priceType: z.enum(['fixed', 'starting_at', 'custom']).optional(), sku: z.string().max(60).optional(), link: z.string().url().or(z.literal('')).optional(), tags: z.array(z.string()).optional(), active: z.boolean().optional() });
export const serviceInput = productInput.extend({ duration: z.string().max(80).optional(), deliverables: z.array(z.string()).optional() });
export const faqInput = z.object({ question: z.string().min(1).max(400), answer: z.string().min(1).max(4000), category: z.string().max(80).optional(), active: z.boolean().optional() });
export const articleInput = z.object({ title: z.string().min(1).max(200), content: z.string().min(1).max(20000), category: z.enum(['faq', 'product', 'pricing', 'policy', 'service', 'company', 'sales_script', 'other']).optional(), tags: z.array(z.string()).optional(), active: z.boolean().optional() });

export const templateInput = z.object({
  templateName: z.string().min(1).max(120), category: z.enum(['MARKETING', 'UTILITY', 'AUTHENTICATION']),
  language: z.string().max(20).optional(), header: z.string().max(200).optional(), body: z.string().min(1).max(2000),
  footer: z.string().max(200).optional(), buttons: z.array(z.any()).optional(), status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional(),
});

export const campaignInput = z.object({
  campaignName: z.string().min(1).max(160),
  template: objectId,
  audience: z.object({
    stage: z.array(z.string()).optional(), tags: z.array(objectId).optional(), temperature: z.array(z.string()).optional(),
    location: z.array(z.string()).optional(), salesperson: z.array(objectId).optional(), source: z.array(objectId).optional(),
    lastActivityBefore: z.coerce.date().optional(), lastActivityAfter: z.coerce.date().optional(),
  }).default({}),
  templateVariables: z.record(z.string(), z.string()).optional(),
  scheduledAt: z.coerce.date().nullish(),
});

export const accountInput = z.object({ label: z.string().min(1).max(120), phoneNumberId: z.string().min(1), businessAccountId: z.string().min(1), displayPhoneNumber: z.string().max(40).optional(), active: z.boolean().optional() });
