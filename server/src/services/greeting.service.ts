import mongoose from 'mongoose';
import { Lead, Product, Service, WhatsAppConversation, WhatsAppTemplate } from '../models/index.js';
import { getActiveAIConfig } from './ai.service.js';
import { sendTemplateMessage } from './whatsapp.service.js';
import { appendMessage, identifyOrCreateForPhone } from './conversation.service.js';
import { sendTemplateByKey } from '../automation/automation.service.js';
import { normalizePhone } from '../utils/phone.js';

const money = (price?: number, currency = 'INR') =>
  (typeof price === 'number' ? new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 }).format(price) : undefined);

// Builds the catalogue lines from the knowledge base, so what ARIA lists always matches
// what it is allowed to quote — no second list to keep in sync. The surrounding wording
// lives in the `service_catalogue` automation template, not here.
export async function buildServiceCatalogue(): Promise<string | null> {
  const [services, products] = await Promise.all([
    Service.find({ active: true }).limit(10).lean(),
    Product.find({ active: true }).limit(10).lean(),
  ]);
  const items = [...services, ...products];
  if (!items.length) return null;

  return items.map(item => {
    const price = item.price != null ? ` — ${(item as any).priceType === 'starting_at' ? 'from ' : ''}${money(item.price, item.currency ?? 'INR')}` : '';
    const link = (item as any).link ? `\n  ${(item as any).link}` : '';
    return `• *${item.name}*${price}${link}`;
  }).join('\n');
}

// Business-initiated, so it must be an approved template — WhatsApp rejects free-form text
// to someone who hasn't messaged first. Returns null when auto-greeting is off or the lead
// has no usable phone number, rather than throwing into the caller's request.
export async function greetNewLead(leadId: mongoose.Types.ObjectId | string, actorId?: mongoose.Types.ObjectId) {
  const config = await getActiveAIConfig();
  if (!config.autoGreetNewLeads || !config.autoGreetTemplate) return null;

  const lead = await Lead.findById(leadId);
  if (!lead?.phone) return null;
  const digits = normalizePhone(lead.phone);
  if (digits.length < 8) return null;

  const template = await WhatsAppTemplate.findById(config.autoGreetTemplate);
  if (!template || template.status !== 'APPROVED') {
    console.warn('[greeting] auto-greet template missing or not approved — skipping');
    return null;
  }

  const { conversation } = await identifyOrCreateForPhone(digits, lead.contactName ?? undefined);
  if (conversation.greetedAt) return null; // never greet the same conversation twice

  // A {{1}} placeholder is filled with the lead's name; templates without variables send as-is.
  const variables = /\{\{1\}\}/.test(template.body) ? [lead.contactName || 'there'] : [];
  const components = variables.length ? [{ type: 'body', parameters: variables.map(text => ({ type: 'text', text })) }] : [];
  const result = await sendTemplateMessage(digits, template.templateName, template.language ?? 'en_US', components);

  await appendMessage({
    conversation, direction: 'OUTBOUND', type: 'template', templateName: template.templateName,
    text: `[template: ${template.templateName}] ${template.body}`, aiGenerated: true, sentBy: actorId,
    status: result.ok ? 'SENT' : 'FAILED', whatsappMessageId: result.whatsappMessageId,
  });
  await WhatsAppConversation.updateOne({ _id: conversation._id }, { greetedAt: new Date() });
  return { ok: result.ok, error: result.error, conversation: conversation._id };
}

// Sent on the customer's first reply, when the 24-hour service window is open and free-form
// text (with links) is finally permitted.
export async function sendServiceCatalogue(conversation: InstanceType<typeof WhatsAppConversation>) {
  const config = await getActiveAIConfig();
  if (!config.sendServiceListOnReply || conversation.serviceListSentAt) return null;

  const serviceList = await buildServiceCatalogue();
  if (!serviceList) return null;

  const result = await sendTemplateByKey('service_catalogue', {
    conversation, lead: conversation.lead, trigger: 'service_list_due', data: { service_list: serviceList },
  });
  if (result.status === 'completed') await WhatsAppConversation.updateOne({ _id: conversation._id }, { serviceListSentAt: new Date() });
  return result;
}
