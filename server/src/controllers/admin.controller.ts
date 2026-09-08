import type { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { Role, User } from '../models/index.js';
import { ApiError } from '../utils/http.js';
import { disconnectUser } from '../realtime.js';

const defaultRoles = [
  { name: 'Administrator', permissions: ['*'] },
  { name: 'Sales Manager', permissions: ['team:read', 'team:write', 'reports:read'] },
  { name: 'Salesperson', permissions: ['own:read', 'own:write'] },
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
  const inUse = await User.countDocuments({ role: role._id });
  if (inUse) throw new ApiError(409, `Cannot delete: ${inUse} user${inUse === 1 ? ' still has' : 's still have'} this role`);
  await role.deleteOne();
  res.status(204).end();
}

export async function listUsers(_req: Request, res: Response) {
  // Backfill the explicit status for users created before the three-state model.
  await Promise.all([
    User.updateMany({ accountStatus: { $exists: false }, active: false }, { $set: { accountStatus: 'inactive' } }),
    User.updateMany({ accountStatus: { $exists: false }, active: true }, { $set: { accountStatus: 'active' } }),
  ]);
  res.json(await User.find({}).select('name email avatar role active accountStatus createdAt').populate('role', 'name permissions').sort('name'));
}

export async function createUser(req: Request, res: Response) {
  const { name, email, password, role } = req.body;
  if (typeof name !== 'string' || name.trim().length < 2) throw new ApiError(422, 'Name must contain at least 2 characters');
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(422, 'Enter a valid email address');
  if (typeof password !== 'string' || password.length < 8) throw new ApiError(422, 'Temporary password must contain at least 8 characters');
  if (!mongoose.isValidObjectId(role) || !await Role.exists({ _id: role, active: true })) throw new ApiError(422, 'Select a valid role');
  if (await User.exists({ email: email.toLowerCase() })) throw new ApiError(409, 'A user with this email already exists');
  const user = await User.create({ name: name.trim(), email: email.toLowerCase(), password: await bcrypt.hash(password, 12), role, active: true, accountStatus: 'active' });
  res.status(201).json(await User.findById(user._id).select('name email avatar role active accountStatus createdAt').populate('role', 'name permissions'));
}

export async function updateUserAccess(req: Request, res: Response) {
  if (!isAdministrator(req)) {
    const target = await User.findById(req.params.id).populate('role', 'name');
    if (!target) throw new ApiError(404, 'User not found');
    if ((target.role as unknown as { name?: string })?.name === 'Administrator') throw new ApiError(403, 'Only an Administrator can change an Administrator account');
    if (req.body.role && (await Role.findById(req.body.role))?.name === 'Administrator') throw new ApiError(403, 'Only an Administrator can grant the Administrator role');
  }
  const requestedStatus = req.body.accountStatus ?? (req.body.active !== undefined ? (Boolean(req.body.active) ? 'active' : 'inactive') : undefined);
  if (requestedStatus !== undefined && !['active', 'inactive', 'disabled'].includes(requestedStatus)) throw new ApiError(422, 'Select a valid user status');
  if (String(req.user!._id) === String(req.params.id) && ((requestedStatus && requestedStatus !== 'active') || req.body.role)) throw new ApiError(409, 'You cannot deactivate your own account or change your own role');
  const update: { role?: string; active?: boolean; accountStatus?: 'active' | 'inactive' | 'disabled' } = {};
  if (req.body.role !== undefined) {
    if (!mongoose.isValidObjectId(req.body.role) || !await Role.exists({ _id: req.body.role, active: true })) throw new ApiError(422, 'Select a valid role');
    update.role = req.body.role;
  }
  if (requestedStatus !== undefined) {
    update.accountStatus = requestedStatus;
    update.active = requestedStatus === 'active';
  }
  const user = await User.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true }).select('name email avatar role active accountStatus createdAt').populate('role', 'name permissions');
  if (!user) throw new ApiError(404, 'User not found');
  if (requestedStatus && requestedStatus !== 'active') disconnectUser(String(user._id));
  res.json(user);
}
