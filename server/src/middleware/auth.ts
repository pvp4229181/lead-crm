import type { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { SalesTeam, User } from '../models/index.js';
import { ApiError, asyncHandler } from '../utils/http.js';

type TokenPayload = { sub: string };
export const requireAuth: RequestHandler = asyncHandler(async (req, _res, next) => {
  const token = req.cookies?.orbit_token || req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) throw new ApiError(401, 'Authentication required');
  const payload = jwt.verify(token, process.env.JWT_SECRET!) as TokenPayload;
  const user = await User.findById(payload.sub).populate('role').select('+password');
  if (!user?.active || user.accountStatus !== 'active') throw new ApiError(401, user?.accountStatus === 'disabled' ? 'Account disabled' : 'Account inactive');
  const role = user.role as unknown as { name?: string; active?: boolean };
  if (!role?.name || role.active === false) throw new ApiError(403, 'Your assigned role is unavailable');
  if (role.name === 'Sales Manager') {
    const teams = await SalesTeam.find({ active: true, $or: [{ teamLeader: user._id }, { members: user._id }] }).select('_id').lean();
    (user as any).salesTeams = teams.map(team => team._id);
  }
  req.user = user;
  next();
});
export const authorize = (...roles: string[]): RequestHandler => (req, _res, next) => {
  const role = req.user?.role as unknown as { name?: string };
  if (!role?.name || !roles.includes(role.name)) return next(new ApiError(403, 'Insufficient permissions'));
  next();
};
export function accessScope(req: Express.Request) {
  const role = req.user?.role as unknown as { name?: string };
  if (role?.name === 'Administrator') return {};
  if (role?.name === 'Sales Manager') return { $and: [{ $or: [{ salesperson: req.user?._id }, { salesTeam: { $in: (req.user as any).salesTeams ?? [] } }] }] };
  return { salesperson: req.user?._id };
}
