// End-to-end smoke test of the WhatsApp AI pipeline against an in-memory MongoDB.
// Exercises the real code path: webhook payload -> processInboundMessage -> contact/lead
// creation -> message persistence -> AI reply -> qualification -> stage movement.
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.AI_PROVIDER = 'mock'; // no network in this sandbox
process.env.JWT_SECRET = 'x'.repeat(40);

// This machine is Windows-on-ARM; MongoDB ships no aarch64 Windows build, so pull the
// x64 binary and let Windows emulate it.
const mongo = await MongoMemoryServer.create({ binary: { arch: 'x86_64', version: '7.0.14' } });
process.env.MONGODB_URI = mongo.getUri('smoketest');

const { connectDatabase } = await import('../dist/config/database.js');
const models = await import('../dist/models/index.js');
const { processInboundMessage } = await import('../dist/pipeline/whatsapp.pipeline.js');

await connectDatabase();

const ok = (label: string, condition: unknown, detail?: unknown) =>
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${condition ? '' : `  -> ${JSON.stringify(detail)}`}`);

// A realistic workspace: notifications and round-robin assignment both need real users.
const [adminRole, salesRole] = await models.Role.create([
  { name: 'Administrator', permissions: ['*'] },
  { name: 'Salesperson', permissions: ['own:read'] },
]);
await models.User.create([
  { name: 'Admin User', email: 'admin@test.local', password: 'x', role: adminRole!._id, active: true },
  { name: 'Sales One', email: 'sales1@test.local', password: 'x', role: salesRole!._id, active: true },
]);

// --- 1. brand new customer sends a first message ---------------------------
await processInboundMessage({
  from: '919876543210', profileName: 'Rahul Sharma', whatsappMessageId: 'wamid.TEST1',
  timestamp: new Date(), type: 'text', text: 'Hi, I want a website for my real estate business',
});

const contact = await models.Contact.findOne({ whatsappId: '919876543210' });
const lead = await models.Lead.findOne({ phone: /9876543210$/ }).populate('source');
const conv = await models.WhatsAppConversation.findOne({ phoneNumber: '919876543210' });
const msgs = await models.WhatsAppMessage.find({ conversation: conv?._id }).sort('timestamp');

ok('contact created from WhatsApp profile', contact?.name === 'Rahul Sharma', contact?.name);
ok('lead created', Boolean(lead), lead);
ok('lead source is WhatsApp', (lead?.source as any)?.name === 'WhatsApp', (lead?.source as any)?.name);
ok('lead auto-assigned to a salesperson', Boolean(lead?.salesperson), String(lead?.salesperson));
ok('conversation assigned to that salesperson', String((await models.WhatsAppConversation.findOne({ phoneNumber: '919876543210' }))?.assignedTo) === String(lead?.salesperson));
ok('conversation created', Boolean(conv), conv?.phoneNumber);
ok('inbound message stored', msgs.some(m => m.direction === 'INBOUND' && m.text?.includes('real estate')), msgs.length);
ok('AI reply generated + stored', msgs.some(m => m.direction === 'OUTBOUND' && m.aiGenerated), msgs.map(m => `${m.direction}:${m.aiGenerated}`));
ok('unread count incremented', conv?.unreadCount === 1, conv?.unreadCount);
ok('lead moved New -> Contacted', lead?.qualificationStatus === 'contacted', lead?.qualificationStatus);
ok('lead scored', (lead?.leadScore ?? 0) > 0, lead?.leadScore);
ok('intent detected on conversation', Boolean(conv?.detectedIntent), conv?.detectedIntent);
ok('sentiment recorded', Boolean(conv?.sentiment), conv?.sentiment);
ok('AI summary persisted to lead', Boolean(lead?.aiSummary), lead?.aiSummary?.slice(0, 40));
ok('AIConversationSummary row written', (await models.AIConversationSummary.countDocuments()) > 0);

// --- 2. duplicate webhook delivery (Meta retries) --------------------------
const before = await models.WhatsAppMessage.countDocuments();
await processInboundMessage({
  from: '919876543210', profileName: 'Rahul Sharma', whatsappMessageId: 'wamid.TEST1',
  timestamp: new Date(), type: 'text', text: 'Hi, I want a website for my real estate business',
});
ok('duplicate message id ignored', (await models.WhatsAppMessage.countDocuments()) === before, { before, after: await models.WhatsAppMessage.countDocuments() });

// --- 3. pricing request should advance qualification -----------------------
await processInboundMessage({
  from: '919876543210', profileName: 'Rahul Sharma', whatsappMessageId: 'wamid.TEST2',
  timestamp: new Date(), type: 'text', text: 'My budget is around 1.5 lakh. What is the price? Can we meet next Tuesday?',
});
const lead2 = await models.Lead.findById(lead!._id);
const conv2 = await models.WhatsAppConversation.findById(conv!._id);
ok('lead score increased after qualification signals', (lead2?.leadScore ?? 0) > (lead?.leadScore ?? 0), { before: lead?.leadScore, after: lead2?.leadScore });
ok('meeting request created an Activity', (await models.Activity.countDocuments({ relatedId: lead!._id })) > 0);
ok('stage advanced past contacted', ['qualified', 'proposal', 'negotiation'].includes(String(lead2?.qualificationStatus)), lead2?.qualificationStatus);
ok('stage change logged to timeline', (await models.TimelineEvent.countDocuments({ relatedModel: 'Lead', relatedId: lead!._id, eventType: 'stage_changed' })) > 0);
ok('temperature classified', Boolean(lead2?.leadTemperature), `${lead2?.leadTemperature} @ ${lead2?.leadScore}`);

// --- 4. human takeover stops the AI ----------------------------------------
await models.WhatsAppConversation.updateOne({ _id: conv!._id }, { controlStatus: 'HUMAN_ACTIVE', aiEnabled: false });
const aiBefore = await models.WhatsAppMessage.countDocuments({ conversation: conv!._id, aiGenerated: true });
await processInboundMessage({
  from: '919876543210', profileName: 'Rahul Sharma', whatsappMessageId: 'wamid.TEST3',
  timestamp: new Date(), type: 'text', text: 'Are you there?',
});
const aiAfter = await models.WhatsAppMessage.countDocuments({ conversation: conv!._id, aiGenerated: true });
ok('AI does NOT reply while human has taken over', aiBefore === aiAfter, { aiBefore, aiAfter });
ok('inbound still recorded during takeover', (await models.WhatsAppMessage.countDocuments({ conversation: conv!._id, direction: 'INBOUND' })) === 3);

// --- 5. human-request escalation -------------------------------------------
await models.WhatsAppConversation.updateOne({ _id: conv!._id }, { controlStatus: 'AI_ACTIVE', aiEnabled: true });
await processInboundMessage({
  from: '919999000011', profileName: 'Priya', whatsappMessageId: 'wamid.TEST4',
  timestamp: new Date(), type: 'text', text: 'I want to talk to someone from your team please',
});
const conv3 = await models.WhatsAppConversation.findOne({ phoneNumber: '919999000011' });
ok('human request escalates conversation', conv3?.controlStatus === 'WAITING_HUMAN', conv3?.controlStatus);
ok('escalation disables AI auto-reply', conv3?.aiEnabled === false, conv3?.aiEnabled);
ok('handoff notification created', (await models.Notification.countDocuments({ type: 'human_handoff' })) > 0);
ok('new-lead notification created', (await models.Notification.countDocuments({ type: 'new_whatsapp_lead' })) > 0);

// --- 6. AI provider failure must escalate, not go silent -------------------
// Points the provider at OpenRouter with a bogus key so generateReply throws, the way a
// 429/expired-key would in production.
process.env.AI_PROVIDER = 'openrouter';
process.env.AI_API_KEY = 'sk-or-v1-definitely-invalid-key';
await models.AIConfiguration.updateMany({}, { provider: 'openrouter', aiModel: 'google/gemma-4-31b-it:free' });

await processInboundMessage({
  from: '919888777666', profileName: 'Failure Case', whatsappMessageId: 'wamid.TEST5',
  timestamp: new Date(), type: 'text', text: 'Hello, are you open?',
});
const failConv = await models.WhatsAppConversation.findOne({ phoneNumber: '919888777666' });
ok('inbound saved even when AI fails', (await models.WhatsAppMessage.countDocuments({ conversation: failConv?._id, direction: 'INBOUND' })) === 1);
ok('AI failure escalates to WAITING_HUMAN', failConv?.controlStatus === 'WAITING_HUMAN', failConv?.controlStatus);
ok('AI failure disables auto-reply', failConv?.aiEnabled === false, failConv?.aiEnabled);
ok('AI failure notifies a human', (await models.Notification.countDocuments({ message: /could not be reached/ })) > 0);
// A welcome menu may legitimately have gone out before the model was called; what must not
// happen is a fabricated text answer once generation failed.
ok('no fabricated text reply sent when AI fails', (await models.WhatsAppMessage.countDocuments({ conversation: failConv?._id, direction: 'OUTBOUND', type: 'text' })) === 0);

// --- 7. lead-side mode switching via WhatsApp buttons ----------------------
process.env.AI_PROVIDER = 'mock';
process.env.AI_API_KEY = '';
await models.AIConfiguration.updateMany({}, { provider: 'mock', globalAiEnabled: true, welcomeMenuEnabled: true, humanHandoffButtonEnabled: true });

// First contact should be greeted with the menu offering AI vs human.
await processInboundMessage({
  from: '918111222333', profileName: 'Menu Tester', whatsappMessageId: 'wamid.MENU1',
  timestamp: new Date(), type: 'text', text: 'hi',
});
const menuConv = await models.WhatsAppConversation.findOne({ phoneNumber: '918111222333' });
ok('welcome menu sent on first contact', (await models.WhatsAppMessage.countDocuments({ conversation: menuConv?._id, type: 'interactive' })) === 1);

// Customer taps "Talk to a human".
await processInboundMessage({
  from: '918111222333', profileName: 'Menu Tester', whatsappMessageId: 'wamid.MENU2',
  timestamp: new Date(), type: 'interactive', text: 'Talk to a human', interactiveId: 'wa_action_human',
});
const afterHuman = await models.WhatsAppConversation.findOne({ phoneNumber: '918111222333' });
ok('customer button switches to WAITING_HUMAN', afterHuman?.controlStatus === 'WAITING_HUMAN', afterHuman?.controlStatus);
ok('customer button disables AI auto-reply', afterHuman?.aiEnabled === false, afterHuman?.aiEnabled);
ok('team notified of customer handoff request', (await models.Notification.countDocuments({ title: 'Customer asked for a human' })) > 0);
// Count outbound only: the customer's own button tap is stored as an inbound interactive too.
ok('customer got a confirmation with a way back', (await models.WhatsAppMessage.countDocuments({ conversation: afterHuman?._id, direction: 'OUTBOUND', type: 'interactive' })) === 2);

// While waiting for a human, the AI must stay quiet.
const aiCountBefore = await models.WhatsAppMessage.countDocuments({ conversation: afterHuman?._id, aiGenerated: true });
await processInboundMessage({
  from: '918111222333', profileName: 'Menu Tester', whatsappMessageId: 'wamid.MENU3',
  timestamp: new Date(), type: 'text', text: 'still there?',
});
ok('AI stays silent while waiting for a human', (await models.WhatsAppMessage.countDocuments({ conversation: afterHuman?._id, aiGenerated: true })) === aiCountBefore);

// Customer taps "Back to AI".
await processInboundMessage({
  from: '918111222333', profileName: 'Menu Tester', whatsappMessageId: 'wamid.MENU4',
  timestamp: new Date(), type: 'interactive', text: 'Back to AI', interactiveId: 'wa_action_ai',
});
const afterAi = await models.WhatsAppConversation.findOne({ phoneNumber: '918111222333' });
ok('customer button resumes AI', afterAi?.controlStatus === 'AI_ACTIVE' && afterAi?.aiEnabled === true, afterAi?.controlStatus);
ok('AI message counter reset on resume', afterAi?.aiMessageCount === 0, afterAi?.aiMessageCount);

// And the AI answers again afterwards.
await processInboundMessage({
  from: '918111222333', profileName: 'Menu Tester', whatsappMessageId: 'wamid.MENU5',
  timestamp: new Date(), type: 'text', text: 'what is the price?',
});
ok('AI replies again after resuming', (await models.WhatsAppMessage.countDocuments({ conversation: afterAi?._id, aiGenerated: true })) > aiCountBefore);

await mongoose.disconnect();
await mongo.stop();
console.log('\nsmoke test complete');
