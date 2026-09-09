// The catalogue of events an automation can listen for. Everything that fires an
// automation goes through `TRIGGERS`, so the admin UI's trigger picker and the engine
// can never drift apart, and an unknown trigger is rejected at validation time rather
// than silently never firing.

export type TriggerScope = 'customer' | 'internal' | 'system';

export type TriggerDefinition = {
  key: string;
  label: string;
  description: string;
  scope: TriggerScope;
  /** Variables that are normally available when this trigger fires. Shown in the editor. */
  suggests: string[];
};

export const TRIGGERS: TriggerDefinition[] = [
  { key: 'new_whatsapp_lead', label: 'New WhatsApp lead', description: 'A phone number with no existing conversation sends its first message.', scope: 'customer', suggests: ['first_name', 'business_name'] },
  { key: 'lead_requires_qualification', label: 'Lead requires qualification', description: 'ARIA detected buying intent but the CRM is still missing qualification fields.', scope: 'customer', suggests: ['name', 'company', 'email', 'interest', 'budget', 'timeline'] },
  { key: 'product_or_service_interest', label: 'Product / service interest', description: 'The lead asked about a product, service, feature or price.', scope: 'customer', suggests: ['first_name', 'recommended_product', 'product_name', 'price', 'key_benefit', 'delivery_time'] },
  { key: 'appointment_requested', label: 'Appointment or demo requested', description: 'The lead asked for a demo, meeting, consultation or callback.', scope: 'customer', suggests: ['appointment_date', 'appointment_time', 'sales_rep_name'] },
  { key: 'human_agent_requested', label: 'Human agent requested', description: 'The customer asked for a person, or ARIA decided a human is required.', scope: 'customer', suggests: ['first_name', 'agent_name'] },
  { key: 'ai_resumed', label: 'AI resumed', description: 'The conversation was handed back from a human to ARIA.', scope: 'customer', suggests: ['first_name'] },
  { key: 'outside_business_hours', label: 'Outside business hours', description: 'A message arrived when the configured business hours are closed.', scope: 'customer', suggests: ['first_name', 'business_name'] },
  { key: 'quotation_created', label: 'Quotation created', description: 'A quotation was generated in the CRM for this lead.', scope: 'customer', suggests: ['quote_number', 'product_name', 'quote_amount', 'expiry_date', 'quotation_link'] },
  { key: 'lead_no_response', label: 'Lead did not respond', description: 'The lead has not replied for the automation’s configured delay.', scope: 'customer', suggests: ['first_name', 'product_name'] },
  { key: 'lead_score_threshold_reached', label: 'Lead score threshold reached', description: 'The lead score crossed the hot-lead threshold.', scope: 'internal', suggests: ['lead_name', 'phone', 'company', 'product', 'budget', 'timeline', 'lead_score', 'qualification_reason'] },
  { key: 'payment_due', label: 'Payment due', description: 'An invoice is pending and reached its reminder condition.', scope: 'customer', suggests: ['invoice_number', 'amount', 'due_date', 'payment_link'] },
  { key: 'payment_successful', label: 'Payment successful', description: 'The payment provider confirmed a successful payment.', scope: 'customer', suggests: ['payment_id', 'amount', 'payment_date'] },
  { key: 'status_changed', label: 'Order / project status changed', description: 'An order, project or service status was updated.', scope: 'customer', suggests: ['order_or_project', 'status', 'stage', 'expected_date'] },
  { key: 'service_completed', label: 'Service completed', description: 'An order, appointment, service or project was completed.', scope: 'customer', suggests: ['first_name', 'business_name'] },
  { key: 'lead_not_interested', label: 'Lead not interested', description: 'The lead opted out or said they are not interested.', scope: 'system', suggests: ['first_name'] },
  { key: 'service_list_due', label: 'Service list due', description: 'The lead replied to a business-initiated greeting, opening the 24-hour window in which the catalogue may be sent.', scope: 'customer', suggests: ['service_list', 'first_name'] },
];

export const TRIGGER_KEYS = TRIGGERS.map(trigger => trigger.key);
export const isKnownTrigger = (key: string) => TRIGGER_KEYS.includes(key);
export const triggerDefinition = (key: string) => TRIGGERS.find(trigger => trigger.key === key);

// ARIA's intent vocabulary (spec §3) and how a detected intent maps onto a trigger.
// Intents with no automation of their own (greeting, support, unknown) map to null and
// are answered by the AI reply itself.
export const ARIA_INTENTS = [
  'greeting', 'product_enquiry', 'pricing', 'quotation', 'demo_request', 'appointment_request',
  'purchase_interest', 'support', 'payment', 'order_status', 'complaint', 'human_agent',
  'follow_up', 'not_interested', 'unknown',
] as const;
export type AriaIntent = (typeof ARIA_INTENTS)[number];

export const INTENT_TRIGGER: Record<AriaIntent, string | null> = {
  greeting: null,
  product_enquiry: 'product_or_service_interest',
  pricing: 'product_or_service_interest',
  quotation: 'product_or_service_interest',
  demo_request: 'appointment_requested',
  appointment_request: 'appointment_requested',
  purchase_interest: null,
  support: null,
  payment: null,
  order_status: null,
  complaint: null,
  human_agent: 'human_agent_requested',
  follow_up: null,
  not_interested: 'lead_not_interested',
  unknown: null,
};
