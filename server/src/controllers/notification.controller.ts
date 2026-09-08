import type { Request, Response } from 'express';
import { Notification } from '../models/index.js';

export async function markAllRead(req: Request, res: Response) {
  const result = await Notification.updateMany({ user: req.user!._id, read: false }, { read: true });
  res.json({ updated: result.modifiedCount ?? 0 });
}

export async function clearAll(req: Request, res: Response) {
  const result = await Notification.deleteMany({ user: req.user!._id });
  res.json({ deleted: result.deletedCount ?? 0 });
}
