import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { authorize, requireAuth } from '../middleware/auth.js';
import { asyncHandler, ApiError } from '../utils/http.js';
import * as auth from '../controllers/auth.controller.js';
import * as crm from '../controllers/crm.controller.js';
import * as admin from '../controllers/admin.controller.js';
import * as invitation from '../controllers/invitation.controller.js';
import * as notification from '../controllers/notification.controller.js';
import { Activity, Company, Contact, Opportunity, TimelineEvent, WhatsAppConversation } from '../models/index.js';
import { whatsappApi, whatsappWebhook } from './whatsapp.routes.js';

export const api = Router();
api.use(whatsappWebhook);
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 15, standardHeaders: true, legacyHeaders: false });
const invitationLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 40, standardHeaders: true, legacyHeaders: false });
api.post('/auth/login', loginLimiter, asyncHandler(auth.login));
api.post('/auth/signup-admin', asyncHandler(auth.signupAdmin));
api.get('/auth/invitations/:token', invitationLimiter, asyncHandler(invitation.inspectInvitation));
api.post('/auth/invitations/:token/accept', invitationLimiter, asyncHandler(invitation.acceptInvitation));
api.post('/auth/logout', auth.logout);
api.get('/auth/me', requireAuth, auth.me);
api.use(requireAuth);
api.use(whatsappApi);
api.get('/admin/roles', authorize('Administrator', 'Sales Manager'), asyncHandler(admin.listRoles));
api.post('/admin/roles', authorize('Administrator'), asyncHandler(admin.createRole));
api.patch('/admin/roles/:id', authorize('Administrator'), asyncHandler(admin.updateRole));
api.delete('/admin/roles/:id', authorize('Administrator'), asyncHandler(admin.deleteRole));
api.get('/admin/users', authorize('Administrator', 'Sales Manager'), asyncHandler(admin.listUsers));
api.post('/admin/users', authorize('Administrator'), asyncHandler(admin.createUser));
api.patch('/admin/users/:id', authorize('Administrator', 'Sales Manager'), asyncHandler(admin.updateUserAccess));
api.delete('/admin/users/:id', authorize('Administrator'), asyncHandler(admin.deleteUser));
api.get('/admin/invitations', authorize('Administrator'), asyncHandler(invitation.listInvitations));
api.post('/admin/invitations', authorize('Administrator'), asyncHandler(invitation.createInvitation));
api.post('/admin/invitations/:id/resend', authorize('Administrator'), asyncHandler(invitation.resendInvitation));
api.delete('/admin/invitations/:id', authorize('Administrator'), asyncHandler(invitation.revokeInvitation));
api.get('/metadata', asyncHandler(crm.metadata));
api.get('/dashboard', asyncHandler(crm.dashboard));
api.get('/reports', asyncHandler(crm.report));
api.route('/opportunities').get(asyncHandler(crm.listOpportunities)).post(asyncHandler(crm.createOpportunity));
api.route('/opportunities/:id').get(asyncHandler(crm.getOpportunity)).patch(asyncHandler(crm.updateOpportunity)).delete(asyncHandler(crm.deleteOpportunity));
api.patch('/opportunities/:id/move', asyncHandler(crm.move));
api.patch('/opportunities/:id/outcome', asyncHandler(crm.setOutcome));
api.route('/leads').get(asyncHandler(crm.listLeads)).post(asyncHandler(crm.createLead));
api.route('/leads/:id').patch(asyncHandler(crm.updateLead)).delete(asyncHandler(crm.deleteLead));
api.post('/leads/:id/convert', asyncHandler(crm.convert));
api.post('/timeline/:model/:id', asyncHandler(async (req, res) => {
  const doc = await TimelineEvent.create({ createdBy: req.user!._id, relatedModel: req.params.model, relatedId: req.params.id, eventType: req.body.eventType ?? 'note_added', message: req.body.message });
  res.status(201).json(doc);
}));

// The generic list route returned raw ObjectIds, so referenced names rendered blank in the UI.
const listPopulate: Record<string, any> = {
  contacts: [{ path: 'company', select: 'name' }, { path: 'salesperson', select: 'name avatar' }],
  companies: [{ path: 'salesperson', select: 'name avatar' }, { path: 'tags', select: 'name color' }],
  activities: [{ path: 'activityType', select: 'name icon' }, { path: 'assignedTo', select: 'name avatar' }],
  teams: [{ path: 'teamLeader', select: 'name avatar' }, { path: 'members', select: 'name avatar' }],
};
// Stage and activity type are required refs: deleting one in use would strand its records.
const referenceGuards: Record<string, { model: any; field: string; label: string }> = {
  stages: { model: Opportunity, field: 'stage', label: 'opportunity' },
  activityTypes: { model: Activity, field: 'activityType', label: 'activity' },
};
const adminResources = new Set(['teams','stages','tags','sources','campaigns','mediums','lostReasons','activityTypes']);
for (const [path, model] of Object.entries(crm.models) as [string, any][]) {
  const owned = path === 'notifications' || path === 'filters';
  api.get(`/${path}`, asyncHandler(async (req, res) => {
    const query = owned ? { user: req.user!._id } : {};
    res.json(await model.find(query).populate(listPopulate[path] ?? []).sort(path === 'activities' ? 'dueDate' : 'name').limit(500).lean());
  }));
  api.post(`/${path}`, asyncHandler(async (req, res) => {
    if (adminResources.has(path) && (req.user!.role as any).name !== 'Administrator') throw new ApiError(403, 'Administrator access required');
    const base = owned ? { ...req.body, user: req.user!._id } : { ...req.body };
    if (model.schema.path('createdBy')) base.createdBy = req.user!._id;
    const doc = await model.create(base);
    res.status(201).json(doc);
  }));
  api.patch(`/${path}/:id`, asyncHandler(async (req, res) => {
    if (adminResources.has(path) && (req.user!.role as any).name !== 'Administrator') throw new ApiError(403, 'Administrator access required');
    const doc = await model.findOneAndUpdate({ _id: req.params.id, ...(owned ? { user: req.user!._id } : {}) }, req.body, { new: true, runValidators: true });
    if (!doc) throw new ApiError(404, 'Record not found');
    res.json(doc);
  }));
  api.delete(`/${path}/:id`, asyncHandler(async (req, res) => {
    if (adminResources.has(path) && (req.user!.role as any).name !== 'Administrator') throw new ApiError(403, 'Administrator access required');
    const guard = referenceGuards[path];
    if (guard) { const used = await guard.model.countDocuments({ [guard.field]: req.params.id }); if (used) throw new ApiError(409, `Cannot delete: ${used} ${guard.label}${used === 1 ? ' still uses' : 's still use'} this record`); }
    const doc = await model.findOneAndDelete({ _id: req.params.id, ...(owned ? { user: req.user!._id } : {}) });
    if (!doc) throw new ApiError(404, 'Record not found');
    res.status(204).end();
  }));
}
// DELETE /bulk/contacts | /bulk/companies — clear the whole address book in one go, for
// wiping imported or seeded data. Irreversible, so it is Administrator-only and the client
// makes the user type the resource name before it fires.
// Mounted on its own /bulk prefix rather than /contacts/all so it can't be shadowed by the
// generic /:id delete route registered in the loop above.
const bulkDeletable: Record<string, { model: any; label: string; clear: { model: any; field: string }[] }> = {
  contacts: { model: Contact, label: 'contact', clear: [{ model: Opportunity, field: 'contact' }, { model: WhatsAppConversation, field: 'contact' }] },
  companies: { model: Company, label: 'company', clear: [{ model: Contact, field: 'company' }, { model: Opportunity, field: 'company' }] },
};
api.delete('/bulk/:resource', authorize('Administrator'), asyncHandler(async (req, res) => {
  const target = bulkDeletable[String(req.params.resource)];
  if (!target) throw new ApiError(404, 'That record type cannot be bulk deleted');

  const total = await target.model.countDocuments({});
  if (!total) return res.json({ deleted: 0, cleared: 0 });

  // Unset the references first. Deleting the documents while opportunities and conversations
  // still point at them would leave ids that populate to null and render as blank names.
  let cleared = 0;
  for (const reference of target.clear) {
    const outcome = await reference.model.updateMany({ [reference.field]: { $ne: null } }, { $unset: { [reference.field]: '' } });
    cleared += outcome.modifiedCount ?? 0;
  }
  const outcome = await target.model.deleteMany({});
  res.json({ deleted: outcome.deletedCount ?? 0, cleared });
}));

api.post('/notifications/read-all', asyncHandler(notification.markAllRead));
api.delete('/notifications', asyncHandler(notification.clearAll));
