// ---------------------------------------------------------------------------
// ARIA — WhatsApp automation engine
//
// Everything a CRM admin can edit about what ARIA sends lives in these four
// collections. No customer-facing copy is allowed in controllers, routes,
// webhook handlers or AI services: they resolve a template out of the database
// instead, so the messaging can be changed without a deploy.
// ---------------------------------------------------------------------------
import mongoose, { Schema } from 'mongoose';

const ref = (model: string, required = false) => ({ type: Schema.Types.ObjectId, ref: model, required });

export const TEMPLATE_CATEGORIES = [
  'welcome', 'qualification', 'product_enquiry', 'appointment', 'human_handoff', 'quotation',
  'follow_up', 'internal_alert', 'payment', 'status_update', 'feedback', 'other',
] as const;
export const TEMPLATE_STATUSES = ['draft', 'active', 'paused', 'archived'] as const;
export const MESSAGE_TYPES = ['text', 'interactive', 'media', 'internal'] as const;
export const DELAY_UNITS = ['minutes', 'hours', 'days'] as const;
export const CONDITION_OPERATORS = [
  'equals', 'not_equals', 'contains', 'not_contains', 'exists', 'not_exists',
  'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'is_true', 'is_false',
] as const;
export const ACTION_TYPES = [
  'send_template', 'notify_agent', 'create_activity', 'assign_agent',
  'set_pipeline_stage', 'pause_ai', 'resume_ai', 'stop_followups', 'tag_lead',
] as const;
export const LOG_STATUSES = ['pending', 'running', 'completed', 'failed', 'cancelled', 'skipped'] as const;

export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];
export type DelayUnit = (typeof DELAY_UNITS)[number];
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];
export type ActionType = (typeof ACTION_TYPES)[number];
export type LogStatus = (typeof LOG_STATUSES)[number];

const conditionSchema = new Schema({
  field: { type: String, required: true },
  operator: { type: String, enum: CONDITION_OPERATORS, default: 'equals' },
  value: Schema.Types.Mixed,
}, { _id: false });

const delaySchema = { value: { type: Number, min: 0, default: 0 }, unit: { type: String, enum: DELAY_UNITS, default: 'minutes' } };

/** A stored {value, unit} delay as milliseconds. 0 means "run immediately". */
export const delayToMs = (delay?: { value?: number | null; unit?: string | null } | null): number => {
  const value = delay?.value ?? 0;
  if (value <= 0) return 0;
  return value * (delay?.unit === 'days' ? 86_400_000 : delay?.unit === 'hours' ? 3_600_000 : 60_000);
};

// `source` separates templates shipped by the ARIA seed from ones an admin wrote.
// The migration only ever deletes legacy seeds, never anything marked 'custom'.
const provenance = {
  source: { type: String, enum: ['aria', 'custom'], default: 'custom' },
  isSystem: { type: Boolean, default: false },
  version: { type: Number, default: 1 },
};

const automationTemplateSchema = new Schema({
  templateName: { type: String, required: true, trim: true },
  templateKey: { type: String, required: true, unique: true, trim: true, lowercase: true },
  category: { type: String, enum: TEMPLATE_CATEGORIES, default: 'other' },
  description: String,
  trigger: { type: String, required: true, trim: true },
  messageType: { type: String, enum: MESSAGE_TYPES, default: 'text' },
  message: { type: String, required: true },
  // Declared for the editor's variable palette and for validation. `requiredVariables`
  // block the send when unresolved, instead of shipping a half-empty message.
  variables: [String],
  requiredVariables: [String],
  // Information-request template (the qualification and appointment asks): a line whose
  // variable the CRM already knows is dropped, so ARIA only ever asks for what is missing.
  askMode: { type: Boolean, default: false },
  buttons: [{ id: String, title: String, _id: false }],
  conditions: { type: [conditionSchema], default: [] },
  delay: delaySchema,
  aiEnabled: { type: Boolean, default: false },
  // Internal alerts (hot lead notifications) must never reach the customer.
  internalOnly: { type: Boolean, default: false },
  assignedPipeline: ref('PipelineStage'),
  assignedAgent: ref('User'),
  priority: { type: Number, default: 100 },
  status: { type: String, enum: TEMPLATE_STATUSES, default: 'draft' },
  ...provenance,
  createdBy: ref('User'),
  updatedBy: ref('User'),
  lastTestedAt: Date,
}, { timestamps: true });
automationTemplateSchema.index({ trigger: 1, status: 1 });
automationTemplateSchema.index({ category: 1, status: 1 });
automationTemplateSchema.index({ templateName: 'text', description: 'text', message: 'text' });

const automationSchema = new Schema({
  name: { type: String, required: true, trim: true },
  automationKey: { type: String, trim: true, lowercase: true, unique: true, sparse: true },
  description: String,
  trigger: { type: String, required: true, trim: true },
  template: ref('AutomationTemplate'),
  conditions: { type: [conditionSchema], default: [] },
  delay: delaySchema,
  actions: {
    type: [new Schema({ type: { type: String, enum: ACTION_TYPES, required: true }, config: { type: Schema.Types.Mixed, default: {} } }, { _id: false })],
    default: [],
  },
  // Follow-up cadence. `stopOn` names the lead/conversation events that cancel any
  // pending attempt, so a customer who replied is never chased again.
  maxAttempts: { type: Number, min: 1, default: 1 },
  repeatEveryHours: { type: Number, min: 0, default: 0 },
  stopOn: { type: [String], default: [] },
  aiEnabled: { type: Boolean, default: false },
  assignedPipeline: ref('PipelineStage'),
  assignedAgent: ref('User'),
  priority: { type: Number, default: 100 },
  status: { type: String, enum: TEMPLATE_STATUSES, default: 'draft' },
  ...provenance,
  runCount: { type: Number, default: 0 },
  lastRunAt: Date,
  lastError: String,
  createdBy: ref('User'),
  updatedBy: ref('User'),
}, { timestamps: true });
automationSchema.index({ trigger: 1, status: 1, priority: 1 });

const automationLogSchema = new Schema({
  automation: ref('Automation'),
  template: ref('AutomationTemplate'),
  contact: ref('Contact'),
  lead: ref('Lead'),
  conversation: ref('WhatsAppConversation'),
  trigger: { type: String, required: true },
  status: { type: String, enum: LOG_STATUSES, default: 'pending' },
  startedAt: { type: Date, default: Date.now },
  completedAt: Date,
  durationMs: Number,
  attempt: { type: Number, default: 1 },
  error: String,
  executedActions: { type: [new Schema({ type: String, status: String, detail: String }, { _id: false })], default: [] },
  metadata: { type: Schema.Types.Mixed, default: {} },
}, { timestamps: true });
automationLogSchema.index({ createdAt: -1 });
automationLogSchema.index({ status: 1, createdAt: -1 });
automationLogSchema.index({ conversation: 1, createdAt: -1 });
automationLogSchema.index({ automation: 1, createdAt: -1 });

// A delayed automation waiting for its turn. `dedupeKey` is the whole duplicate-prevention
// story: the same automation, for the same conversation, on the same attempt, can only ever
// be queued once — no matter how many webhook retries or overlapping cron runs ask for it.
const scheduledAutomationSchema = new Schema({
  automation: ref('Automation', true),
  template: ref('AutomationTemplate'),
  conversation: ref('WhatsAppConversation'),
  lead: ref('Lead'),
  contact: ref('Contact'),
  trigger: { type: String, required: true },
  runAt: { type: Date, required: true },
  status: { type: String, enum: ['pending', 'running', 'completed', 'cancelled', 'failed'], default: 'pending' },
  attempt: { type: Number, default: 1 },
  dedupeKey: { type: String, required: true, unique: true },
  payload: { type: Schema.Types.Mixed, default: {} },
  lockedAt: Date,
  error: String,
}, { timestamps: true });
scheduledAutomationSchema.index({ status: 1, runAt: 1 });
scheduledAutomationSchema.index({ conversation: 1, status: 1 });

export const AutomationTemplate = mongoose.model('AutomationTemplate', automationTemplateSchema);
export const Automation = mongoose.model('Automation', automationSchema);
export const AutomationLog = mongoose.model('AutomationLog', automationLogSchema);
export const ScheduledAutomation = mongoose.model('ScheduledAutomation', scheduledAutomationSchema);

export type AutomationTemplateDoc = InstanceType<typeof AutomationTemplate>;
export type AutomationDoc = InstanceType<typeof Automation>;
export type AutomationLogDoc = InstanceType<typeof AutomationLog>;
