import mongoose from 'mongoose';
import { Activity, ActivityType, FollowUpRule, TimelineEvent, WhatsAppConversation } from '../models/index.js';
import { ensureSystemUser } from '../utils/systemUser.js';
import { appendMessage } from './conversation.service.js';
import { sendTextMessage } from './whatsapp.service.js';
import { notifyUsers } from './notification.service.js';

async function ensureActivityType(name: string) {
  return ActivityType.findOneAndUpdate({ name }, { $setOnInsert: { active: true, defaultDays: 1 } }, { new: true, upsert: true });
}

// Step 13 of the pipeline: turn a detected intent into a follow-up the salesperson
// actually sees, rather than leaving it buried in the chat transcript.
export async function createFollowUpActivity(params: {
  leadId: mongoose.Types.ObjectId | string;
  assignedTo?: mongoose.Types.ObjectId | string;
  kind: 'Meeting' | 'Demo' | 'Callback' | 'Follow-up';
  summary: string;
  dueInHours?: number;
}) {
  const [type, systemUserId] = await Promise.all([ensureActivityType(params.kind), ensureSystemUser()]);
  const assignee = params.assignedTo ?? systemUserId;
  const activity = await Activity.create({
    activityType: type._id, dueDate: new Date(Date.now() + (params.dueInHours ?? 24) * 3600_000),
    assignedTo: assignee, summary: params.summary, relatedModel: 'Lead', relatedId: params.leadId, createdBy: systemUserId,
  });
  await TimelineEvent.create({ createdBy: systemUserId, relatedModel: 'Lead', relatedId: params.leadId, eventType: 'activity_created', message: params.summary });
  return activity;
}

export async function ensureDefaultFollowUpRules() {
  const defaults = [
    { name: 'No response — 24h', triggerAfterHours: 24, condition: 'no_response', action: 'send_message', messageText: "Just checking in — happy to answer any questions whenever you're ready!", maxOccurrences: 1 },
    { name: 'No response — 3 days', triggerAfterHours: 72, condition: 'no_response', action: 'send_message', messageText: "Still around if you'd like to continue — let me know if there's anything I can help clarify.", maxOccurrences: 1 },
    { name: 'No response — 7 days', triggerAfterHours: 168, condition: 'no_response', action: 'create_activity', maxOccurrences: 1 },
    { name: 'Hot lead inactive — 12h', triggerAfterHours: 12, condition: 'hot_lead_inactive', action: 'notify_salesperson', maxOccurrences: 1 },
  ];
  await Promise.all(defaults.map(rule => FollowUpRule.updateOne({ name: rule.name }, { $setOnInsert: { ...rule, active: true } }, { upsert: true })));
}

// Lead Follow-Up Automation: run periodically (see jobs/followup.job.ts). Each rule
// fires at most `maxOccurrences` times per conversation (tracked in followUpsSent) so
// customers are never spammed, and only against conversations the AI is still handling
// (a human-owned conversation manages its own cadence).
export async function runFollowUps() {
  await ensureDefaultFollowUpRules();
  const rules = await FollowUpRule.find({ active: true });
  const systemUserId = await ensureSystemUser();
  let processed = 0;

  for (const rule of rules) {
    const cutoff = new Date(Date.now() - rule.triggerAfterHours * 3600_000);
    const filter: Record<string, unknown> = {
      status: { $ne: 'archived' }, lastInboundAt: { $lte: cutoff, $ne: null },
      'followUpsSent.rule': { $ne: rule.name },
    };
    if (rule.condition === 'hot_lead_inactive') filter.controlStatus = { $in: ['AI_ACTIVE', 'WAITING_HUMAN'] };
    else filter.controlStatus = 'AI_ACTIVE';

    const conversations = await WhatsAppConversation.find(filter).populate('lead').limit(200);
    for (const conv of conversations) {
      const lead = conv.lead as any;
      if (rule.condition === 'hot_lead_inactive' && !(lead?.leadTemperature === 'Hot' || lead?.leadTemperature === 'Very Hot')) continue;
      // A message that arrived after we last checked disqualifies this rule for now — recheck cheaply.
      if (conv.lastInboundAt && conv.lastInboundAt > cutoff) continue;

      if (rule.action === 'send_message' && rule.messageText) {
        const result = await sendTextMessage(conv.phoneNumber, rule.messageText);
        await appendMessage({ conversation: conv, direction: 'OUTBOUND', text: rule.messageText, aiGenerated: true, status: result.ok ? 'SENT' : 'FAILED' });
      } else if (rule.action === 'create_activity' && lead) {
        await createFollowUpActivity({ leadId: lead._id, assignedTo: lead.salesperson, kind: 'Follow-up', summary: `No response from ${lead.contactName || conv.phoneNumber} in ${Math.round(rule.triggerAfterHours / 24)} day(s)`, dueInHours: 4 });
      } else if (rule.action === 'notify_salesperson' && lead?.salesperson) {
        await notifyUsers([lead.salesperson], 'hot_lead', 'Hot lead inactive', `${lead.contactName || conv.phoneNumber} hasn't replied in ${rule.triggerAfterHours}h`, '/whatsapp');
      }

      await WhatsAppConversation.updateOne({ _id: conv._id }, { $push: { followUpsSent: { rule: rule.name, at: new Date() } } });
      processed += 1;
    }
  }
  return { processed };
}
