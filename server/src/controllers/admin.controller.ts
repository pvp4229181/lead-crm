import type { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { Activity, Company, Contact, Lead, Notification, Opportunity, Role, SalesTeam, SavedFilter, User, WhatsAppConversation } from '../models/index.js';
import { ApiError } from '../utils/http.js';
import { disconnectUser } from '../realtime.js';
import { ensureSystemUser } from '../utils/systemUser.js';

const defaultRoles = [
  { name: 'Administrator', permissions: ['*'] },
  { name: 'Sales Manager', permissions: ['team:read', 'team:write', 'reports:read'] },
  { name: 'Salesperson', permissions: ['own:read', 'own:write'] },
  { name: 'AI Agent', permissions: [] },
];

async function ensureRoles() {
  await Promise.all(defaultRoles.map(role => Role.updateOne({ name: role.name }, { $setOnInsert: { ...role, active: true } }, { upsert: true })));
}

export async function listRoles(_req: Request, res: Response) {
  await ensureRoles();
  res.json(await Role.find({ active: true }).sort('name'));
}

const builtInRoles = new Set(defaultRoles.map(role => role.name));
const isAdministrator = (req: Request) => (req.user!.role as unknown as { name?: string })?.name === 'Administrator';

export async function createRole(req: Request, res: Response) {
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  if (name.length < 2) throw new ApiError(422, 'Role name must contain at least 2 characters');
  if (await Role.exists({ name })) throw new ApiError(409, 'A role with this name already exists');
  const permissions = Array.isArray(req.body.permissions) ? req.body.permissions.filter((value: unknown) => typeof value === 'string') : ['own:read', 'own:write'];
  if (permissions.includes('*')) throw new ApiError(422, 'Full access is reserved for the built-in Administrator role');
  res.status(201).json(await Role.create({ name, permissions, active: true }));
}

export async function updateRole(req: Request, res: Response) {
  const role = await Role.findById(req.params.id);
  if (!role) throw new ApiError(404, 'Role not found');
  if (builtInRoles.has(role.name)) throw new ApiError(409, 'Built-in roles cannot be renamed');
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  if (name.length < 2) throw new ApiError(422, 'Role name must contain at least 2 characters');
  if (await Role.exists({ name, _id: { $ne: role._id } })) throw new ApiError(409, 'A role with this name already exists');
  role.name = name; await role.save();
  res.json(role);
}

export async function deleteRole(req: Request, res: Response) {
  const role = await Role.findById(req.params.id);
  if (!role) throw new ApiError(404, 'Role not found');
  if (builtInRoles.has(role.name)) throw new ApiError(409, 'Built-in roles cannot be deleted');
  const inUse = await User.countDocuments({ role: role._id, deletedAt: { $exists: false } });
  if (inUse) throw new ApiError(409, `Cannot delete: ${inUse} user${inUse === 1 ? ' still has' : 's still have'} this role`);
  await role.deleteOne();
  res.status(204).end();
}

export async function listUsers(_req: Request, res: Response) {
  await ensureSystemUser();
  const users = await User.find({ deletedAt: { $exists: false } }).select('name email avatar role active createdAt').populate('role', 'name permissions').sort('name').lean();
  res.json(users.map(user => ({ ...user, isSystem: user.email === 'whatsapp-ai@system.local' })));
}

export async function createUser(req: Request, res: Response) {
  const { name, email, password, role } = req.body;
  if (typeof name !== 'string' || name.trim().length < 2) throw new ApiError(422, 'Name must contain at least 2 characters');
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(422, 'Enter a valid email address');
  if (typeof password !== 'string' || password.length < 8) throw new ApiError(422, 'Temporary password must contain at least 8 characters');
  if (!mongoose.isValidObjectId(role)) throw new ApiError(422, 'Select a valid role');
  const selectedRole = await Role.findOne({ _id: role, active: true }).select('name');
  if (!selectedRole) throw new ApiError(422, 'Select a valid role');
  if (selectedRole.name === 'AI Agent') throw new ApiError(409, 'The AI Agent role is reserved for WhatsApp automation');
  if (await User.exists({ email: email.toLowerCase() })) throw new ApiError(409, 'A user with this email already exists');
  const user = await User.create({ name: name.trim(), email: email.toLowerCase(), password: await bcrypt.hash(password, 12), role, active: true });
  res.status(201).json(await User.findById(user._id).select('name email avatar role active createdAt').populate('role', 'name permissions'));
}

export async function updateUserAccess(req: Request, res: Response) {
  if (await User.exists({ _id: req.params.id, email: 'whatsapp-ai@system.local' })) throw new ApiError(409, 'The WhatsApp AI Agent is a protected system account');
  if (!isAdministrator(req)) {
    const target = await User.findById(req.params.id).populate('role', 'name');
    if (!target) throw new ApiError(404, 'User not found');
    if ((target.role as unknown as { name?: string })?.name === 'Administrator') throw new ApiError(403, 'Only an Administrator can change an Administrator account');
    if (req.body.role && (await Role.findById(req.body.role))?.name === 'Administrator') throw new ApiError(403, 'Only an Administrator can grant the Administrator role');
  }
  if (String(req.user!._id) === String(req.params.id) && (req.body.active === false || req.body.role)) throw new ApiError(409, 'You cannot suspend your own account or change your own role');
  const update: { role?: string; active?: boolean } = {};
  if (req.body.role !== undefined) {
    if (!mongoose.isValidObjectId(req.body.role)) throw new ApiError(422, 'Select a valid role');
    const selectedRole = await Role.findOne({ _id: req.body.role, active: true }).select('name');
    if (!selectedRole) throw new ApiError(422, 'Select a valid role');
    if (selectedRole.name === 'AI Agent') throw new ApiError(409, 'The AI Agent role is reserved for WhatsApp automation');
    update.role = req.body.role;
  }
  if (req.body.active !== undefined) update.active = Boolean(req.body.active);
  const user = await User.findOneAndUpdate({ _id: req.params.id, deletedAt: { $exists: false } }, update, { new: true, runValidators: true }).select('name email avatar role active createdAt').populate('role', 'name permissions');
  if (!user) throw new ApiError(404, 'User not found');
  if (req.body.active === false) disconnectUser(String(user._id));
  res.json(user);
}

// Removes login access and personal identity while retaining a minimal placeholder
// document for historical createdBy/sentBy references. Optional assignments are cleared;
// required Activity assignments move to the non-login system user.
export async function deleteUser(req: Request, res: Response) {
  const user = await User.findOne({ _id: req.params.id, deletedAt: { $exists: false } }).populate('role', 'name');
  if (!user) throw new ApiError(404, 'User not found');
  if (String(req.user!._id) === String(user._id)) throw new ApiError(409, 'You cannot delete your own account');
  if (user.email === 'whatsapp-ai@system.local') throw new ApiError(409, 'The system user cannot be deleted');
  if (await SalesTeam.exists({ teamLeader: user._id })) throw new ApiError(409, 'Reassign this user’s team leadership before deleting the account');

  const role = user.role as unknown as { _id: mongoose.Types.ObjectId; name?: string };
  if (role?.name === 'Administrator') {
    const administratorCount = await User.countDocuments({ role: role._id, deletedAt: { $exists: false } });
    if (administratorCount <= 1) throw new ApiError(409, 'The last Administrator account cannot be deleted');
  }

  const systemUserId = await ensureSystemUser();
  await Promise.all([
    Company.updateMany({ salesperson: user._id }, { $unset: { salesperson: 1 } }),
    Contact.updateMany({ salesperson: user._id }, { $unset: { salesperson: 1 } }),
    Lead.updateMany({ salesperson: user._id }, { $unset: { salesperson: 1 } }),
    Opportunity.updateMany({ salesperson: user._id }, { $unset: { salesperson: 1 } }),
    WhatsAppConversation.updateMany({ assignedTo: user._id }, { $unset: { assignedTo: 1 } }),
    Activity.updateMany({ assignedTo: user._id }, { $set: { assignedTo: systemUserId } }),
    SalesTeam.updateMany({ members: user._id }, { $pull: { members: user._id } }),
    Notification.deleteMany({ user: user._id }),
    SavedFilter.deleteMany({ user: user._id }),
  ]);

  user.name = 'Deleted User';
  user.email = `deleted-${user._id}@system.local`;
  user.password = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
  user.active = false;
  user.deletedAt = new Date();
  user.avatar = undefined;
  await user.save();
  disconnectUser(String(user._id));
  res.status(204).end();
}
