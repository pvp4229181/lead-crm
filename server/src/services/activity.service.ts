import mongoose from 'mongoose';
import { Activity, ActivityType, TimelineEvent } from '../models/index.js';
import { ensureSystemUser } from '../utils/systemUser.js';

async function ensureActivityType(name: string) {
  return ActivityType.findOneAndUpdate({ name }, { $setOnInsert: { active: true, defaultDays: 1 } }, { new: true, upsert: true });
}

// Turns a detected intent (or an automation's create_activity action) into a follow-up the
// salesperson actually sees, rather than leaving it buried in the chat transcript.
export async function createFollowUpActivity(params: {
  leadId: mongoose.Types.ObjectId | string;
  assignedTo?: mongoose.Types.ObjectId | string;
  kind: 'Meeting' | 'Demo' | 'Callback' | 'Follow-up' | string;
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
