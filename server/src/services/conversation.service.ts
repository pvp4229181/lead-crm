import mongoose from 'mongoose';
import { Contact, Lead, LeadSource, WhatsAppConversation, WhatsAppMessage } from '../models/index.js';
import { normalizePhone, toE164 } from '../utils/phone.js';
import { ensureSystemUser } from '../utils/systemUser.js';
import { emitToConversation } from '../realtime.js';

export async function ensureWhatsAppLeadSource() {
  return LeadSource.findOneAndUpdate({ name: 'WhatsApp' }, { $setOnInsert: { active: true } }, { new: true, upsert: true });
}

// Step 3-4 of the pipeline: find the Contact/Lead for this phone number, or create
// both. A phone number uniquely identifies one WhatsAppConversation (see the schema's
// unique index), so this doubles as findOrCreateConversation.
export async function identifyOrCreateForPhone(rawPhone: string, profileName?: string) {
  const digits = normalizePhone(rawPhone);
  const phoneRegex = new RegExp(`${digits}$`);

  let contact = await Contact.findOne({ $or: [{ whatsappId: digits }, { phone: phoneRegex }, { mobile: phoneRegex }] });
  let isNewContact = false;
  if (!contact) {
    contact = await Contact.create({ name: profileName || toE164(digits), phone: toE164(digits), whatsappId: digits, whatsappOptIn: true });
    isNewContact = true;
  } else if (!contact.whatsappId) {
    contact.whatsappId = digits; await contact.save();
  }

  let lead = await Lead.findOne({ phone: phoneRegex }).sort('-createdAt');
  let isNewLead = false;
  if (!lead) {
    const source = await ensureWhatsAppLeadSource();
    const systemUserId = await ensureSystemUser();
    // Assigned on creation so hot-lead / handoff / meeting notifications have a real
    // recipient — an unassigned lead would silently drop every salesperson notification.
    const { assignSalespersonRoundRobin } = await import('./lead.service.js');
    const salesperson = await assignSalespersonRoundRobin();
    lead = await Lead.create({
      title: `WhatsApp inquiry — ${profileName || toE164(digits)}`,
      contactName: profileName || undefined,
      phone: toE164(digits),
      source: source._id,
      salesperson,
      status: 'new',
      qualificationStatus: 'new',
      leadTemperature: 'Cold',
      leadScore: 0,
      createdBy: systemUserId,
      updatedBy: systemUserId,
    });
    if (salesperson && !contact.salesperson) { contact.salesperson = salesperson as any; await contact.save(); }
    isNewLead = true;
  }

  let conversation = await WhatsAppConversation.findOne({ phoneNumber: digits });
  let isNewConversation = false;
  if (!conversation) {
    isNewConversation = true;
    conversation = await WhatsAppConversation.create({
      contact: contact._id, lead: lead._id, phoneNumber: digits, customerName: profileName,
      assignedTo: lead.salesperson ?? undefined,
      status: 'open', controlStatus: 'AI_ACTIVE', aiEnabled: true,
    });
  } else {
    let dirty = false;
    if (!conversation.contact) { conversation.contact = contact._id as any; dirty = true; }
    if (!conversation.lead) { conversation.lead = lead._id as any; dirty = true; }
    if (profileName && conversation.customerName !== profileName) { conversation.customerName = profileName; dirty = true; }
    if (dirty) await conversation.save();
  }

  return { contact, lead, conversation, isNewContact, isNewLead, isNewConversation };
}

export type AppendMessageInput = {
  conversation: InstanceType<typeof WhatsAppConversation>;
  direction: 'INBOUND' | 'OUTBOUND';
  type?: string;
  text?: string;
  whatsappMessageId?: string;
  mediaId?: string; mediaUrl?: string; mediaMimeType?: string; caption?: string; filename?: string;
  location?: { lat: number; lng: number; name?: string; address?: string };
  templateName?: string;
  aiGenerated?: boolean;
  sentBy?: mongoose.Types.ObjectId | string;
  status?: string;
  timestamp?: Date;
};

export async function appendMessage(input: AppendMessageInput) {
  const preview = input.text?.slice(0, 120) ?? (input.type && input.type !== 'text' ? `[${input.type}]` : '');
  const message = await WhatsAppMessage.create({
    conversation: input.conversation._id,
    whatsappMessageId: input.whatsappMessageId,
    direction: input.direction,
    type: input.type ?? 'text',
    text: input.text,
    mediaId: input.mediaId, mediaUrl: input.mediaUrl, mediaMimeType: input.mediaMimeType, caption: input.caption, filename: input.filename,
    location: input.location, templateName: input.templateName,
    aiGenerated: Boolean(input.aiGenerated), sentBy: input.sentBy,
    status: input.status ?? (input.direction === 'INBOUND' ? 'DELIVERED' : 'QUEUED'),
    timestamp: input.timestamp ?? new Date(),
  });

  const set: Record<string, unknown> = { lastMessage: preview, lastMessageAt: message.timestamp };
  const inc: Record<string, number> = {};
  if (input.direction === 'INBOUND') { set.lastInboundAt = message.timestamp; inc.unreadCount = 1; }
  if (input.aiGenerated) inc.aiMessageCount = 1;
  await WhatsAppConversation.updateOne({ _id: input.conversation._id }, { $set: set, ...(Object.keys(inc).length ? { $inc: inc } : {}) });

  emitToConversation(String(input.conversation._id), 'message:new', { message: message.toObject() });
  return message;
}

export async function markConversationRead(conversationId: string) {
  await WhatsAppConversation.updateOne({ _id: conversationId }, { unreadCount: 0 });
  emitToConversation(conversationId, 'conversation:read', {});
}

export async function recentHistory(conversationId: mongoose.Types.ObjectId | string, limit = 20) {
  const messages = await WhatsAppMessage.find({ conversation: conversationId, type: { $in: ['text', 'interactive'] } }).sort('-timestamp').limit(limit);
  return messages.reverse();
}

export function buildTranscript(messages: { direction: string; text?: string | null }[]) {
  return messages.filter(m => m.text).map(m => `${m.direction === 'INBOUND' ? 'Customer' : 'Agent'}: ${m.text}`).join('\n');
}
