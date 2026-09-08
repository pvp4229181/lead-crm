import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { Activity, ActivityType, AIConversationSummary, Contact, Lead, TimelineEvent, User, WhatsAppConversation, WhatsAppMessage, WhatsAppTemplate } from '../models/index.js';
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

// Ceiling on the lead ids folded into a conversation search/hot filter (see listConversations).
const LEAD_MATCH_LIMIT = 500;

const leadFields = 'title contactName companyName email phone expectedRevenue priority salesperson leadScore leadTemperature qualificationStatus customerIntent budget purchaseTimeline quantity requirements painPoints objections productInterest aiSummary recommendedNextAction salesProbability lastAiAnalysisAt status converted convertedOpportunity tags source createdAt';

// Salespersons only see conversations assigned to them or tied to their own leads;
// Administrators and Sales Managers see everything. Mirrors accessScope's shape for CRM records.
// Returned under $and (not a bare $or) so a caller adding its own $or — the search filter
// in listConversations does exactly that — cannot silently overwrite the access check.
async function conversationScope(req: Request) {
  const role = (req.user!.role as any)?.name;
  if (role === 'Administrator' || role === 'Sales Manager') return {};
  // distinct() is answered straight from the { salesperson, status, createdAt } index and
  // returns bare ids, instead of hydrating every lead the salesperson owns on each request.
  const myLeadIds = await Lead.distinct('_id', { salesperson: req.user!._id }) as mongoose.Types.ObjectId[];
  return { $and: [{ $or: [{ assignedTo: req.user!._id }, { lead: { $in: myLeadIds } }] }] };
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
    // Bounded: a bare search term used to pull every matching lead id into memory before
    // the conversation query even ran. The cap is generous next to a page of 25 chats.
    leadFilterIds = (await Lead.distinct('_id', leadMatch) as mongoose.Types.ObjectId[]).slice(0, LEAD_MATCH_LIMIT);
  }
  if (q.filter === 'hot') filter.lead = { $in: leadFilterIds };
  if (q.search) filter.$or = [{ customerName: new RegExp(escapeRegex(q.search), 'i') }, { phoneNumber: new RegExp(escapeRegex(q.search), 'i') }, ...(leadFilterIds?.length ? [{ lead: { $in: leadFilterIds } }] : [])];

  const skip = (q.page - 1) * q.limit;
  const [data, total] = await Promise.all([
    WhatsAppConversation.find(filter).populate('lead', leadFields).populate('contact', 'name email').populate('assignedTo', 'name avatar').populate('tags', 'name color').sort('-lastMessageAt').skip(skip).limit(q.limit).lean(),
    WhatsAppConversation.countDocuments(filter),
  ]);
  res.json({ data, pagination: { page: q.page, limit: q.limit, total, pages: Math.ceil(total / q.limit) } });
}

// `?messages=0` returns the conversation alone. The inbox polls this purely to refresh the
// header and lead panel and discards the messages, which were 50 extra documents per poll.
export async function getConversation(req: Request, res: Response) {
  const scope = await conversationScope(req);
  const conversation = await WhatsAppConversation.findOne({ _id: req.params.id, ...scope }).populate('lead', leadFields).populate('contact').populate('assignedTo', 'name avatar').populate('tags', 'name color').lean();
  if (!conversation) throw new ApiError(404, 'Conversation not found');
  if (req.query.messages === '0') return res.json({ conversation, messages: [] });
  const messages = await WhatsAppMessage.find({ conversation: conversation._id }).sort('-timestamp').limit(50).lean();
  res.json({ conversation, messages: messages.reverse() });
}

// GET /whatsapp/conversations/:id/messages — `before` pages backwards through history.
export async function listMessages(req: Request, res: Response) {
  const conversation = await scopedConversation(req, String(req.params.id));
  const before = req.query.before ? new Date(String(req.query.before)) : undefined;
  const limit = Math.min(100, Number(req.query.limit ?? 50));
  const filter: any = { conversation: conversation._id };
  if (before) filter.timestamp = { $lt: before };
  const messages = await WhatsAppMessage.find(filter).sort('-timestamp').limit(limit).lean();
  res.json(messages.reverse());
}

// Soft-deletes one message from the CRM copy of a conversation. Keeping the row lets
// the UI show the same tombstone users expect from WhatsApp, while clearing the actual
// text/media ensures the deleted content is not still retrievable through the API.
// Meta does not expose a general delete-for-everyone API, so neither phone is changed.
export async function deleteMessage(req: Request, res: Response) {
  const conversation = await scopedConversation(req, String(req.params.id));
  const message = await WhatsAppMessage.findOne({ _id: req.params.messageId, conversation: conversation._id });
  if (!message) throw new ApiError(404, 'Message not found');
  if (message.deletedAt) throw new ApiError(409, 'Message is already deleted');

  const deletedAt = new Date();
  const deleted = await WhatsAppMessage.findByIdAndUpdate(message._id, {
    $set: { deletedAt, deletedBy: req.user!._id },
    $unset: { text: 1, mediaId: 1, mediaUrl: 1, mediaMimeType: 1, caption: 1, filename: 1, location: 1, templateName: 1, failReason: 1, intent: 1, sentiment: 1, metadata: 1 },
  }, { new: true });

  const latest = await WhatsAppMessage.findOne({ conversation: conversation._id }).sort({ timestamp: -1, _id: -1 }).lean();
  const update: { $set?: Record<string, unknown>; $unset?: Record<string, 1> } = {};
  if (latest) {
    update.$set = {
      lastMessage: latest.deletedAt ? 'This message was deleted' : latest.text?.slice(0, 120) ?? (latest.type !== 'text' ? `[${latest.type}]` : ''),
      lastMessageAt: latest.timestamp,
    };
  } else {
    update.$unset = { lastMessage: 1, lastMessageAt: 1 };
  }
  await WhatsAppConversation.updateOne({ _id: conversation._id }, update);

  emitToConversation(String(conversation._id), 'message:deleted', { message: deleted!.toObject() });
  emitToConversation(String(conversation._id), 'conversation:updated', {});
  res.json(deleted);
}

// Meetings raised by the WhatsApp qualification pipeline are ordinary CRM Activity
// rows linked to the lead. These endpoints surface only still-planned Meeting rows for
// the selected conversation, and the same conversation scope protects both operations.
export async function listMeetings(req: Request, res: Response) {
  const conversation = await scopedConversation(req, String(req.params.id));
  if (!conversation.lead) return res.json([]);
  const meetingTypes = await ActivityType.find({ name: /^Meeting$/i }).select('_id').lean();
  const meetings = await Activity.find({
    relatedModel: 'Lead', relatedId: conversation.lead,
    activityType: { $in: meetingTypes.map(type => type._id) }, status: 'planned',
  }).populate('activityType', 'name icon').populate('assignedTo', 'name avatar').sort('dueDate');
  res.json(meetings);
}

export async function deleteMeeting(req: Request, res: Response) {
  const conversation = await scopedConversation(req, String(req.params.id));
  if (!conversation.lead) throw new ApiError(404, 'Scheduled meeting not found');
  const meeting = await Activity.findOne({
    _id: req.params.meetingId, relatedModel: 'Lead', relatedId: conversation.lead, status: 'planned',
  }).populate('activityType', 'name');
  if (!meeting || !/^Meeting$/i.test((meeting.activityType as any)?.name ?? '')) throw new ApiError(404, 'Scheduled meeting not found');
  await meeting.deleteOne();
  await TimelineEvent.create({
    createdBy: req.user!._id, relatedModel: 'Lead', relatedId: conversation.lead,
    eventType: 'activity_deleted', message: `Deleted scheduled meeting: ${meeting.summary}`,
  });
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
    WhatsAppMessage.countDocuments({ deletedAt: { $exists: false }, timestamp: { $gte: since } }),
    Lead.aggregate([{ $match: waLeadFilter }, { $group: { _id: '$leadTemperature', count: { $sum: 1 } } }]),
  ]);
  const byDay = await WhatsAppMessage.aggregate([{ $match: { deletedAt: { $exists: false }, timestamp: { $gte: new Date(Date.now() - 13 * 86400000) } } }, { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } }, count: { $sum: 1 } } }, { $sort: { _id: 1 } }]);
  const [waTotal, waConverted] = await Promise.all([
    Lead.countDocuments(waLeadFilter),
    Lead.countDocuments({ ...waLeadFilter, $or: [{ converted: true }, { qualificationStatus: 'won' }] }),
  ]);
  // Mean gap between the moment a customer started waiting (the first inbound of a run) and
  // the reply that ended the wait. Computed inside MongoDB: the previous version grouped a
  // week of messages into one array per conversation, which both streamed the entire message
  // history into this process and blew the 16MB document limit on any busy conversation.
  const [responseTime] = await WhatsAppMessage.aggregate([
    { $match: { deletedAt: { $exists: false }, timestamp: { $gte: new Date(Date.now() - 7 * 86400000) } } },
    { $project: { conversation: 1, direction: 1, timestamp: 1 } },
    { $setWindowFields: { partitionBy: '$conversation', sortBy: { timestamp: 1 }, output: { previousDirection: { $shift: { output: '$direction', by: -1 } } } } },
    // The first inbound of a run marks when the customer began waiting; carry it forward
    // across the rest of the run so the reply can measure back to it.
    { $addFields: { waitingSince: { $cond: [{ $and: [{ $eq: ['$direction', 'INBOUND'] }, { $ne: ['$previousDirection', 'INBOUND'] }] }, '$timestamp', null] } } },
    { $fill: { partitionBy: '$conversation', sortBy: { timestamp: 1 }, output: { waitingSince: { method: 'locf' } } } },
    { $match: { direction: 'OUTBOUND', previousDirection: 'INBOUND', waitingSince: { $ne: null } } },
    { $group: { _id: null, averageMs: { $avg: { $subtract: ['$timestamp', '$waitingSince'] } } } },
  ]);
  res.json({
    newWhatsAppLeads: newLeads, activeConversations: active, aiConversations: ai, humanConversations: human,
    hotLeads: hot, humanHandoffs: handoffs, messagesToday,
    whatsappConversionRate: waTotal ? Math.round((waConverted / waTotal) * 100) : 0,
    averageResponseTimeMinutes: responseTime?.averageMs != null ? Math.round(responseTime.averageMs / 60000) : null,
    messagesByDay: byDay, leadTemperature: tempDist,
  });
}
