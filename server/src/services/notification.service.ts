import mongoose from 'mongoose';
import { Notification } from '../models/index.js';
import { emitToUser } from '../realtime.js';

export type NotifyKind =
  | 'new_whatsapp_lead' | 'hot_lead' | 'meeting_requested' | 'human_handoff'
  | 'pricing_request' | 'complaint' | 'purchase_confirmed';

export async function notifyUser(userId: mongoose.Types.ObjectId | string, type: NotifyKind, title: string, message: string, link?: string) {
  const doc = await Notification.create({ user: userId, type, title, message, link });
  emitToUser(String(userId), 'notification:new', doc.toObject());
  return doc;
}

export async function notifyUsers(userIds: (mongoose.Types.ObjectId | string)[], type: NotifyKind, title: string, message: string, link?: string) {
  const unique = [...new Set(userIds.map(String))];
  await Promise.all(unique.map(id => notifyUser(id, type, title, message, link)));
}
