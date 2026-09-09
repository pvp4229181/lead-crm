import { z } from 'zod';
import { objectId, optionalId } from './index.js';
import { ACTION_TYPES, CONDITION_OPERATORS, DELAY_UNITS, MESSAGE_TYPES, TEMPLATE_CATEGORIES, TEMPLATE_STATUSES } from '../models/automation.js';
import { TRIGGER_KEYS } from '../automation/trigger.service.js';

// Template keys are used as identifiers in code, seeds and the API, so they are held to a
// slug shape rather than accepting arbitrary text.
const templateKey = z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_]{2,59}$/, 'Use lowercase letters, numbers and underscores');
const trigger = z.enum(TRIGGER_KEYS as [string, ...string[]]);

const condition = z.object({
  field: z.string().min(1).max(80),
  operator: z.enum(CONDITION_OPERATORS),
  value: z.union([z.string().max(500), z.number(), z.boolean(), z.array(z.string().max(200)).max(50)]).optional(),
});

const delay = z.object({ value: z.coerce.number().min(0).max(10000).default(0), unit: z.enum(DELAY_UNITS).default('minutes') });

const action = z.object({
  type: z.enum(ACTION_TYPES),
  config: z.record(z.string(), z.unknown()).default({}),
});

export const automationTemplateInput = z.object({
  templateName: z.string().trim().min(2).max(120),
  templateKey,
  category: z.enum(TEMPLATE_CATEGORIES).default('other'),
  description: z.string().max(500).optional(),
  trigger,
  messageType: z.enum(MESSAGE_TYPES).default('text'),
  // WhatsApp caps a text body at 4096 characters; anything longer is rejected at send time.
  message: z.string().trim().min(1).max(4096),
  requiredVariables: z.array(z.string().max(60)).max(40).default([]),
  askMode: z.boolean().default(false),
  // Reply buttons: at most 3, titles at most 20 characters — WhatsApp rejects the whole
  // message otherwise.
  buttons: z.array(z.object({ id: z.string().min(1).max(60), title: z.string().min(1).max(20) })).max(3).default([]),
  conditions: z.array(condition).max(20).default([]),
  delay: delay.optional(),
  aiEnabled: z.boolean().default(false),
  internalOnly: z.boolean().default(false),
  assignedPipeline: optionalId,
  assignedAgent: optionalId,
  priority: z.coerce.number().int().min(0).max(1000).default(100),
  status: z.enum(TEMPLATE_STATUSES).default('draft'),
});

export const automationInput = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().max(500).optional(),
  trigger,
  template: optionalId,
  conditions: z.array(condition).max(20).default([]),
  delay: delay.optional(),
  actions: z.array(action).max(10).default([]),
  maxAttempts: z.coerce.number().int().min(1).max(20).default(1),
  repeatEveryHours: z.coerce.number().min(0).max(8760).default(0),
  stopOn: z.array(z.string().max(60)).max(20).default([]),
  assignedPipeline: optionalId,
  assignedAgent: optionalId,
  priority: z.coerce.number().int().min(0).max(1000).default(100),
  status: z.enum(TEMPLATE_STATUSES).default('draft'),
});

export const templateListQuery = z.object({
  search: z.string().max(100).optional(),
  category: z.enum(TEMPLATE_CATEGORIES).optional(),
  status: z.enum(TEMPLATE_STATUSES).optional(),
  trigger: trigger.optional(),
});

export const logListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  status: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled', 'skipped']).optional(),
  trigger: trigger.optional(),
  automation: objectId.optional(),
  conversation: objectId.optional(),
});

// A test send either previews the render (default) or delivers to one conversation.
export const templateTestInput = z.object({
  conversation: optionalId,
  lead: optionalId,
  send: z.boolean().default(false),
  data: z.record(z.string(), z.string().max(500)).default({}),
});
