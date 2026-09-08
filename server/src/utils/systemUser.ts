import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { Role, User } from '../models/index.js';

// Leads/Activities/TimelineEvents require a `createdBy` User ref, but records the
// AI pipeline creates on its own (a lead from an inbound WhatsApp message, an
// AI-scheduled follow-up activity) have no human actor. This account is that actor —
// created lazily on first use, never returned by any list/login endpoint since its
// password hash is random and never disclosed.
let cachedId: string | null = null;

export async function ensureSystemUser(): Promise<string> {
  if (cachedId) return cachedId;
  const existing = await User.findOne({ email: 'whatsapp-ai@system.local' }).select('_id');
  if (existing) { cachedId = String(existing._id); return cachedId; }
  const role = await Role.findOneAndUpdate(
    { name: 'AI Agent' },
    { $setOnInsert: { name: 'AI Agent', permissions: [], active: true } },
    { new: true, upsert: true },
  );
  const user = await User.create({
    name: 'WhatsApp AI Agent',
    email: 'whatsapp-ai@system.local',
    password: await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12),
    role: role._id,
    active: false, // cannot be used to log in
  });
  cachedId = String(user._id);
  return cachedId;
}
