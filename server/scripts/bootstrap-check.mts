// Verifies workspace bootstrapping: an empty workspace gets default stages and lead
// conversion succeeds, while an already-configured workspace is left untouched.
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'x'.repeat(40);
// convertLead runs in a transaction, which MongoDB only allows on a replica set (Atlas is
// one; a standalone in-memory server is not) — so the harness starts a single-node replica set.
const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 }, binary: { arch: 'x86_64', version: '7.0.14' } });
process.env.MONGODB_URI = mongo.getUri('bootstraptest');

const { connectDatabase } = await import('../dist/config/database.js');
const models = await import('../dist/models/index.js');
const { convertLead } = await import('../dist/services/crm.service.js');
const { ensureWorkspaceDefaults } = await import('../dist/utils/bootstrap.js');
await connectDatabase();

const ok = (label: string, condition: unknown, detail?: unknown) =>
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${condition ? '' : `  -> ${JSON.stringify(detail)}`}`);

const role = await models.Role.create({ name: 'Administrator', permissions: ['*'], active: true });
const user = await models.User.create({ name: 'Admin', email: 'a@b.c', password: 'x', role: role._id, active: true });

// Mirrors the reported bug: a signup-created workspace with a lead but zero stages.
ok('workspace starts with no pipeline stages', (await models.PipelineStage.countDocuments()) === 0);
const lead = await models.Lead.create({ title: 'xyz', contactName: 'Pratham V Pandey', companyName: 'nexmogen', email: 'pvp@example.com', phone: '06264420836', expectedRevenue: 100000, createdBy: user._id, updatedBy: user._id });

const opportunity = await convertLead(String(lead._id), user._id);
ok('lead converts without a preconfigured pipeline', Boolean(opportunity), opportunity);
ok('default stages created', (await models.PipelineStage.countDocuments()) === 6, await models.PipelineStage.countDocuments());
ok('opportunity landed on the first stage', String((await models.PipelineStage.findById((opportunity as any).stage))?.name) === 'New');
ok('lead marked converted', (await models.Lead.findById(lead._id))?.converted === true);
ok('default activity types created', (await models.ActivityType.countDocuments()) === 6);

// Second run must be a no-op, not a duplicate-stage generator.
const before = await models.PipelineStage.countDocuments();
await ensureWorkspaceDefaults(true);
ok('re-running bootstrap does not duplicate stages', (await models.PipelineStage.countDocuments()) === before);

// An admin who deleted stages down to one custom stage keeps their setup.
await models.PipelineStage.deleteMany({ name: { $ne: 'New' } });
await models.PipelineStage.updateOne({ name: 'New' }, { name: 'My Custom Stage' });
await ensureWorkspaceDefaults(true);
const names = (await models.PipelineStage.find().lean()).map(s => s.name);
ok('existing custom stage configuration untouched', names.length === 1 && names[0] === 'My Custom Stage', names);


// --- outbound template send (POST /whatsapp/send) --------------------------
const { sendTemplate } = await import('../dist/controllers/whatsapp.controller.js');
const approved = await models.WhatsAppTemplate.create({ templateName: 'welcome_intro', category: 'UTILITY', language: 'en_US', body: 'Hi {{1}}, thanks for your interest!', status: 'APPROVED' });
const pending = await models.WhatsAppTemplate.create({ templateName: 'not_ready', category: 'MARKETING', language: 'en_US', body: 'Hello', status: 'PENDING' });
const target = await models.Lead.create({ title: 'Outbound target', contactName: 'Asha', phone: '+91 98111 22233', createdBy: user._id, updatedBy: user._id });

const run = async (body: any) => {
  let status = 200; let payload: any = null; let error: any = null;
  const req: any = { body, user: { _id: user._id, role: { name: 'Administrator' } }, params: {}, query: {} };
  const res: any = { status(code: number) { status = code; return res; }, json(data: any) { payload = data; return res; } };
  try { await sendTemplate(req, res); } catch (cause) { error = cause; }
  return { status, payload, error };
};

const optedOutContact = await models.Contact.create({ name: 'Blocked Person', phone: '+91 90000 11111', whatsappId: '919000011111', whatsappOptIn: false });
const blocked = await run({ phone: '919000011111', template: String(approved._id), variables: ['Test'] });
ok('opted-out contact is refused', blocked.error?.status === 409, blocked.error?.message);

const notApproved = await run({ lead: String(target._id), template: String(pending._id) });
ok('unapproved template is refused', notApproved.error?.status === 422, notApproved.error?.message);

const noPhone = await models.Lead.create({ title: 'No phone', createdBy: user._id, updatedBy: user._id });
const missing = await run({ lead: String(noPhone._id), template: String(approved._id) });
ok('lead without a phone number is refused', missing.error?.status === 422, missing.error?.message);

// No WhatsApp credentials in this harness, so the send fails upstream — the point is that
// it is still recorded against a conversation instead of vanishing.
const sent = await run({ lead: String(target._id), template: String(approved._id), variables: ['Asha'] });
const outboundConv = await models.WhatsAppConversation.findOne({ phoneNumber: '919811122233' });
ok('conversation created for the outbound send', Boolean(outboundConv), outboundConv?.phoneNumber);
const outboundMsg = await models.WhatsAppMessage.findOne({ conversation: outboundConv?._id, direction: 'OUTBOUND' });
ok('failed send is recorded, not lost', outboundMsg?.status === 'FAILED', outboundMsg?.status);
ok('template name stored on the message', outboundMsg?.templateName === 'welcome_intro', outboundMsg?.templateName);
ok('caller told the send failed', sent.error?.status === 502, sent.error?.message);
void optedOutContact;

// --- auto-greet on lead creation + service catalogue on reply ---------------
const { greetNewLead, buildServiceCatalogue } = await import('../dist/services/greeting.service.js');
await models.Service.create({ name: 'Website Maintenance', price: 3000, priceType: 'fixed', link: 'https://nexmogen.example/maintenance', active: true });
await models.Product.create({ name: 'Property Listing Portal', price: 150000, priceType: 'starting_at', link: 'https://nexmogen.example/portal', active: true });

const cat = await buildServiceCatalogue('Here is what we offer:');
ok('catalogue lists services with links', /Property Listing Portal/.test(cat ?? '') && /nexmogen.example\/portal/.test(cat ?? ''), cat?.slice(0, 120));
ok('catalogue shows "from" for starting_at pricing', /from ₹1,50,000/.test(cat ?? ''), cat);

const greetLead = await models.Lead.create({ title: 'Greeting target', contactName: 'Neha', phone: '+91 98700 11122', createdBy: user._id, updatedBy: user._id });

// Disabled by default: adding a lead must not message anyone unexpectedly.
await models.AIConfiguration.deleteMany({});
await models.AIConfiguration.create({ autoGreetNewLeads: false, active: true, provider: 'mock' });
ok('no greeting sent while the feature is off', (await greetNewLead(greetLead._id)) === null);

// Enabled, but pointing at an unapproved template — must refuse rather than fail the send.
const draft = await models.WhatsAppTemplate.create({ templateName: 'draft_greet', category: 'UTILITY', language: 'en_US', body: 'Hi {{1}}', status: 'PENDING' });
await models.AIConfiguration.updateMany({}, { autoGreetNewLeads: true, autoGreetTemplate: draft._id });
ok('unapproved greeting template is skipped', (await greetNewLead(greetLead._id)) === null);

// Approved template: sends (fails upstream here, no credentials) and records it.
const okTpl = await models.WhatsAppTemplate.create({ templateName: 'welcome_greet', category: 'UTILITY', language: 'en_US', body: 'Hi {{1}}, welcome to Nexmogen!', status: 'APPROVED' });
await models.AIConfiguration.updateMany({}, { autoGreetTemplate: okTpl._id });
const greeted = await greetNewLead(greetLead._id);
ok('greeting attempted for an approved template', greeted !== null, greeted);
const gConv = await models.WhatsAppConversation.findOne({ phoneNumber: '919870011122' });
ok('greeting recorded against a conversation', Boolean(gConv?.greetedAt), gConv?.greetedAt);
ok('greeting message stored as a template message', (await models.WhatsAppMessage.countDocuments({ conversation: gConv?._id, type: 'template' })) === 1);

// Idempotent: a second call must not double-message the customer.
ok('lead is never greeted twice', (await greetNewLead(greetLead._id)) === null);

// --- Deleting a chat ---------------------------------------------------------
const { deleteConversation, deleteMessage, listMeetings, deleteMeeting } = await import('../dist/controllers/whatsapp.controller.js');
const resStub = () => { const r: any = { code: 0, payload: null, status(c: number) { r.code = c; return r; }, end() { return r; }, json(data: any) { r.payload = data; return r; } }; return r; };
const adminUser = { _id: user._id, role: { name: 'Administrator' } };

// --- Three-state user access ------------------------------------------------
const { updateUserAccess } = await import('../dist/controllers/admin.controller.js');
const statusUser = await models.User.create({ name: 'Status User', email: 'status@test.local', password: 'x', role: role._id, active: true, accountStatus: 'active' });
await updateUserAccess({ user: adminUser, params: { id: String(statusUser._id) }, body: { accountStatus: 'inactive' } } as any, resStub());
const inactiveUser = await models.User.findById(statusUser._id);
ok('user can be changed to inactive', inactiveUser?.accountStatus === 'inactive' && inactiveUser.active === false, inactiveUser);
await updateUserAccess({ user: adminUser, params: { id: String(statusUser._id) }, body: { accountStatus: 'disabled' } } as any, resStub());
const disabledUser = await models.User.findById(statusUser._id);
ok('user can be disabled', disabledUser?.accountStatus === 'disabled' && disabledUser.active === false, disabledUser);
await updateUserAccess({ user: adminUser, params: { id: String(statusUser._id) }, body: { accountStatus: 'active' } } as any, resStub());
const reactivatedUser = await models.User.findById(statusUser._id);
ok('user can be reactivated', reactivatedUser?.accountStatus === 'active' && reactivatedUser.active === true, reactivatedUser);
let selfDeactivationDenied = false;
try { await updateUserAccess({ user: adminUser, params: { id: String(user._id) }, body: { accountStatus: 'disabled' } } as any, resStub()); }
catch (error: any) { selfDeactivationDenied = error?.status === 409; }
ok('administrator cannot disable their own account', selfDeactivationDenied);

// --- Listing and deleting a scheduled meeting ------------------------------
const meetingType = await models.ActivityType.findOne({ name: 'Meeting' });
const scheduledMeeting = await models.Activity.create({
  activityType: meetingType!._id, dueDate: new Date(Date.now() + 86400000), assignedTo: user._id,
  summary: 'Discovery meeting with Neha', relatedModel: 'Lead', relatedId: gConv!.lead, createdBy: user._id,
});
const meetingListRes = resStub();
await listMeetings({ user: adminUser, params: { id: String(gConv!._id) } } as any, meetingListRes);
ok('scheduled meetings are listed for the conversation lead', meetingListRes.payload?.some((meeting: any) => String(meeting._id) === String(scheduledMeeting._id)), meetingListRes.payload);
const deleteMeetingRes = resStub();
await deleteMeeting({ user: adminUser, params: { id: String(gConv!._id), meetingId: String(scheduledMeeting._id) } } as any, deleteMeetingRes);
ok('deleting a scheduled meeting responds 204', deleteMeetingRes.code === 204, deleteMeetingRes.code);
ok('scheduled meeting is removed', !(await models.Activity.exists({ _id: scheduledMeeting._id })));
ok('meeting deletion leaves an audit event', Boolean(await models.TimelineEvent.exists({ relatedModel: 'Lead', relatedId: gConv!.lead, eventType: 'activity_deleted' })));

// --- Deleting one message ---------------------------------------------------
const messageConv = await models.WhatsAppConversation.create({
  phoneNumber: '919000000001', lastMessage: 'Newest agent reply',
  lastMessageAt: new Date('2026-01-02T10:00:00Z'), lastInboundAt: new Date('2026-01-01T10:00:00Z'),
});
const olderMessage = await models.WhatsAppMessage.create({
  conversation: messageConv._id, direction: 'INBOUND', type: 'text', text: 'Older customer message',
  timestamp: new Date('2026-01-01T10:00:00Z'), status: 'DELIVERED',
});
const newestMessage = await models.WhatsAppMessage.create({
  conversation: messageConv._id, direction: 'OUTBOUND', type: 'text', text: 'Newest agent reply',
  timestamp: new Date('2026-01-02T10:00:00Z'), status: 'SENT',
});
const deleteMessageRes = resStub();
await deleteMessage({ user: adminUser, params: { id: String(messageConv._id), messageId: String(newestMessage._id) } } as any, deleteMessageRes);
const afterOneMessageDelete = await models.WhatsAppConversation.findById(messageConv._id);
const deletedNewestMessage = await models.WhatsAppMessage.findById(newestMessage._id);
ok('deleting one message returns its tombstone', Boolean(deleteMessageRes.payload?.deletedAt), deleteMessageRes.payload);
ok('deleted message row is retained without its original content', Boolean(deletedNewestMessage?.deletedAt) && !deletedNewestMessage?.text);
ok('other messages remain unchanged', (await models.WhatsAppMessage.findById(olderMessage._id))?.text === 'Older customer message');
ok('conversation preview shows the deleted marker', afterOneMessageDelete?.lastMessage === 'This message was deleted', afterOneMessageDelete?.lastMessage);

let wrongConversationDenied = false;
const otherMessageConv = await models.WhatsAppConversation.create({ phoneNumber: '919000000002' });
try { await deleteMessage({ user: adminUser, params: { id: String(otherMessageConv._id), messageId: String(olderMessage._id) } } as any, resStub()); }
catch (error: any) { wrongConversationDenied = error?.status === 404; }
ok('a message cannot be deleted through another conversation', wrongConversationDenied);

await deleteMessage({ user: adminUser, params: { id: String(messageConv._id), messageId: String(olderMessage._id) } } as any, resStub());
const allDeletedMessageConv = await models.WhatsAppConversation.findById(messageConv._id);
ok('deleted messages remain visible as two tombstones', (await models.WhatsAppMessage.countDocuments({ conversation: messageConv._id, deletedAt: { $ne: null } })) === 2);
ok('soft deletion keeps the original inbound timing for automation', String(allDeletedMessageConv?.lastInboundAt) === String(messageConv.lastInboundAt), allDeletedMessageConv?.lastInboundAt);

await models.AIConversationSummary.create({ conversation: gConv!._id, lead: greetLead._id, summary: 'Interested in the portal' });
const beforeDelete = await models.WhatsAppMessage.countDocuments({ conversation: gConv!._id });
ok('chat has messages before deletion', beforeDelete > 0, beforeDelete);

const delRes = resStub();
await deleteConversation({ user: adminUser, params: { id: String(gConv!._id) } } as any, delRes);
ok('deleting a chat responds 204', delRes.code === 204, delRes.code);
ok('the conversation is gone', (await models.WhatsAppConversation.countDocuments({ _id: gConv!._id })) === 0);
ok('its messages are gone too', (await models.WhatsAppMessage.countDocuments({ conversation: gConv!._id })) === 0);
ok('its AI summaries are gone too', (await models.AIConversationSummary.countDocuments({ conversation: gConv!._id })) === 0);
// Deleting a chat must never take the CRM lead with it.
ok('the lead survives chat deletion', (await models.Lead.countDocuments({ _id: greetLead._id })) === 1);

// Access scope still applies: a salesperson cannot delete someone else's chat.
const foreign = await models.WhatsAppConversation.create({ phoneNumber: '919000000000' });
let denied = false;
try { await deleteConversation({ user: { _id: new mongoose.Types.ObjectId(), role: { name: 'Salesperson' } }, params: { id: String(foreign._id) } } as any, resStub()); }
catch (error: any) { denied = error?.status === 404; }
ok('a salesperson cannot delete a chat that is not theirs', denied);
ok('that chat is still there', (await models.WhatsAppConversation.countDocuments({ _id: foreign._id })) === 1);

// A deleted chat must not block the customer from starting a new one.
const { identifyOrCreateForPhone } = await import('../dist/services/conversation.service.js');
const reopened = await identifyOrCreateForPhone('919870011122', 'Neha');
ok('the customer can start a fresh chat after deletion', Boolean(reopened?.conversation ?? reopened), reopened);

await mongoose.disconnect();
await mongo.stop();
console.log('\nbootstrap check complete');
