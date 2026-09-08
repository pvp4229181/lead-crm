import mongoose, { Schema, type HydratedDocument } from 'mongoose';

const ref = (model: string, required = false) => ({ type: Schema.Types.ObjectId, ref: model, required });
const namedSchema = (extra: Record<string, unknown> = {}) => new Schema({ name: { type: String, required: true, trim: true, unique: true }, active: { type: Boolean, default: true }, ...extra }, { timestamps: true });

export interface IUser { _id: mongoose.Types.ObjectId; name: string; email: string; password: string; avatar?: string; role: mongoose.Types.ObjectId | { name: string; permissions: string[] }; active: boolean; }
const roleSchema = namedSchema({ permissions: [{ type: String, required: true }] });
const userSchema = new Schema<IUser>({ name: { type: String, required: true, trim: true }, email: { type: String, required: true, unique: true, lowercase: true, trim: true }, password: { type: String, required: true, select: false }, avatar: String, role: ref('Role', true), active: { type: Boolean, default: true } }, { timestamps: true });

const pipelineStageSchema = namedSchema({ sequence: { type: Number, required: true, default: 0 }, probability: { type: Number, min: 0, max: 100, default: 10 }, folded: { type: Boolean, default: false }, isWon: { type: Boolean, default: false }, color: { type: String, default: '#64748b' } });
pipelineStageSchema.index({ sequence: 1 });
const tagSchema = namedSchema({ color: { type: String, default: '#64748b' } });
const sourceSchema = namedSchema();
const campaignSchema = namedSchema();
const mediumSchema = namedSchema();
const lostReasonSchema = namedSchema();
const activityTypeSchema = namedSchema({ icon: { type: String, default: 'check' }, defaultDays: { type: Number, default: 1 } });

const address = { street: String, city: String, state: String, zip: String, country: String };
const companySchema = new Schema({ name: { type: String, required: true, trim: true }, industry: String, website: String, phone: String, email: { type: String, lowercase: true }, address, salesperson: ref('User'), tags: [ref('Tag')] }, { timestamps: true });
companySchema.index({ name: 'text', email: 'text', phone: 'text' });
companySchema.index({ salesperson: 1, createdAt: -1 });
const contactSchema = new Schema({ name: { type: String, required: true, trim: true }, company: ref('Company'), jobPosition: String, email: { type: String, lowercase: true }, phone: String, mobile: String, address, website: String, notes: String, salesperson: ref('User'), whatsappId: { type: String, trim: true }, whatsappOptIn: { type: Boolean, default: true } }, { timestamps: true });
contactSchema.index({ name: 'text', email: 'text', phone: 'text' });
contactSchema.index({ whatsappId: 1 }, { sparse: true });

const salesTeamSchema = new Schema({ name: { type: String, required: true, unique: true }, teamLeader: ref('User', true), members: [ref('User')], emailAlias: String, target: { type: Number, min: 0, default: 0 }, active: { type: Boolean, default: true } }, { timestamps: true });
const leadSchema = new Schema({
  title: { type: String, required: true, trim: true }, contactName: String, companyName: String, email: { type: String, lowercase: true }, phone: String,
  expectedRevenue: { type: Number, min: 0, default: 0 }, priority: { type: Number, min: 0, max: 3, default: 1 },
  salesperson: ref('User'), salesTeam: ref('SalesTeam'), tags: [ref('Tag')], source: ref('LeadSource'), medium: ref('Medium'), campaign: ref('Campaign'),
  notes: String, status: { type: String, enum: ['new', 'qualified', 'disqualified', 'converted'], default: 'new' },
  lostReason: ref('LostReason'), lostNotes: String, converted: { type: Boolean, default: false }, convertedOpportunity: ref('Opportunity'),
  createdBy: ref('User', true), updatedBy: ref('User', true),
  // WhatsApp AI Sales Agent — fields the AI pipeline reads/writes as it qualifies a conversation.
  // Kept separate from `status` above (which drives lead→opportunity conversion) so the AI's own
  // stage machine can't corrupt that flow.
  leadScore: { type: Number, min: 0, max: 100, default: 0 },
  leadTemperature: { type: String, enum: ['Cold', 'Warm', 'Hot', 'Very Hot'], default: 'Cold' },
  qualificationStatus: { type: String, enum: ['new', 'contacted', 'qualified', 'proposal', 'negotiation', 'won', 'lost'], default: 'new' },
  customerIntent: String, budget: String, purchaseTimeline: String, quantity: String,
  requirements: [String], painPoints: [String], objections: [String], productInterest: [String],
  aiSummary: String, recommendedNextAction: String, salesProbability: { type: Number, min: 0, max: 100 }, lastAiAnalysisAt: Date,
}, { timestamps: true });
leadSchema.index({ title: 'text', contactName: 'text', companyName: 'text', email: 'text', phone: 'text' });
leadSchema.index({ salesperson: 1, status: 1, createdAt: -1 });
leadSchema.index({ salesTeam: 1, source: 1, campaign: 1 });
leadSchema.index({ leadTemperature: 1, qualificationStatus: 1 });
leadSchema.index({ phone: 1 });

const opportunitySchema = new Schema({ title: { type: String, required: true, trim: true }, company: ref('Company'), contact: ref('Contact'), email: { type: String, lowercase: true }, phone: String, expectedRevenue: { type: Number, min: 0, default: 0 }, recurringRevenue: { type: Number, min: 0, default: 0 }, probability: { type: Number, min: 0, max: 100, default: 10 }, priority: { type: Number, min: 0, max: 3, default: 1 }, salesperson: ref('User'), salesTeam: ref('SalesTeam'), stage: ref('PipelineStage', true), tags: [ref('Tag')], source: ref('LeadSource'), medium: ref('Medium'), campaign: ref('Campaign'), expectedClosingDate: Date, status: { type: String, enum: ['open', 'won', 'lost'], default: 'open' }, lostReason: ref('LostReason'), lostNotes: String, wonAt: Date, lostAt: Date, kanbanOrder: { type: Number, default: 0 }, internalNotes: String, referredBy: String, createdBy: ref('User', true), updatedBy: ref('User', true) }, { timestamps: true });
opportunitySchema.index({ title: 'text', email: 'text', phone: 'text' });
opportunitySchema.index({ stage: 1, status: 1, kanbanOrder: 1 });
opportunitySchema.index({ salesperson: 1, salesTeam: 1, status: 1 });
opportunitySchema.index({ company: 1, contact: 1, createdAt: -1 });
opportunitySchema.index({ source: 1, campaign: 1, expectedClosingDate: 1 });

const activitySchema = new Schema({ activityType: ref('ActivityType', true), dueDate: { type: Date, required: true }, assignedTo: ref('User', true), summary: { type: String, required: true }, notes: String, relatedModel: { type: String, enum: ['Lead', 'Opportunity', 'Contact', 'Company'], required: true }, relatedId: { type: Schema.Types.ObjectId, required: true, refPath: 'relatedModel' }, status: { type: String, enum: ['planned', 'completed'], default: 'planned' }, completedAt: Date, createdBy: ref('User', true) }, { timestamps: true });
activitySchema.index({ assignedTo: 1, status: 1, dueDate: 1 });
activitySchema.index({ relatedModel: 1, relatedId: 1 });
const timelineEventSchema = new Schema({ createdBy: ref('User', true), relatedModel: { type: String, enum: ['Lead', 'Opportunity', 'Contact', 'Company'], required: true }, relatedId: { type: Schema.Types.ObjectId, required: true }, eventType: { type: String, required: true }, message: { type: String, required: true }, metadata: { type: Schema.Types.Mixed, default: {} } }, { timestamps: true });
timelineEventSchema.index({ relatedModel: 1, relatedId: 1, createdAt: -1 });
const notificationSchema = new Schema({ user: ref('User', true), title: { type: String, required: true }, message: String, type: { type: String, required: true }, read: { type: Boolean, default: false }, link: String }, { timestamps: true });
notificationSchema.index({ user: 1, read: 1, createdAt: -1 });
const savedFilterSchema = new Schema({ name: { type: String, required: true }, user: ref('User', true), resource: { type: String, required: true }, query: { type: Schema.Types.Mixed, required: true }, isDefault: { type: Boolean, default: false } }, { timestamps: true });
savedFilterSchema.index({ user: 1, resource: 1, name: 1 }, { unique: true });
const noteSchema = new Schema({ body: { type: String, required: true }, createdBy: ref('User', true), relatedModel: { type: String, required: true }, relatedId: { type: Schema.Types.ObjectId, required: true } }, { timestamps: true });

export const Role = mongoose.model('Role', roleSchema); export const User = mongoose.model<IUser>('User', userSchema);
export const PipelineStage = mongoose.model('PipelineStage', pipelineStageSchema); export const Tag = mongoose.model('Tag', tagSchema);
export const LeadSource = mongoose.model('LeadSource', sourceSchema); export const Campaign = mongoose.model('Campaign', campaignSchema); export const Medium = mongoose.model('Medium', mediumSchema); export const LostReason = mongoose.model('LostReason', lostReasonSchema); export const ActivityType = mongoose.model('ActivityType', activityTypeSchema);
export const Company = mongoose.model('Company', companySchema); export const Contact = mongoose.model('Contact', contactSchema); export const SalesTeam = mongoose.model('SalesTeam', salesTeamSchema); export const Lead = mongoose.model('Lead', leadSchema); export const Opportunity = mongoose.model('Opportunity', opportunitySchema); export const Activity = mongoose.model('Activity', activitySchema); export const TimelineEvent = mongoose.model('TimelineEvent', timelineEventSchema); export const Notification = mongoose.model('Notification', notificationSchema); export const SavedFilter = mongoose.model('SavedFilter', savedFilterSchema); export const Note = mongoose.model('Note', noteSchema);
export type UserDocument = HydratedDocument<IUser>;
opportunitySchema.set('toJSON', { virtuals: true });

const userInvitationSchema = new Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, lowercase: true, trim: true },
  role: ref('Role', true),
  tokenHash: { type: String, required: true, unique: true, select: false },
  status: { type: String, enum: ['pending', 'accepted', 'revoked'], default: 'pending' },
  invitedBy: ref('User', true),
  expiresAt: { type: Date, required: true },
  acceptedAt: Date,
}, { timestamps: true });
userInvitationSchema.index({ email: 1, status: 1 });
userInvitationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const UserInvitation = mongoose.model('UserInvitation', userInvitationSchema);

// ---------------------------------------------------------------------------
// WhatsApp AI Sales Agent
// ---------------------------------------------------------------------------

const whatsAppAccountSchema = new Schema({
  label: { type: String, required: true, trim: true },
  phoneNumberId: { type: String, required: true, unique: true },
  businessAccountId: { type: String, required: true },
  displayPhoneNumber: String,
  // The live token lives in WHATSAPP_ACCESS_TOKEN; this is only populated for
  // multi-account setups where a per-account token is required. Never returned
  // to the client (see toJSON transform on the model export below).
  accessTokenOverride: { type: String, select: false },
  webhookVerifyToken: { type: String, select: false },
  active: { type: Boolean, default: true },
}, { timestamps: true });

const businessHoursSchema = { timezone: { type: String, default: 'Asia/Kolkata' }, days: [{ day: { type: Number, min: 0, max: 6 }, start: String, end: String, enabled: { type: Boolean, default: true } }] };
const aiConfigurationSchema = new Schema({
  waAccount: ref('WhatsAppAccount'),
  agentName: { type: String, default: 'Aria' },
  agentRole: { type: String, default: 'Sales Assistant' },
  companyName: { type: String, default: 'Our Company' },
  companyDescription: String,
  welcomeMessage: { type: String, default: "Hi! Thanks for reaching out. How can I help you today?" },
  tone: { type: String, enum: ['Professional', 'Friendly', 'Casual', 'Sales-focused', 'Custom'], default: 'Friendly' },
  customTone: String,
  language: { type: String, enum: ['en', 'hi', 'hinglish', 'auto'], default: 'auto' },
  qualificationQuestions: [String],
  businessHours: businessHoursSchema,
  outsideHoursMessage: { type: String, default: "Thanks for your message! Our team is currently offline and will get back to you during business hours." },
  // Lead-side mode switching: the customer picks AI vs human from buttons in WhatsApp,
  // instead of the model having to infer it from their phrasing.
  welcomeMenuEnabled: { type: Boolean, default: true },
  humanHandoffButtonEnabled: { type: Boolean, default: true },
  menuButtonLabels: {
    question: { type: String, default: 'Ask a question' },
    pricing: { type: String, default: 'Pricing' },
    human: { type: String, default: 'Talk to a human' },
    ai: { type: String, default: 'Back to AI' },
  },
  humanRequestedMessage: { type: String, default: "Sure — I'm connecting you with a member of our team. Someone will reply here shortly." },
  aiResumedMessage: { type: String, default: "You're back with our AI assistant. How can I help?" },
  // Auto-greeting new CRM leads. WhatsApp only permits business-initiated messages via an
  // approved template, so the greeting is a template; the service catalogue (free-form,
  // with links) can only follow once the customer replies and opens the 24-hour window.
  autoGreetNewLeads: { type: Boolean, default: false },
  autoGreetTemplate: ref('WhatsAppTemplate'),
  sendServiceListOnReply: { type: Boolean, default: true },
  serviceListIntro: { type: String, default: "Here's a quick look at what we offer:" },
  provider: { type: String, enum: ['anthropic', 'openai', 'openrouter', 'mock'], default: 'mock' },
  aiModel: String,
  creativity: { type: Number, min: 0, max: 1, default: 0.4 },
  maxResponseLength: { type: Number, default: 700 },
  maxAiMessagesBeforeEscalation: { type: Number, default: 20 },
  globalAiEnabled: { type: Boolean, default: true },
  escalationRules: {
    onHumanRequest: { type: Boolean, default: true },
    onNegativeSentiment: { type: Boolean, default: true },
    onLowConfidence: { type: Boolean, default: true },
    onComplexPricing: { type: Boolean, default: true },
    onSeriousComplaint: { type: Boolean, default: true },
    onVipLead: { type: Boolean, default: true },
    vipLeadScoreThreshold: { type: Number, default: 80 },
    lowConfidenceThreshold: { type: Number, default: 0.45 },
  },
  active: { type: Boolean, default: true },
}, { timestamps: true });

const whatsAppConversationSchema = new Schema({
  contact: ref('Contact'),
  lead: ref('Lead'),
  phoneNumber: { type: String, required: true, trim: true },
  customerName: String,
  waAccount: ref('WhatsAppAccount'),
  assignedTo: ref('User'),
  status: { type: String, enum: ['open', 'pending', 'resolved', 'archived'], default: 'open' },
  controlStatus: { type: String, enum: ['AI_ACTIVE', 'WAITING_HUMAN', 'HUMAN_ACTIVE', 'AI_PAUSED'], default: 'AI_ACTIVE' },
  aiEnabled: { type: Boolean, default: true },
  humanTakeover: { type: Boolean, default: false },
  aiMessageCount: { type: Number, default: 0 },
  language: { type: String, enum: ['en', 'hi', 'hinglish'], default: 'en' },
  lastMessage: String,
  lastMessageAt: Date,
  lastInboundAt: Date,
  unreadCount: { type: Number, default: 0 },
  sentiment: { type: String, enum: ['positive', 'neutral', 'negative'] },
  sentimentConfidence: Number,
  detectedIntent: { type: String, enum: ['GENERAL_INQUIRY', 'PRODUCT_INQUIRY', 'PRICING_REQUEST', 'DEMO_REQUEST', 'MEETING_REQUEST', 'CALLBACK_REQUEST', 'PURCHASE_INTENT', 'NEGOTIATION', 'SUPPORT_REQUEST', 'COMPLAINT', 'HUMAN_REQUEST', 'NOT_INTERESTED', 'OTHER'] },
  tags: [ref('Tag')],
  archived: { type: Boolean, default: false },
  followUpsSent: [{ rule: String, at: { type: Date, default: Date.now } }],
  greetedAt: Date,
  serviceListSentAt: Date,
}, { timestamps: true });
whatsAppConversationSchema.index({ phoneNumber: 1 }, { unique: true });
whatsAppConversationSchema.index({ status: 1, lastMessageAt: -1 });
whatsAppConversationSchema.index({ assignedTo: 1, status: 1 });
whatsAppConversationSchema.index({ controlStatus: 1 });

const whatsAppMessageSchema = new Schema({
  conversation: ref('WhatsAppConversation', true),
  waAccount: ref('WhatsAppAccount'),
  whatsappMessageId: { type: String },
  direction: { type: String, enum: ['INBOUND', 'OUTBOUND'], required: true },
  sender: String,
  receiver: String,
  type: { type: String, enum: ['text', 'image', 'document', 'audio', 'video', 'location', 'template', 'interactive', 'sticker', 'contacts', 'unknown'], default: 'text' },
  text: String,
  mediaId: String,
  mediaUrl: String,
  mediaMimeType: String,
  caption: String,
  filename: String,
  location: { lat: Number, lng: Number, name: String, address: String },
  templateName: String,
  timestamp: { type: Date, default: Date.now },
  status: { type: String, enum: ['QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED'], default: 'QUEUED' },
  statusUpdatedAt: Date,
  failReason: String,
  aiGenerated: { type: Boolean, default: false },
  sentBy: ref('User'),
  intent: String,
  sentiment: String,
  metadata: { type: Schema.Types.Mixed, default: {} },
}, { timestamps: true });
whatsAppMessageSchema.index({ whatsappMessageId: 1 }, { unique: true, sparse: true });
whatsAppMessageSchema.index({ conversation: 1, timestamp: 1 });

const aiConversationSummarySchema = new Schema({
  conversation: ref('WhatsAppConversation', true),
  lead: ref('Lead'),
  summary: String,
  requirement: String,
  painPoints: [String],
  productInterest: [String],
  budget: String,
  timeline: String,
  objections: [String],
  nextAction: String,
  salesProbability: Number,
  sentiment: String,
  generatedAt: { type: Date, default: Date.now },
}, { timestamps: true });
aiConversationSummarySchema.index({ conversation: 1, createdAt: -1 });

const productSchema = new Schema({ name: { type: String, required: true, trim: true }, description: String, category: String, price: Number, currency: { type: String, default: 'INR' }, priceType: { type: String, enum: ['fixed', 'starting_at', 'custom'], default: 'fixed' }, sku: String, link: String, tags: [String], active: { type: Boolean, default: true } }, { timestamps: true });
productSchema.index({ name: 'text', description: 'text', category: 'text' });
const serviceSchema = new Schema({ name: { type: String, required: true, trim: true }, description: String, category: String, price: Number, currency: { type: String, default: 'INR' }, priceType: { type: String, enum: ['fixed', 'starting_at', 'custom'], default: 'fixed' }, duration: String, deliverables: [String], link: String, tags: [String], active: { type: Boolean, default: true } }, { timestamps: true });
serviceSchema.index({ name: 'text', description: 'text', category: 'text' });
const faqSchema = new Schema({ question: { type: String, required: true, trim: true }, answer: { type: String, required: true }, category: String, active: { type: Boolean, default: true } }, { timestamps: true });
faqSchema.index({ question: 'text', answer: 'text' });
const knowledgeArticleSchema = new Schema({ title: { type: String, required: true, trim: true }, content: { type: String, required: true }, category: { type: String, enum: ['faq', 'product', 'pricing', 'policy', 'service', 'company', 'sales_script', 'other'], default: 'other' }, tags: [String], active: { type: Boolean, default: true } }, { timestamps: true });
knowledgeArticleSchema.index({ title: 'text', content: 'text', category: 'text' });

const whatsAppTemplateSchema = new Schema({
  templateName: { type: String, required: true, trim: true },
  category: { type: String, enum: ['MARKETING', 'UTILITY', 'AUTHENTICATION'], required: true },
  language: { type: String, default: 'en_US' },
  header: String,
  body: { type: String, required: true },
  footer: String,
  buttons: { type: Schema.Types.Mixed, default: [] },
  status: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED'], default: 'PENDING' },
  metaTemplateId: String,
  variableSample: [String],
  active: { type: Boolean, default: true },
}, { timestamps: true });
whatsAppTemplateSchema.index({ templateName: 1, language: 1 }, { unique: true });

const whatsAppCampaignSchema = new Schema({
  campaignName: { type: String, required: true, trim: true },
  template: ref('WhatsAppTemplate', true),
  audience: {
    stage: [String], tags: [ref('Tag')], temperature: [String], location: [String],
    salesperson: [ref('User')], source: [ref('LeadSource')], lastActivityBefore: Date, lastActivityAfter: Date,
  },
  templateVariables: { type: Schema.Types.Mixed, default: {} },
  scheduledAt: Date,
  status: { type: String, enum: ['draft', 'scheduled', 'sending', 'completed', 'failed', 'cancelled'], default: 'draft' },
  audienceSize: { type: Number, default: 0 },
  sent: { type: Number, default: 0 },
  delivered: { type: Number, default: 0 },
  read: { type: Number, default: 0 },
  failed: { type: Number, default: 0 },
  replied: { type: Number, default: 0 },
  createdBy: ref('User', true),
}, { timestamps: true });

const followUpRuleSchema = new Schema({
  name: { type: String, required: true },
  triggerAfterHours: { type: Number, required: true },
  condition: { type: String, enum: ['no_response', 'hot_lead_inactive'], default: 'no_response' },
  action: { type: String, enum: ['send_message', 'create_activity', 'notify_salesperson'], required: true },
  messageText: String,
  maxOccurrences: { type: Number, default: 1 },
  active: { type: Boolean, default: true },
}, { timestamps: true });

export const WhatsAppAccount = mongoose.model('WhatsAppAccount', whatsAppAccountSchema);
export const AIConfiguration = mongoose.model('AIConfiguration', aiConfigurationSchema);
export const WhatsAppConversation = mongoose.model('WhatsAppConversation', whatsAppConversationSchema);
export const WhatsAppMessage = mongoose.model('WhatsAppMessage', whatsAppMessageSchema);
export const AIConversationSummary = mongoose.model('AIConversationSummary', aiConversationSummarySchema);
export const Product = mongoose.model('Product', productSchema);
export const Service = mongoose.model('Service', serviceSchema);
export const FAQ = mongoose.model('FAQ', faqSchema);
export const KnowledgeArticle = mongoose.model('KnowledgeArticle', knowledgeArticleSchema);
export const WhatsAppTemplate = mongoose.model('WhatsAppTemplate', whatsAppTemplateSchema);
export const WhatsAppCampaign = mongoose.model('WhatsAppCampaign', whatsAppCampaignSchema);
export const FollowUpRule = mongoose.model('FollowUpRule', followUpRuleSchema);
