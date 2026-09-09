// The one and only place {{variables}} are resolved and substituted. Every automation,
// template preview and test send calls through here, so a variable behaves identically
// wherever it appears and there is a single place to add a new one.
import { Product, Service, User } from '../models/index.js';

export type VariableDefinition = { name: string; label: string; group: string; sample: string };

// Shown in the template editor beside the message box; clicking one inserts it.
export const AVAILABLE_VARIABLES: VariableDefinition[] = [
  { name: 'first_name', label: 'Customer first name', group: 'Contact', sample: 'Rahul' },
  { name: 'name', label: 'Customer full name', group: 'Contact', sample: 'Rahul Sharma' },
  { name: 'lead_name', label: 'Lead name', group: 'Contact', sample: 'Rahul Sharma' },
  { name: 'company', label: 'Company / business', group: 'Contact', sample: 'Northstar Labs' },
  { name: 'email', label: 'Email address', group: 'Contact', sample: 'rahul@example.com' },
  { name: 'phone', label: 'Phone number', group: 'Contact', sample: '+91 98765 43210' },
  { name: 'business_name', label: 'Your business name', group: 'Company', sample: 'Orbit CRM' },
  { name: 'agent_name', label: 'Assigned human agent', group: 'Company', sample: 'Maya Patel' },
  { name: 'sales_rep_name', label: 'Sales representative', group: 'Company', sample: 'Maya Patel' },
  { name: 'interest', label: 'Stated interest', group: 'Qualification', sample: 'CRM for real estate' },
  { name: 'budget', label: 'Budget range', group: 'Qualification', sample: '1.5 lakh' },
  { name: 'timeline', label: 'Expected timeline', group: 'Qualification', sample: 'within 30 days' },
  { name: 'lead_score', label: 'AI lead score', group: 'Qualification', sample: '86' },
  { name: 'qualification_reason', label: 'Why the lead qualified', group: 'Qualification', sample: 'Requested a quotation with a 2-week timeline' },
  { name: 'product', label: 'Product of interest', group: 'Catalogue', sample: 'Property Listing Portal' },
  { name: 'product_name', label: 'Product / service name', group: 'Catalogue', sample: 'Business Website' },
  { name: 'recommended_product', label: 'Recommended product', group: 'Catalogue', sample: 'E-commerce Store' },
  { name: 'price', label: 'Starting price', group: 'Catalogue', sample: '₹25,000' },
  { name: 'key_benefit', label: 'Key benefit', group: 'Catalogue', sample: 'Live in 2-3 weeks' },
  { name: 'delivery_time', label: 'Delivery / setup time', group: 'Catalogue', sample: '2-3 weeks' },
  { name: 'appointment_date', label: 'Appointment date', group: 'Appointment', sample: '12 March' },
  { name: 'appointment_time', label: 'Appointment time', group: 'Appointment', sample: '3:00 PM' },
  { name: 'quote_number', label: 'Quotation number', group: 'Quotation', sample: 'QT-1042' },
  { name: 'quote_amount', label: 'Quotation amount', group: 'Quotation', sample: '₹1,25,000' },
  { name: 'expiry_date', label: 'Quotation valid until', group: 'Quotation', sample: '30 March' },
  { name: 'quotation_link', label: 'Quotation link', group: 'Quotation', sample: 'https://example.com/q/1042' },
  { name: 'invoice_number', label: 'Invoice number', group: 'Payment', sample: 'INV-2231' },
  { name: 'amount', label: 'Amount', group: 'Payment', sample: '₹62,500' },
  { name: 'due_date', label: 'Due date', group: 'Payment', sample: '18 March' },
  { name: 'payment_link', label: 'Payment link', group: 'Payment', sample: 'https://example.com/pay/2231' },
  { name: 'payment_id', label: 'Payment id', group: 'Payment', sample: 'pay_Nx82Kd' },
  { name: 'payment_date', label: 'Payment date', group: 'Payment', sample: '14 March' },
  { name: 'order_or_project', label: 'Order or project label', group: 'Status', sample: 'website project' },
  { name: 'status', label: 'Current status', group: 'Status', sample: 'In progress' },
  { name: 'stage', label: 'Current stage', group: 'Status', sample: 'Design review' },
  { name: 'expected_date', label: 'Expected completion', group: 'Status', sample: '28 March' },
  { name: 'service_list', label: 'Knowledge Base catalogue', group: 'Catalogue', sample: '• Business Website — from ₹25,000' },
];

export const VARIABLE_NAMES = AVAILABLE_VARIABLES.map(variable => variable.name);

// Safe fallbacks, so a missing value degrades to natural wording rather than either a
// literal "{{first_name}}" or an abrupt "Hi ,".
const FALLBACKS: Record<string, string> = {
  first_name: 'there',
  name: 'there',
  lead_name: 'there',
  agent_name: 'our team',
  sales_rep_name: 'our team',
};

export type VariableContext = {
  lead?: any;
  contact?: any;
  conversation?: any;
  config?: any;
  agent?: any;
  product?: any;
  /** Explicit values from the caller (quotation, payment, status…). Always win. */
  data?: Record<string, unknown>;
};

const money = (price?: number, currency = 'INR') =>
  (typeof price === 'number' ? new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 }).format(price) : '');

const firstName = (full?: string) => (full ?? '').trim().split(/\s+/)[0] ?? '';
const list = (values?: unknown): string => (Array.isArray(values) ? values.filter(Boolean).join(', ') : '');
const text = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }).format(value);
  return String(value).trim();
};

// Picks the catalogue item the message should talk about: whatever the caller passed,
// otherwise the first active product/service matching the lead's stated interest. Never
// invents a product — if the catalogue is empty the product variables stay unresolved and
// the lines that mention them are dropped.
async function resolveProduct(context: VariableContext) {
  if (context.product) return context.product;
  const interest = list(context.lead?.productInterest) || list(context.lead?.requirements);
  if (!interest) return null;
  const [product, service] = await Promise.all([
    Product.findOne({ active: true, $text: { $search: interest } }).lean().catch(() => null),
    Service.findOne({ active: true, $text: { $search: interest } }).lean().catch(() => null),
  ]);
  return product ?? service ?? null;
}

async function resolveAgent(context: VariableContext) {
  if (context.agent) return context.agent;
  const id = context.conversation?.assignedTo ?? context.lead?.salesperson;
  if (!id) return null;
  if (typeof id === 'object' && 'name' in id) return id;
  return User.findById(id).select('name email').lean().catch(() => null);
}

/** Builds the full {{variable}} → value map for one automation run. */
export async function resolveVariables(context: VariableContext): Promise<Record<string, string>> {
  const { lead, contact, conversation, config } = context;
  const [product, agent] = await Promise.all([resolveProduct(context), resolveAgent(context)]);

  const fullName = text(lead?.contactName) || text(contact?.name) || text(conversation?.customerName);
  const agentName = text(agent?.name);
  const productName = text(product?.name);

  const values: Record<string, string> = {
    first_name: firstName(fullName),
    name: fullName,
    lead_name: fullName,
    company: text(lead?.companyName) || text(contact?.company?.name),
    email: text(lead?.email) || text(contact?.email),
    phone: text(lead?.phone) || text(contact?.phone) || text(conversation?.phoneNumber),
    business_name: text(config?.companyName),
    agent_name: agentName,
    sales_rep_name: agentName,
    // Never falls back to lead.customerIntent — that holds an internal enum
    // ("PRICING_REQUEST"), and internal CRM vocabulary must not reach a customer.
    interest: list(lead?.productInterest) || list(lead?.requirements),
    budget: text(lead?.budget),
    timeline: text(lead?.purchaseTimeline),
    lead_score: lead?.leadScore != null ? String(lead.leadScore) : '',
    qualification_reason: text(lead?.qualificationReason) || text(lead?.recommendedNextAction),
    product: productName || list(lead?.productInterest),
    product_name: productName,
    recommended_product: productName,
    price: product?.price != null ? `${product.priceType === 'starting_at' ? 'from ' : ''}${money(product.price, product.currency)}` : '',
    key_benefit: text(product?.description).split(/[.\n]/)[0] ?? '',
    delivery_time: text(product?.duration),
    // Appointment, quotation, payment and status values have no CRM home of their own yet;
    // they arrive from whoever fires the trigger (see `data` below).
    appointment_date: '', appointment_time: '',
    quote_number: '', quote_amount: '', expiry_date: '', quotation_link: '',
    invoice_number: '', amount: '', due_date: '', payment_link: '', payment_id: '', payment_date: '',
    order_or_project: '', status: text(lead?.qualificationStatus), stage: '', expected_date: '',
    service_list: '',
  };

  for (const [key, value] of Object.entries(context.data ?? {})) {
    const resolved = text(value);
    if (resolved) values[key] = resolved;
  }
  return values;
}

export type RenderResult = { text: string; missing: string[]; blocked: boolean };

const TOKEN = /\{\{\s*([a-z0-9_]+)\s*\}\}/gi;
// A line that is nothing but a label once its variable dropped out ("Budget range:",
// "• {{price}}") carries no information, so it is removed rather than sent empty.
const LABEL_ONLY = /^[\s\-•*]*[A-Za-z0-9 /()&.'’—-]*:?\s*$/;

/** Extracts every {{variable}} used by a message body, in order of first appearance. */
export function extractVariables(message: string): string[] {
  return [...new Set([...message.matchAll(TOKEN)].map(match => match[1]!.toLowerCase()))];
}

/**
 * Substitutes values into a template body.
 *
 * Unresolved variables never reach the customer: a line whose only content was the
 * variable is dropped, anything with a safe fallback uses it, and a template that
 * declares a variable as required is blocked from sending entirely.
 *
 * `askMode` inverts that for information-request templates ("Budget range: {{budget}}"):
 * there the variable marks something ARIA wants the customer to supply, so a line is kept
 * — minus its placeholder — precisely when the value is *not* yet known, and dropped once
 * the CRM has it. That is what stops ARIA re-asking questions the lead already answered.
 */
export function renderTemplate(message: string, values: Record<string, string>, required: string[] = [], askMode = false): RenderResult {
  const missing = new Set<string>();
  const lines = message.split('\n').map(line => {
    const tokens = [...line.matchAll(TOKEN)].map(match => match[1]!.toLowerCase());
    for (const name of tokens) if (!(values[name] ?? '').trim()) missing.add(name);

    if (askMode && tokens.length) {
      // Every value on this line is already known — nothing left to ask for.
      if (tokens.every(name => (values[name] ?? '').trim())) return null;
      return line.replace(TOKEN, '').replace(/[ \t]+$/, '');
    }

    let droppedHere = false;
    const rendered = line.replace(TOKEN, (_match, rawName: string) => {
      const name = rawName.toLowerCase();
      const value = (values[name] ?? '').trim();
      if (value) return value;
      const fallback = FALLBACKS[name];
      if (fallback) return fallback;
      droppedHere = true;
      return '';
    });
    return droppedHere && LABEL_ONLY.test(rendered) ? null : rendered;
  });

  const body = lines.filter(line => line !== null).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const missingList = [...missing];
  return {
    text: body,
    missing: missingList,
    blocked: required.some(name => missingList.includes(name.toLowerCase())),
  };
}
