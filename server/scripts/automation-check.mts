// Exercises the ARIA automation API against an in-memory MongoDB: the template CRUD an
// admin drives from WhatsApp Automation → Templates, the automation CRUD, the log feed,
// the variable/trigger catalogue, and the authorization boundary around all of it.
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.AI_PROVIDER = 'mock';
process.env.JWT_SECRET = 'x'.repeat(40);

const mongo = await MongoMemoryServer.create({ binary: { arch: 'x86_64', version: '7.0.14' } });
process.env.MONGODB_URI = mongo.getUri('automationtest');

const { connectDatabase } = await import('../dist/config/database.js');
const models = await import('../dist/models/index.js');
const controller = await import('../dist/automation/automation.controller.js');
const { migrateToAriaAutomation } = await import('../dist/automation/migrate.js');
const { dispatchTrigger } = await import('../dist/automation/automation.service.js');
const { renderTemplate, resolveVariables } = await import('../dist/automation/variable.service.js');
const { evaluateConditions } = await import('../dist/automation/condition.service.js');

await connectDatabase();

let failures = 0;
const ok = (label: string, condition: unknown, detail?: unknown) => {
  if (!condition) failures += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${condition ? '' : `  -> ${JSON.stringify(detail)}`}`);
};

const role = await models.Role.create({ name: 'Administrator', permissions: ['*'], active: true });
const admin = await models.User.create({ name: 'Admin', email: 'admin@test.local', password: 'x', role: role._id, active: true });
const actor = { _id: admin._id, role: { name: 'Administrator' } };
await migrateToAriaAutomation();

// Minimal Express double: enough for the controllers, which only ever use status/json/end.
const call = async (handler: any, { body = {}, params = {}, query = {} }: any = {}) => {
  const result: any = { code: 200, payload: null, error: null };
  const res: any = {
    status(code: number) { result.code = code; return res; },
    json(data: any) { result.payload = data; return res; },
    end() { return res; },
  };
  try { await handler({ body, params, query, user: actor }, res); } catch (error) { result.error = error; }
  return result;
};

// --- catalogue --------------------------------------------------------------
const catalogue = await call(controller.catalogue);
ok('catalogue exposes every trigger', catalogue.payload?.triggers?.length >= 15, catalogue.payload?.triggers?.length);
ok('catalogue exposes the variable palette', catalogue.payload?.variables?.some((variable: any) => variable.name === 'first_name'));
ok('catalogue exposes condition fields and action types', catalogue.payload?.conditionFields?.length > 0 && catalogue.payload?.actionTypes?.includes('pause_ai'));

// --- template listing, search and filters ----------------------------------
const all = await call(controller.listTemplates);
ok('listing returns the seeded ARIA templates', all.payload?.length >= 12, all.payload?.length);
const searched = await call(controller.listTemplates, { query: { search: 'quotation' } });
ok('search matches on name and body', searched.payload?.some((template: any) => template.templateKey === 'quotation_ready'), searched.payload?.map((t: any) => t.templateKey));
const filtered = await call(controller.listTemplates, { query: { category: 'payment' } });
ok('category filter narrows the list', filtered.payload?.length === 2 && filtered.payload.every((template: any) => template.category === 'payment'), filtered.payload?.map((t: any) => t.templateKey));

// --- create, update, duplicate, status, delete ------------------------------
const created = await call(controller.createTemplate, {
  body: {
    templateName: 'Custom greeting', templateKey: 'custom_greeting', category: 'welcome', trigger: 'new_whatsapp_lead',
    messageType: 'text', message: 'Hello {{first_name}}, welcome to {{business_name}}.', status: 'draft',
  },
});
ok('template created', created.code === 201 && created.payload?.templateKey === 'custom_greeting', created.error?.message);
ok('declared variables are derived from the body', created.payload?.variables?.join(',') === 'first_name,business_name', created.payload?.variables);

const duplicateKey = await call(controller.createTemplate, { body: { templateName: 'Clash', templateKey: 'custom_greeting', category: 'other', trigger: 'new_whatsapp_lead', messageType: 'text', message: 'x' } });
ok('duplicate template key is refused', duplicateKey.error?.status === 409, duplicateKey.error?.message);

const badTrigger = await call(controller.createTemplate, { body: { templateName: 'Bad', templateKey: 'bad_trigger', category: 'other', trigger: 'not_a_real_trigger', messageType: 'text', message: 'x' } });
ok('unknown trigger is rejected by validation', Boolean(badTrigger.error), badTrigger.error?.name);

const updated = await call(controller.updateTemplate, { params: { id: String(created.payload._id) }, body: { message: 'Hi {{first_name}}!', templateKey: 'renamed_key' } });
ok('template updated', updated.payload?.message === 'Hi {{first_name}}!');
ok('template key is immutable', updated.payload?.templateKey === 'custom_greeting', updated.payload?.templateKey);

const copied = await call(controller.duplicate, { params: { id: String(created.payload._id) } });
ok('duplicate lands as a draft with a fresh key', copied.code === 201 && copied.payload?.status === 'draft' && copied.payload?.templateKey === 'custom_greeting_copy', copied.payload?.templateKey);

const activated = await call(controller.setTemplateStatus, { params: { id: String(created.payload._id) }, body: { status: 'active' } });
ok('template can be activated from the table', activated.payload?.status === 'active');

// --- test / preview ---------------------------------------------------------
const preview = await call(controller.testTemplate, { params: { id: String(created.payload._id) }, body: {} });
ok('preview fills sample values', preview.payload?.text?.includes('Rahul') && preview.payload?.sent === false, preview.payload);

const quotation = await models.AutomationTemplate.findOne({ templateKey: 'quotation_ready' });
const blockedPreview = await call(controller.testTemplate, { params: { id: String(quotation!._id) }, body: { lead: null } });
ok('preview of a required-variable template still renders with samples', blockedPreview.payload?.text?.includes('QT-1042'), blockedPreview.payload?.text);

// --- automations ------------------------------------------------------------
const automations = await call(controller.listAutomations);
ok('seeded automations are listed', automations.payload?.length >= 12, automations.payload?.length);

const newAutomation = await call(controller.createAutomation, {
  body: {
    name: 'Custom welcome automation', trigger: 'new_whatsapp_lead', template: String(created.payload._id),
    actions: [{ type: 'send_template', config: {} }], delay: { value: 0, unit: 'minutes' }, status: 'draft',
  },
});
ok('automation created', newAutomation.code === 201, newAutomation.error?.message);
const pausedAutomation = await call(controller.updateAutomation, { params: { id: String(newAutomation.payload._id) }, body: { status: 'paused' } });
ok('automation can be paused', pausedAutomation.payload?.status === 'paused');

const inUse = await call(controller.deleteTemplate, { params: { id: String(created.payload._id) } });
ok('a template still used by an automation cannot be deleted', inUse.error?.status === 409, inUse.error?.message);
await call(controller.deleteAutomation, { params: { id: String(newAutomation.payload._id) } });
const removed = await call(controller.deleteTemplate, { params: { id: String(created.payload._id) } });
ok('template deletes once nothing references it', removed.code === 204 && !removed.error, removed.error?.message);

// --- variable resolution and conditions -------------------------------------
const lead = await models.Lead.create({ title: 'Var test', contactName: 'Rahul Sharma', companyName: 'Northstar', budget: '1.5 lakh', leadScore: 84, createdBy: admin._id, updatedBy: admin._id });
const values = await resolveVariables({ lead, config: { companyName: 'Orbit CRM' } });
ok('first name is derived from the full name', values.first_name === 'Rahul', values.first_name);
ok('business name comes from the AI configuration', values.business_name === 'Orbit CRM');
ok('unknown values resolve to empty rather than undefined', values.quote_number === '', values.quote_number);

const rendered = renderTemplate('Hi {{first_name}}\nQuote: {{quote_number}}\nBudget: {{budget}}', values);
ok('a line whose variable is missing is dropped', !rendered.text.includes('Quote:') && rendered.text.includes('Budget: 1.5 lakh'), rendered.text);
ok('missing variables are reported', rendered.missing.includes('quote_number'), rendered.missing);
ok('no placeholder survives rendering', !rendered.text.includes('{{'), rendered.text);

const fallback = renderTemplate('Hi {{first_name}}, welcome', {});
ok('a missing name falls back to natural wording', fallback.text === 'Hi there, welcome', fallback.text);

const required = renderTemplate('Quote {{quote_number}}', {}, ['quote_number']);
ok('a missing required variable blocks the send', required.blocked === true);

const asked = renderTemplate('Name: {{name}}\nBudget: {{budget}}', { name: 'Rahul Sharma', budget: '' }, [], true);
ok('ask mode drops what is known and keeps what is missing', asked.text === 'Budget:', asked.text);

ok('conditions gate on lead score', evaluateConditions([{ field: 'lead.leadScore', operator: 'gte', value: 80 }], { lead }).passed === true);
ok('a failing condition is reported with its rule', evaluateConditions([{ field: 'lead.leadScore', operator: 'gt', value: 90 }], { lead }).failed?.field === 'lead.leadScore');
ok('an unknown field fails closed', evaluateConditions([{ field: 'lead.nonsense', operator: 'exists' }], { lead }).passed === false);

// --- logs -------------------------------------------------------------------
await dispatchTrigger('quotation_created', { lead, data: { quote_number: 'QT-1', quote_amount: '₹1,000' } });
const logs = await call(controller.listLogs, { query: {} });
ok('automation runs are logged and paginated', logs.payload?.data?.length > 0 && logs.payload?.pagination?.total > 0, logs.payload?.pagination);
const skipped = await call(controller.listLogs, { query: { status: 'skipped' } });
ok('logs can be filtered by status', (skipped.payload?.data ?? []).every((log: any) => log.status === 'skipped'));
const summary = await call(controller.logSummary);
ok('log summary counts runs by status', Array.isArray(summary.payload?.byStatus) && summary.payload.byStatus.length > 0, summary.payload);

// A lead with no conversation must never produce a phantom send.
ok('a lead with no WhatsApp conversation is skipped, not sent to',
  (await models.WhatsAppMessage.countDocuments({ lead: lead._id })) === 0);

await mongoose.disconnect();
await mongo.stop();
console.log(`\nautomation check complete — ${failures} failure(s)`);
if (failures) process.exit(1);
