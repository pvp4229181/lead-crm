import type { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { Role, User, UserInvitation } from '../models/index.js';
import { sendInvitationEmail } from '../services/mail.service.js';
import { ApiError } from '../utils/http.js';

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');
const expiry = () => new Date(Date.now() + Number(process.env.INVITE_EXPIRES_HOURS || 72) * 60 * 60 * 1000);

export async function listInvitations(_req: Request, res: Response) {
  res.json(await UserInvitation.find({ status: 'pending' }).populate('role', 'name').populate('invitedBy', 'name').sort('-createdAt'));
}

export async function createInvitation(req: Request, res: Response) {
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const roleId = req.body.role;
  if (name.length < 2) throw new ApiError(422, 'Name must contain at least 2 characters');
  if (!emailPattern.test(email)) throw new ApiError(422, 'Enter a valid email address');
  if (!mongoose.isValidObjectId(roleId)) throw new ApiError(422, 'Select a valid role');
  const role = await Role.findOne({ _id: roleId, active: true });
  if (!role) throw new ApiError(422, 'Select a valid role');
  if (await User.exists({ email })) throw new ApiError(409, 'A user with this email already exists');
  await UserInvitation.updateMany({ email, status: 'pending' }, { status: 'revoked' });
  const token = newToken(); const expiresAt = expiry();
  const invitation = await UserInvitation.create({ name, email, role: role._id, tokenHash: hashToken(token), invitedBy: req.user!._id, expiresAt });
  try { await sendInvitationEmail({ to: email, name, role: role.name, inviter: req.user!.name, token, expiresAt }); }
  catch (cause) { await UserInvitation.deleteOne({ _id: invitation._id }); throw cause; }
  res.status(201).json(await invitation.populate([{ path:'role', select:'name' }, { path:'invitedBy', select:'name' }]));
}

export async function resendInvitation(req: Request, res: Response) {
  const invitation = await UserInvitation.findOne({ _id: req.params.id, status: 'pending' }).populate('role', 'name');
  if (!invitation) throw new ApiError(404, 'Pending invitation not found');
  if (await User.exists({ email: invitation.email })) throw new ApiError(409, 'This person already has an account');
  const token = newToken(); const expiresAt = expiry();
  invitation.tokenHash = hashToken(token); invitation.expiresAt = expiresAt; await invitation.save();
  await sendInvitationEmail({ to: invitation.email, name: invitation.name, role: (invitation.role as any).name, inviter: req.user!.name, token, expiresAt });
  res.json(await invitation.populate('invitedBy', 'name'));
}

export async function revokeInvitation(req: Request, res: Response) {
  const invitation = await UserInvitation.findOneAndUpdate({ _id: req.params.id, status: 'pending' }, { status: 'revoked' }, { new: true });
  if (!invitation) throw new ApiError(404, 'Pending invitation not found');
  res.json({ success: true });
}

export async function inspectInvitation(req: Request, res: Response) {
  const invitation = await UserInvitation.findOne({ tokenHash: hashToken(String(req.params.token)), status: 'pending', expiresAt: { $gt: new Date() } }).populate('role', 'name');
  if (!invitation) throw new ApiError(404, 'This invitation is invalid or has expired');
  res.json({ name: invitation.name, email: invitation.email, role: invitation.role, expiresAt: invitation.expiresAt });
}

export async function acceptInvitation(req: Request, res: Response) {
  const tokenHash = hashToken(String(req.params.token)); const { password, confirmPassword } = req.body;
  if (typeof password !== 'string' || password.length < 8 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) throw new ApiError(422, 'Password must be at least 8 characters and include upper-case, lower-case, and numeric characters');
  if (password !== confirmPassword) throw new ApiError(422, 'Passwords do not match');
  const session = await mongoose.startSession();
  try {
    const user = await session.withTransaction(async () => {
      const invitation = await UserInvitation.findOne({ tokenHash, status: 'pending', expiresAt: { $gt: new Date() } }).session(session);
      if (!invitation) throw new ApiError(404, 'This invitation is invalid or has expired');
      if (await User.exists({ email: invitation.email }).session(session)) throw new ApiError(409, 'An account already exists for this email');
      const [created] = await User.create([{ name: invitation.name, email: invitation.email, password: await bcrypt.hash(password, 12), role: invitation.role, active: true }], { session });
      invitation.status = 'accepted'; invitation.acceptedAt = new Date(); await invitation.save({ session });
      return created!;
    });
    res.status(201).json({ message: 'Invitation accepted', user: { _id: user._id, name: user.name, email: user.email } });
  } finally { await session.endSession(); }
}
