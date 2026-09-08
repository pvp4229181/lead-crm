import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { AIConversationSummary, Contact, Lead, User, WhatsAppConversation, WhatsAppMessage, WhatsAppTemplate } from '../models/index.js';
import { ApiError, escapeRegex } from '../utils/http.js';
import { appendMessage, buildTranscript, identifyOrCreateForPhone, markConversationRead, recentHistory } from '../services/conversation.service.js';
import { sendTemplateMessage, sendTextMessage, streamMedia } from '../services/whatsapp.service.js';
import { generateAgentReply } from '../services/ai.service.js';
import { conversationListQuery, sendMessageInput, sendTemplateInput } from '../validators/whatsapp.validators.js';
import { normalizePhone } from '../utils/phone.js';
import { accessScope } from '../middleware/auth.js';
import { emitToConversation } from '../realtime.js';

// Reuses the CRM's own lead visibility rules so a Salesperson cannot message a lead
// that isn't theirs.
const leadScope = (req: Request) => accessScope(req);

const leadFields = 'title contactName companyName email phone expectedRevenue priority salesperson leadScore leadTemperature qualificationStatus customerIntent budget purchaseTimeline quantity requirements painPoints objections productInterest aiSummary recommendedNextAction salesProbability lastAiAnalysisAt status converted convertedOpportunity tags source createdAt';

// Salespersons only see conversations assigned to them or tied to their own leads;
// Administrators and Sales Managers see everything. Mirrors accessScope's shape for CRM records.
// Returned under $and (not a bare $or) so a caller adding its own $or — the search filter
// in listConversations does exactly that — cannot silently overwrite the access check.
async function conversationScope(req: Request) {
  const role = (req.user!.role as any)?.name;
  if (role === 'Administrator' || role === 'Sales Manager') return {};
  const myLeadIds = await Lead.find({ salesperson: req.user!._id }).select('_id').lean();
  return { $and: [{ $or: [{ assignedTo: req.user!._id }, { lead: { $in: myLeadIds.map(l => l._id) } }] }] };
}

// Loads a conversation the caller is actually allowed to see, or throws 404.
async function scopedConversation(req: Request, id: string) {
  const scope = await conversationScope(req);
  const conversation = await WhatsAppConversation.findOne({ _id: id, ...scope });
  if (!conversation) throw new ApiError(404, 'Conversation not found');
  return conversation;
}

export async function listConversations(req: Request, res: Response) {
  const q = conversationListQuery.parse(req.query);
  const scope = await conversationScope(req);
  const filter: any = { ...scope, archived: q.filter === 'archived' };
  if (q.filter === 'unread') filter.unreadCount = { $gt: 0 };
  if (q.filter === 'ai') filter.controlStatus = 'AI_ACTIVE';
  if (q.filter === 'human') filter.controlStatus = { $in: ['HUMAN_ACTIVE', 'WAITING_HUMAN'] };
  if (q.assignedTo) filter.assignedTo = q.assignedTo;
  if (q.filter === 'hot') { /* joined below via lead temperature */ }

  let leadFilterIds: mongoose.Types.ObjectId[] | undefined;
  if (q.filter === 'hot' || q.search) {
    const leadMatch: any = q.filter === 'hot' ? { leadTemperature: { $in: ['Hot', 'Very Hot'] } } : {};
    if (q.search) Object.assign(leadMatch, { $or: ['title', 'contactName', 'companyName', 'email', 'phone'].map(k => ({ [k]: new RegExp(escapeRegex(q.search!), 'i') })) });
    const leads = await Lead.find(leadMatch).select('_id').lean();
    leadFilterIds = leads.map(l => l._id);
  }
  if (q.filter === 'hot') filter.lead = { $in: leadFilterIds };
  if (q.search) filter.$or = [{ customerName: new RegExp(escapeRegex(q.search), 'i') }, { phoneNumber: new RegExp(escapeRegex(q.search), 'i') }, ...(leadFilterIds?.length ? [{ lead: { $in: leadFilterIds } }] : [])];

  const skip = (q.page - 1) * q.limit;
  const [data, total] = await Promise.all([
    WhatsAppConversation.find(filter).populate('lead', leadFields).populate('contact', 'name email').populate('assignedTo', 'name avatar').populate('tags', 'name color').sort('-lastMessageAt').skip(skip).limit(q.limit),
    WhatsAppConversation.countDocuments(filter),
  ]);
  res.json({ data, pagination: { page: q.page, limit: q.limit, total, pages: Math.ceil(total / q.limit) } });
}

export async function getConversation(req: Request, res: Response) {
  const scope = await conversationScope(req);
  const conversation = await WhatsAppConversation.findOne({ _id: req.params.id, ...scope }).populate('lead', leadFields).populate('contact').populate('assignedTo', 'name avatar').populate('tags', 'name color');
  if (!conversation) throw new ApiError(404, 'Conversation not found');
  const messages = await WhatsAppMessage.find({ conversation: conversation._id }).sort('-timestamp').limit(50);
  res.json({ conversation, messages: messages.reverse() });
}

// GET /whatsapp/conversations/:id/messages — `before` pages backwards through history.
export async function listMessages(req: Request, res: Response) {
  const conversation = await scopedConversation(req, String(req.params.id));
  const before = req.query.before ? new Date(String(req.query.before)) : undefined;
  const limit = Math.min(100, Number(req.query.limit ?? 50));
  const filter: any = { conversation: conversation._id };
  if (before) filter.timestamp = { $lt: before };
  const messages = await WhatsAppMessage.find(filter).sort('-timestamp').limit(limit);
  res.json(messages.reverse());
}

// Removes one message from the CRM copy of a conversation. Meta does not expose a
// general delete-for-everyone API, so this deliberately does not claim to remove the
// message from either participant's phone. Keep the conversation's list preview in
// sync when its newest message (or newest inbound message) is deleted.
export async function deleteMessage(req: Request, res: Response) {
  const conversation = await scopedConversation(req, String(req.params.id));
  const message = await WhatsAppMessage.findOne({ _id: req.params.messageId, conversation: conversation._id });
  if (!message) throw new ApiError(404, 'Message not found');

  await message.deleteOne();

  const [latest, latestInbound] = await Promise.all([
    WhatsAppMessage.findOne({ conversation: conversation._id }).sort({ timestamp: -1, _id: -1 }).lean(),
    WhatsAppMessage.findOne({ conversation: conversation._id, direction: 'INBOUND' }).sort({ timestamp: -1, _id: -1 }).select('timestamp').lean(),
  ]);
  const update: { $set?: Record<string, unknown>; $unset?: Record<string, 1> } = {};
  if (latest) {
    update.$set = {
      lastMessage: latest.text?.slice(0, 120) ?? (latest.type !== 'text' ? `[${latest.type}]` : ''),
      lastMessageAt: latest.timestamp,
    };
  } else {
    update.$unset = { lastMessage: 1, lastMessageAt: 1 };
  }
  if (latestInbound) {
    update.$set = { ...(update.$set ?? {}), lastInboundAt: latestInbound.timestamp };
  } else {
    update.$unset = { ...(update.$unset ?? {}), lastInboundAt: 1 };
  }
  await WhatsAppConversation.updateOne({ _id: conversation._id }, update);

  emitToConversation(String(conversation._id), 'message:deleted', { messageId: String(message._id) });
  emitToConversation(String(conversation._id), 'conversation:updated', {});
  res.status(204).end();
}

export async function getMedia(req: Request, res: Response) {
  const message = await WhatsAppMessage.findById(req.params.id);
  if (!message?.mediaId) throw new ApiError(404, 'Media not found');
  // Media is fetched with our own Meta credentials, so the caller must be entitled to
  // the conversation it belongs to — otherwise any signed-in user could read any file.
  await scopedConversation(req, String(message.conversation));
  const { resolveMediaUrl } = await import('../services/whatsapp.service.js');
  const resolved = await resolveMediaUrl(message.mediaId);
  if (!resolved) throw new ApiError(502, 'Media is not available from WhatsApp right now');
  const upstream = await streamMedia(resolved.url);
  if (!upstream?.body) throw new ApiError(502, 'Media is not available from WhatsApp right now');
  res.setHeader('Content-Type', resolved.mimeType ?? message.mediaMimeType ?? 'application/octet-stream');
  const { Readable } = await import('node:stream');
  Readable.fromWeb(upstream.body as any).pipe(res);
}

export async function sendMessage(req: Request, res: Response) {
  const input = sendMessageInput.parse(req.body);
  const conversation = await scopedConversation(req, String(req.params.id));
  const result = await sendTextMessage(conversation.phoneNumber, input.text);
  const message = await appendMessage({ conversation, direction: 'OUTBOUND', text: input.text, aiGenerated: false, sentBy: req.user!._id, status: result.ok ? 'SENT' : 'FAILED', whatsappMessageId: result.whatsappMessageId });
  if (!result.ok) throw new ApiError(502, result.error ?? 'Failed to send WhatsApp message');
  res.status(201).json(message);
}

// POST /whatsapp/send — start (or re-open) a conversation with a lead.
// WhatsApp forbids business-initiated free-form messages, so this always sends an approved
// template; the reply that comes back opens the 24-hour window the normal composer needs.
export async function sendTemplate(req: Request, res: Response) {
  const input = sendTemplateInput.parse(req.body);

  let phone = input.phone;
  let leadDoc = null;
  if (input.lead) {
    leadDoc = await Lead.findOne({ _id: input.lead, ...leadScope(req) });
    if (!leadDoc) throw new ApiError(404, 'Lead not found');
    phone = leadDoc.phone ?? undefined;
  }
  if (!phone) throw new ApiError(422, 'This lead has no phone number to message');

  let templateName = input.templateName;
  let language = input.language ?? 'en_US';
  if (input.template) {
    const template = await WhatsAppTemplate.findById(input.template);
    if (!template) throw new ApiError(404, 'Template not found');
    if (template.status !== 'APPROVED') throw new ApiError(422, 'This template is not marked approved yet');
    templateName = template.templateName;
    language = template.language ?? language;
  }

  // Opting a contact out must actually block outbound sends, not just campaigns.
  const digits = normalizePhone(phone);
  const contact = await Contact.findOne({ $or: [{ whatsappId: digits }, { phone: new RegExp(`${digits}$`) }] }).select('whatsappOptIn name');
  if (contact && contact.whatsappOptIn === false) throw new ApiError(409, `${contact.name} has opted out of WhatsApp messages`);

  const components = input.variables.length
    ? [{ type: 'body', parameters: input.variables.map(text => ({ type: 'text', text })) }]
    : [];
  const result = await sendTemplateMessage(digits, templateName!, language, components);

  // Record it against a conversation either way, so a failed send is visible in the inbox
  // rather than disappearing into the logs.
  const { conversation } = await identifyOrCreateForPhone(digits, leadDoc?.contactName ?? contact?.name);
  const preview = input.variables.length ? `[template: ${templateName}] ${input.variables.join(' · ')}` : `[template: ${templateName}]`;
  const message = await appendMessage({
    conversation, direction: 'OUTBOUND', type: 'template', text: preview, templateName,
    aiGenerated: false, sentBy: req.user!._id,
    status: result.ok ? 'SENT' : 'FAILED', whatsappMessageId: result.whatsappMessageId,
  });
  if (!result.ok) throw new ApiError(502, result.error ?? 'WhatsApp rejected the template message');
  res.status(201).json({ message, conversation: conversation._id });
}

// AI Suggested Replies: used by the composer while a human is handling the chat.
// Never auto-sent — the salesperson explicitly sends, edits, or regenerates it.
export async function suggestReply(req: Request, res: Response) {
  const conversation = await scopedConversation(req, String(req.params.id));
  const history = await recentHistory(conversation._id, 20);
  const lastInbound = [...history].reverse().find(m => m.direction === 'INBOUND' && m.text);
  // ObjectIds are objects: compare stringified ids, or the last inbound message would be
  // passed twice (once as history, once as the message being answered).
  const chatHistory = history.filter(m => m.text && String(m._id) !== String(lastInbound?._id)).map(m => ({ role: m.direction === 'INBOUND' ? ('user' as const) : ('assistant' as const), content: m.text! }));
  const { text } = await generateAgentReply({ message: lastInbound?.text ?? buildTranscript(history), history: chatHistory, language: conversation.language });
  res.json({ text });
}

export async function setAiEnabled(req: Request, res: Response) {
  const aiEnabled = Boolean(req.body.aiEnabled);
  const existing = await scopedConversation(req, String(req.params.id));
  const conversation = await WhatsAppConversation.findByIdAndUpdate(existing._id, { aiEnabled, controlStatus: aiEnabled ? 'AI_ACTIVE' : 'AI_PAUSED', ...(aiEnabled ? { aiMessageCount: 0 } : {}) }, { new: true });
  emitToConversation(String(existing._id), 'conversation:updated', { conversation: conversation!.toObject() });
  res.json(conversation);
}

export async function takeover(req: Request, res: Response) {
  const existing = await scopedConversation(req, String(req.params.id));
  const conversation = await WhatsAppConversation.findByIdAndUpdate(existing._id, { controlStatus: 'HUMAN_ACTIVE', humanTakeover: true, aiEnabled: false, assignedTo: req.user!._id }, { new: true });
  emitToConversation(String(existing._id), 'conversation:updated', { conversation: conversation!.toObject() });
  res.json(conversation);
}

export async function resumeAi(req: Request, res: Response) {
  const existing = await scopedConversation(req, String(req.params.id));
  const conversation = await WhatsAppConversation.findByIdAndUpdate(existing._id, { controlStatus: 'AI_ACTIVE', humanTakeover: false, aiEnabled: true, aiMessageCount: 0 }, { new: true });
  emitToConversation(String(existing._id), 'conversation:updated', { conversation: conversation!.toObject() });
  res.json(conversation);
}

export async function updateConversation(req: Request, res: Response) {
  const existing = await scopedConversation(req, String(req.params.id));
  const allowed: any = {};
  for (const key of ['assignedTo', 'status', 'archived', 'tags'] as const) if (req.body[key] !== undefined) allowed[key] = req.body[key];
  const conversation = await WhatsAppConversation.findByIdAndUpdate(existing._id, allowed, { new: true, runValidators: true }).populate('assignedTo', 'name avatar').populate('tags', 'name color');
  res.json(conversation);
}

// Permanently removes a chat and everything hanging off it. Archiving is the reversible
// option; this is for wrong numbers, test threads and customer erasure requests, so the
// messages and AI summaries go with it rather than being left orphaned in the database.
// The lead itself is deliberately kept — deleting a chat must not silently destroy CRM
// history. A new inbound message from the same number simply starts a fresh conversation.
export async function deleteConversation(req: Request, res: Response) {
  const conversation = await scopedConversation(req, String(req.params.id));
  await Promise.all([
    WhatsAppMessage.deleteMany({ conversation: conversation._id }),
    AIConversationSummary.deleteMany({ conversation: conversation._id }),
  ]);
  await conversation.deleteOne();
  res.status(204).end();
}

export async function markRead(req: Request, res: Response) {
  const conversation = await scopedConversation(req, String(req.params.id));
  await markConversationRead(String(conversation._id));
  res.json({ success: true });
}

export async function dashboardMetrics(_req: Request, res: Response) {
  const since = new Date(); since.setHours(0, 0, 0, 0);
  // Every CRM lead carries a default qualificationStatus, so these counts must key off
  // the WhatsApp lead source instead — otherwise they report the whole CRM's totals.
  const { LeadSource } = await import('../models/index.js');
  const waSource = await LeadSource.findOne({ name: 'WhatsApp' }).select('_id').lean();
  const waLeadFilter = waSource ? { source: waSource._id } : { _id: null };
  const [newLeads, active, ai, human, hot, handoffs, messagesToday, tempDist] = await Promise.all([
    Lead.countDocuments({ ...waLeadFilter, createdAt: { $gte: since } }),
    WhatsAppConversation.countDocuments({ status: 'open' }),
    WhatsAppConversation.countDocuments({ status: 'open', controlStatus: 'AI_ACTIVE' }),
    WhatsAppConversation.countDocuments({ status: 'open', controlStatus: { $in: ['HUMAN_ACTIVE', 'WAITING_HUMAN'] } }),
    Lead.countDocuments({ ...waLeadFilter, leadTemperature: { $in: ['Hot', 'Very Hot'] } }),
    WhatsAppConversation.countDocuments({ controlStatus: 'WAITING_HUMAN' }),
    WhatsAppMessage.countDocuments({ timestamp: { $gte: since } }),
    Lead.aggregate([{ $match: waLeadFilter }, { $group: { _id: '$leadTemperature', count: { $sum: 1 } } }]),
  ]);
  const byDay = await WhatsAppMessage.aggregate([{ $match: { timestamp: { $gte: new Date(Date.now() - 13 * 86400000) } } }, { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } }, count: { $sum: 1 } } }, { $sort: { _id: 1 } }]);
  const [waTotal, waConverted] = await Promise.all([
    Lead.countDocuments(waLeadFilter),
    Lead.countDocuments({ ...waLeadFilter, $or: [{ converted: true }, { qualificationStatus: 'won' }] }),
  ]);
  // Median-free mean of the gap between each inbound message and the reply that followed it.
  const responsePairs = await WhatsAppMessage.aggregate([
    { $match: { timestamp: { $gte: new Date(Date.now() - 7 * 86400000) } } },
    { $sort: { conversation: 1, timestamp: 1 } },
    { $group: { _id: '$conversation', messages: { $push: { direction: '$direction', timestamp: '$timestamp' } } } },
  ]);
  let totalGapMs = 0, gaps = 0;
  for (const conv of responsePairs) {
    let pendingInbound: Date | null = null;
    for (const message of conv.messages as { direction: string; timestamp: Date }[]) {
      if (message.direction === 'INBOUND') pendingInbound ??= message.timestamp;
      else if (pendingInbound) { totalGapMs += new Date(message.timestamp).getTime() - new Date(pendingInbound).getTime(); gaps += 1; pendingInbound = null; }
    }
  }
  res.json({
    newWhatsAppLeads: newLeads, activeConversations: active, aiConversations: ai, humanConversations: human,
    hotLeads: hot, humanHandoffs: handoffs, messagesToday,
    whatsappConversionRate: waTotal ? Math.round((waConverted / waTotal) * 100) : 0,
    averageResponseTimeMinutes: gaps ? Math.round(totalGapMs / gaps / 60000) : null,
    messagesByDay: byDay, leadTemperature: tempDist,
  });
}
