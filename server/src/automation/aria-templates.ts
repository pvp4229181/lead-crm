// The ARIA template pack. These are the definitions the seed/migration upserts into
// MongoDB; once seeded they are ordinary database rows an admin can edit, rename or
// deactivate from WhatsApp Automation → Templates. Nothing reads these constants at
// runtime — the engine always reads the stored document.
import { extractVariables } from './variable.service.js';
import type { TemplateCategory } from '../models/automation.js';

export type AriaTemplateSeed = {
  templateKey: string;
  templateName: string;
  category: TemplateCategory;
  description: string;
  trigger: string;
  messageType: 'text' | 'interactive' | 'internal';
  message: string;
  requiredVariables?: string[];
  buttons?: { id: string; title: string }[];
  /** Information-request template: lines whose variable is already known are dropped. */
  askMode?: boolean;
  internalOnly?: boolean;
  aiEnabled?: boolean;
  priority?: number;
};

// Button payload ids must match services/whatsapp.actions.ts — routing keys off the id,
// never the title, so an admin can retitle a button without breaking the handoff.
export const ARIA_TEMPLATES: AriaTemplateSeed[] = [
  {
    templateKey: 'welcome_message',
    templateName: 'Welcome Message',
    category: 'welcome',
    description: 'First reply to a brand new WhatsApp lead, with buttons for the three most common next steps.',
    trigger: 'new_whatsapp_lead',
    messageType: 'interactive',
    priority: 10,
    aiEnabled: true,
    buttons: [
      { id: 'wa_action_question', title: 'Ask a question' },
      { id: 'wa_action_pricing', title: 'Pricing' },
      { id: 'wa_action_human', title: 'Talk to a human' },
    ],
    message: `Hi {{first_name}}!

Welcome to {{business_name}}. Thanks for reaching out.

I'm ARIA, your AI assistant. I can help you with:
- Product and service information
- Pricing
- Booking a demo or appointment
- Getting a quotation
- Order or service questions
- Connecting with our team

How can I help you today?`,
  },
  {
    templateKey: 'lead_qualification',
    templateName: 'Lead Qualification',
    category: 'qualification',
    description: 'Asks for the qualification details the CRM is still missing. Fields already on the lead are dropped automatically.',
    trigger: 'lead_requires_qualification',
    messageType: 'text',
    priority: 20,
    aiEnabled: true,
    askMode: true,
    message: `Great! I can help you with that.

To connect you with the right solution, I just need a few details.

Name: {{name}}
Company/Business: {{company}}
Email: {{email}}
Interested in: {{interest}}
Budget range: {{budget}}
Expected timeline: {{timeline}}

You can answer one at a time — I'll guide you through it.`,
  },
  {
    templateKey: 'product_service_enquiry',
    templateName: 'Product / Service Enquiry',
    category: 'product_enquiry',
    description: 'Answers a product or service question using the knowledge base. Never sends without a real catalogue item.',
    trigger: 'product_or_service_interest',
    messageType: 'text',
    priority: 30,
    aiEnabled: true,
    requiredVariables: ['product_name'],
    message: `Thanks, {{first_name}}.

Based on what you're looking for, {{recommended_product}} could be a good fit.

Product/Service: {{product_name}}
Starting Price: {{price}}
Key Benefit: {{key_benefit}}
Delivery/Setup: {{delivery_time}}

Would you like pricing details, a quotation, or to speak with our team?`,
  },
  {
    templateKey: 'appointment_booking',
    templateName: 'Demo / Appointment Booking',
    category: 'appointment',
    description: 'Collects a preferred date and time for a demo, meeting or consultation.',
    trigger: 'appointment_requested',
    messageType: 'text',
    priority: 40,
    aiEnabled: true,
    askMode: true,
    message: `I'd be happy to arrange that.

Please choose your preferred date and time:

Date: {{appointment_date}}
Time: {{appointment_time}}

Once confirmed, I'll schedule it with {{sales_rep_name}} and send you the details here.`,
  },
  {
    templateKey: 'human_handoff',
    templateName: 'Human Agent Handoff',
    category: 'human_handoff',
    description: 'Confirms the transfer to a person, pauses ARIA, and leaves a button back to the assistant.',
    trigger: 'human_agent_requested',
    messageType: 'interactive',
    priority: 15,
    buttons: [{ id: 'wa_action_ai', title: 'Back to AI' }],
    message: `Sure, {{first_name}}.

I'm transferring your conversation to {{agent_name}} from our team.

I've already shared the information you've provided, so you won't need to explain everything again.

Someone will assist you shortly.`,
  },
  {
    templateKey: 'quotation_ready',
    templateName: 'Quotation Ready',
    category: 'quotation',
    description: 'Sent when a quotation is generated in the CRM. Blocked unless the quote number and amount are supplied.',
    trigger: 'quotation_created',
    messageType: 'text',
    priority: 50,
    requiredVariables: ['quote_number', 'quote_amount'],
    message: `Hi {{first_name}},

Your quotation is ready.

Quotation: {{quote_number}}
Service/Product: {{product_name}}
Amount: {{quote_amount}}
Valid Until: {{expiry_date}}

{{quotation_link}}

Would you like to proceed, or would you like to discuss any changes?`,
  },
  {
    templateKey: 'no_response_follow_up',
    templateName: 'No-Response Follow-Up',
    category: 'follow_up',
    description: 'Chases a quiet lead. Replies 1-4 are mapped automatically to interested / later / human / not interested.',
    trigger: 'lead_no_response',
    messageType: 'text',
    priority: 60,
    message: `Hi {{first_name}},

Just following up regarding your interest in {{product_name}}.

Would you still like some help with this?

Reply:
1 - Yes, I'm interested
2 - Contact me later
3 - Speak with someone
4 - Not interested`,
  },
  {
    templateKey: 'hot_lead_alert',
    templateName: 'Internal Hot Lead Alert',
    category: 'internal_alert',
    description: 'Internal only — notifies the sales team when a lead crosses the hot-lead score threshold. Never sent to the lead.',
    trigger: 'lead_score_threshold_reached',
    messageType: 'internal',
    internalOnly: true,
    priority: 5,
    message: `HOT LEAD

Name: {{lead_name}}
Phone: {{phone}}
Company: {{company}}
Interested In: {{product}}
Budget: {{budget}}
Timeline: {{timeline}}
AI Lead Score: {{lead_score}}/100

Reason: {{qualification_reason}}

Recommended action: Contact this lead as soon as possible.`,
  },
  {
    templateKey: 'payment_reminder',
    templateName: 'Payment Reminder',
    category: 'payment',
    description: 'Reminds a customer about a pending invoice. Requires the invoice number and amount.',
    trigger: 'payment_due',
    messageType: 'text',
    priority: 70,
    requiredVariables: ['invoice_number', 'amount'],
    message: `Hi {{first_name}},

A quick reminder regarding your pending payment.

Invoice: {{invoice_number}}
Amount: {{amount}}
Due Date: {{due_date}}

Payment Link:
{{payment_link}}

If you've already completed the payment, please ignore this message.`,
  },
  {
    templateKey: 'payment_confirmation',
    templateName: 'Payment Confirmation',
    category: 'payment',
    description: 'Confirms a successful payment. Requires the payment id and amount, so it can never claim an unverified payment.',
    trigger: 'payment_successful',
    messageType: 'text',
    priority: 75,
    requiredVariables: ['payment_id', 'amount'],
    message: `Payment received successfully.

Thank you, {{first_name}}!

Payment ID: {{payment_id}}
Amount: {{amount}}
Date: {{payment_date}}

Your CRM record has been updated automatically.`,
  },
  {
    templateKey: 'order_project_status',
    templateName: 'Order / Project Status',
    category: 'status_update',
    description: 'Notifies the customer when an order, project or service status changes.',
    trigger: 'status_changed',
    messageType: 'text',
    priority: 80,
    requiredVariables: ['status'],
    message: `Hi {{first_name}},

Here's an update on your {{order_or_project}}:

Status: {{status}}
Current Stage: {{stage}}
Expected Completion: {{expected_date}}

I'll keep you updated when the status changes.`,
  },
  {
    templateKey: 'customer_feedback',
    templateName: 'Customer Feedback',
    category: 'feedback',
    description: 'Asks for a 1-5 rating after a completed service. The reply is stored on the lead automatically.',
    trigger: 'service_completed',
    messageType: 'text',
    priority: 85,
    message: `Hi {{first_name}}!

We'd love to know about your experience with {{business_name}}.

How would you rate your experience from 1 to 5?

1 - Poor
2 - Fair
3 - Good
4 - Very Good
5 - Excellent

You can also send us a message with any feedback.`,
  },
  // Supporting templates. Not in the twelve-template pack, but the pipeline needs these
  // two messages and they must be admin-editable like everything else rather than
  // hardcoded in the webhook path.
  {
    templateKey: 'outside_business_hours',
    templateName: 'Outside Business Hours',
    category: 'other',
    description: 'Auto-reply when a message arrives outside the configured business hours.',
    trigger: 'outside_business_hours',
    messageType: 'text',
    priority: 90,
    message: `Thanks for your message, {{first_name}}.

Our team is currently outside business hours, but your enquiry has reached us.

Please share what you need and a good time to call you back — someone from {{business_name}} will reply during business hours.`,
  },
  {
    templateKey: 'service_catalogue',
    templateName: 'Service Catalogue',
    category: 'product_enquiry',
    description: 'The "what we offer" list, built from the active Knowledge Base products and services. Sent once the customer replies and the 24-hour window opens.',
    trigger: 'service_list_due',
    messageType: 'text',
    priority: 35,
    requiredVariables: ['service_list'],
    message: `Here are the products and services most relevant to your enquiry:

{{service_list}}

Tell me which one you'd like to know more about and I'll share the details.`,
  },
  {
    templateKey: 'ai_resumed',
    templateName: 'Back to ARIA',
    category: 'other',
    description: 'Sent when the conversation is handed back from a human agent to ARIA.',
    trigger: 'ai_resumed',
    messageType: 'text',
    priority: 95,
    message: `You're back with ARIA, the {{business_name}} assistant.

I have the full conversation context, so you won't need to repeat anything. How can I help next?`,
  },
];

export type AriaAutomationSeed = {
  automationKey: string;
  name: string;
  description: string;
  trigger: string;
  templateKey?: string;
  actions?: { type: string; config?: Record<string, unknown> }[];
  delay?: { value: number; unit: 'minutes' | 'hours' | 'days' };
  maxAttempts?: number;
  repeatEveryHours?: number;
  stopOn?: string[];
  conditions?: { field: string; operator: string; value?: unknown }[];
  priority?: number;
};

const STOP_ON = ['lead_replied', 'lead_won', 'lead_lost', 'lead_opted_out', 'human_takeover', 'conversation_paused'];

export const ARIA_AUTOMATIONS: AriaAutomationSeed[] = [
  { automationKey: 'aria_welcome', name: 'ARIA — Welcome new WhatsApp lead', description: 'Greets a first-time WhatsApp contact and offers the three most common next steps.', trigger: 'new_whatsapp_lead', templateKey: 'welcome_message', priority: 10 },
  { automationKey: 'aria_qualification', name: 'ARIA — Collect missing qualification details', description: 'Asks only for the qualification fields the lead record is still missing.', trigger: 'lead_requires_qualification', templateKey: 'lead_qualification', priority: 20 },
  { automationKey: 'aria_product_enquiry', name: 'ARIA — Product / service enquiry', description: 'Answers product interest with a knowledge-base item, price and delivery time.', trigger: 'product_or_service_interest', templateKey: 'product_service_enquiry', priority: 30 },
  { automationKey: 'aria_appointment', name: 'ARIA — Demo / appointment booking', description: 'Collects a preferred slot and raises a CRM activity for the salesperson.', trigger: 'appointment_requested', templateKey: 'appointment_booking', priority: 40, actions: [{ type: 'send_template' }, { type: 'create_activity', config: { kind: 'Meeting', dueInHours: 24 } }] },
  {
    automationKey: 'aria_human_handoff', name: 'ARIA — Human agent handoff', trigger: 'human_agent_requested', templateKey: 'human_handoff', priority: 15,
    description: 'Confirms the transfer, pauses ARIA, cancels pending follow-ups and notifies the assigned agent.',
    actions: [{ type: 'send_template' }, { type: 'pause_ai', config: { pauseFollowUps: true } }, { type: 'stop_followups' }, { type: 'notify_agent', config: { title: 'WhatsApp handoff requested' } }],
  },
  { automationKey: 'aria_ai_resumed', name: 'ARIA — Conversation returned to AI', description: 'Confirms to the customer that ARIA is handling the conversation again.', trigger: 'ai_resumed', templateKey: 'ai_resumed', priority: 95, actions: [{ type: 'resume_ai' }, { type: 'send_template' }] },
  { automationKey: 'aria_outside_hours', name: 'ARIA — Outside business hours reply', description: 'Acknowledges a message received while the business is closed.', trigger: 'outside_business_hours', templateKey: 'outside_business_hours', priority: 90 },
  { automationKey: 'aria_quotation_ready', name: 'ARIA — Quotation ready', description: 'Sends the quotation summary and link when a quote is created in the CRM.', trigger: 'quotation_created', templateKey: 'quotation_ready', priority: 50 },
  {
    automationKey: 'aria_no_response_follow_up', name: 'ARIA — No-response follow-up', trigger: 'lead_no_response', templateKey: 'no_response_follow_up', priority: 60,
    description: 'Follows up a quiet lead after 24 hours, up to three times, 48 hours apart.',
    delay: { value: 24, unit: 'hours' }, maxAttempts: 3, repeatEveryHours: 48, stopOn: STOP_ON,
  },
  {
    automationKey: 'aria_hot_lead_alert', name: 'ARIA — Internal hot lead alert', trigger: 'lead_score_threshold_reached', templateKey: 'hot_lead_alert', priority: 5,
    description: 'Alerts the assigned salesperson (never the customer) when a lead turns hot.',
  },
  { automationKey: 'aria_payment_reminder', name: 'ARIA — Payment reminder', description: 'Reminds the customer about a pending invoice.', trigger: 'payment_due', templateKey: 'payment_reminder', priority: 70 },
  { automationKey: 'aria_payment_confirmation', name: 'ARIA — Payment confirmation', description: 'Confirms a payment the provider has already verified.', trigger: 'payment_successful', templateKey: 'payment_confirmation', priority: 75 },
  { automationKey: 'aria_order_status', name: 'ARIA — Order / project status update', description: 'Tells the customer when their order or project status changes.', trigger: 'status_changed', templateKey: 'order_project_status', priority: 80 },
  { automationKey: 'aria_customer_feedback', name: 'ARIA — Customer feedback request', description: 'Asks for a 1-5 rating once a service is completed.', trigger: 'service_completed', templateKey: 'customer_feedback', priority: 85 },
  {
    automationKey: 'aria_not_interested', name: 'ARIA — Lead not interested', trigger: 'lead_not_interested', priority: 100,
    description: 'Stops every follow-up and marks the lead lost when the customer opts out.',
    actions: [{ type: 'stop_followups' }, { type: 'set_pipeline_stage', config: { stage: 'lost' } }],
  },
];

/** Every ARIA template key, used by the migration to tell ARIA rows from custom ones. */
export const ARIA_TEMPLATE_KEYS = ARIA_TEMPLATES.map(template => template.templateKey);
export const ARIA_AUTOMATION_KEYS = ARIA_AUTOMATIONS.map(automation => automation.automationKey);

/** Turns a seed definition into the document shape, deriving `variables` from the body. */
export const toTemplateDocument = (seed: AriaTemplateSeed) => ({
  templateName: seed.templateName,
  templateKey: seed.templateKey,
  category: seed.category,
  description: seed.description,
  trigger: seed.trigger,
  messageType: seed.messageType,
  message: seed.message,
  variables: extractVariables(seed.message),
  requiredVariables: seed.requiredVariables ?? [],
  buttons: seed.buttons ?? [],
  askMode: seed.askMode ?? false,
  internalOnly: seed.internalOnly ?? seed.messageType === 'internal',
  aiEnabled: seed.aiEnabled ?? false,
  priority: seed.priority ?? 100,
  conditions: [],
  delay: { value: 0, unit: 'minutes' as const },
  status: 'active' as const,
  source: 'aria' as const,
  isSystem: true,
});
