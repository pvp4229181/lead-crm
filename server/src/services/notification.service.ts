import mongoose from 'mongoose';
import { Notification, User } from '../models/index.js';
import { emitToUser } from '../realtime.js';

export type NotifyKind =
  | 'new_whatsapp_lead' | 'hot_lead' | 'meeting_requested' | 'human_handoff'
  | 'pricing_request' | 'complaint' | 'purchase_confirmed' | 'automation';

// Fallback recipients for anything with no assigned salesperson — an unassigned lead
// would otherwise drop every notification it raises on the floor.
export async function adminAndManagerIds(): Promise<string[]> {
  const users = await User.find({ active: true }).populate('role', 'name').select('_id role').lean();
  return users.filter((user: any) => ['Administrator', 'Sales Manager'].includes(user.role?.name)).map(user => String(user._id));
}

export async function notifyUser(userId: mongoose.Types.ObjectId | string, type: NotifyKind, title: string, message: string, link?: string) {
  const doc = await Notification.create({ user: userId, type, title, message, link });
  emitToUser(String(userId), 'notification:new', doc.toObject());
  return doc;
}

export async function notifyUsers(userIds: (mongoose.Types.ObjectId | string)[], type: NotifyKind, title: string, message: string, link?: string) {
  const unique = [...new Set(userIds.map(String))];
  await Promise.all(unique.map(id => notifyUser(id, type, title, message, link)));
}
