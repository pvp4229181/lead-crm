import type { Request, Response } from 'express';
import {
  Automation, AutomationLog, AutomationTemplate, Lead, ScheduledAutomation, WhatsAppConversation,
} from '../models/index.js';
import { ApiError, escapeRegex } from '../utils/http.js';
import {
  automationInput, automationTemplateInput, logListQuery, templateListQuery, templateTestInput,
} from '../validators/automation.validators.js';
import { TRIGGERS } from './trigger.service.js';
import { AVAILABLE_VARIABLES } from './variable.service.js';
import { CONDITION_FIELDS } from './condition.service.js';
import { ACTION_TYPES, TEMPLATE_CATEGORIES, TEMPLATE_STATUSES } from '../models/automation.js';
import { duplicateTemplate, previewWithSamples, renderForContext, syncDeclaredVariables } from './template.service.js';
import { executeTemplate } from './automation.executor.js';
import { migrateToAriaAutomation } from './migrate.js';
import { getActiveAIConfig } from '../services/ai.service.js';

const templatePopulate = [{ path: 'assignedAgent', select: 'name avatar' }, { path: 'assignedPipeline', select: 'name color' }];

// --- Templates -------------------------------------------------------------

export async function listTemplates(req: Request, res: Response) {
  const query = templateListQuery.parse(req.query);
  const filter: Record<string, unknown> = {};
  if (query.category) filter.category = query.category;
  if (query.status) filter.status = query.status;
  if (query.trigger) filter.trigger = query.trigger;
  if (query.search) {
    const pattern = new RegExp(escapeRegex(query.search), 'i');
    filter.$or = [{ templateName: pattern }, { templateKey: pattern }, { description: pattern }, { message: pattern }];
  }
  res.json(await AutomationTemplate.find(filter).populate(templatePopulate).sort({ priority: 1, updatedAt: -1 }).limit(300).lean());
}

export async function getTemplate(req: Request, res: Response) {
  const template = await AutomationTemplate.findById(req.params.id).populate(templatePopulate).lean();
  if (!template) throw new ApiError(404, 'Template not found');
  res.json(template);
}

export async function createTemplate(req: Request, res: Response) {
  const input = syncDeclaredVariables(automationTemplateInput.parse(req.body));
  if (await AutomationTemplate.exists({ templateKey: input.templateKey })) throw new ApiError(409, `A template with the key "${input.templateKey}" already exists`);
  const template = await AutomationTemplate.create({ ...input, source: 'custom', createdBy: req.user!._id, updatedBy: req.user!._id });
  res.status(201).json(template);
}

export async function updateTemplate(req: Request, res: Response) {
  const input = syncDeclaredVariables(automationTemplateInput.partial().parse(req.body));
  // The key is an identifier other records point at, so it is fixed once created.
  delete (input as any).templateKey;
  const template = await AutomationTemplate.findByIdAndUpdate(req.params.id, { ...input, updatedBy: req.user!._id }, { new: true, runValidators: true });
  if (!template) throw new ApiError(404, 'Template not found');
  res.json(template);
}

export async function deleteTemplate(req: Request, res: Response) {
  const template = await AutomationTemplate.findById(req.params.id);
  if (!template) throw new ApiError(404, 'Template not found');
  const used = await Automation.countDocuments({ template: template._id });
  if (used) throw new ApiError(409, `Cannot delete: ${used} automation${used === 1 ? '' : 's'} still use${used === 1 ? 's' : ''} this template`);
  await template.deleteOne();
  res.status(204).end();
}

export async function duplicate(req: Request, res: Response) {
  const copy = await duplicateTemplate(String(req.params.id), req.user!._id);
  if (!copy) throw new ApiError(404, 'Template not found');
  res.status(201).json(copy);
}

/** Enable / disable without opening the editor — the table's toggle. */
export async function setTemplateStatus(req: Request, res: Response) {
  const status = String(req.body.status);
  if (!(TEMPLATE_STATUSES as readonly string[]).includes(status)) throw new ApiError(422, 'Invalid status');
  const template = await AutomationTemplate.findByIdAndUpdate(req.params.id, { status, updatedBy: req.user!._id }, { new: true });
  if (!template) throw new ApiError(404, 'Template not found');
  res.json(template);
}

/**
 * POST /automation-templates/:id/test
 *
 * Renders the template against real records when a conversation or lead is given, and
 * against the sample values otherwise. Only actually delivers when `send` is true, so the
 * default is a safe dry run.
 */
export async function testTemplate(req: Request, res: Response) {
  const input = templateTestInput.parse(req.body ?? {});
  const template = await AutomationTemplate.findById(req.params.id);
  if (!template) throw new ApiError(404, 'Template not found');

  const conversation = input.conversation ? await WhatsAppConversation.findById(input.conversation) : null;
  const lead = input.lead ? await Lead.findById(input.lead) : conversation?.lead ? await Lead.findById(conversation.lead) : null;

  if (!conversation && !lead) {
    const preview = previewWithSamples(template.message, input.data, template.askMode === true);
    return res.json({ ...preview, sent: false, usingSamples: true });
  }

  const rendered = await renderForContext(template, { conversation, lead, config: await getActiveAIConfig(), data: input.data });
  if (!input.send) return res.json({ text: rendered.text, missing: rendered.missing, blocked: rendered.blocked, sent: false, usingSamples: false });
  if (!conversation) throw new ApiError(422, 'Select a conversation to send the test to');

  const result = await executeTemplate(template, { trigger: template.trigger, conversation, lead, data: input.data });
  await AutomationTemplate.updateOne({ _id: template._id }, { lastTestedAt: new Date() });
  res.json({ text: rendered.text, missing: rendered.missing, blocked: rendered.blocked, sent: result.status === 'completed', status: result.status, reason: result.reason });
}

// --- Automations -----------------------------------------------------------

export async function listAutomations(_req: Request, res: Response) {
  res.json(await Automation.find({}).populate('template', 'templateName templateKey category status').populate('assignedAgent', 'name avatar').sort({ priority: 1, updatedAt: -1 }).limit(300).lean());
}

export async function createAutomation(req: Request, res: Response) {
  const input = automationInput.parse(req.body);
  const automation = await Automation.create({ ...input, source: 'custom', createdBy: req.user!._id, updatedBy: req.user!._id });
  res.status(201).json(automation);
}

export async function updateAutomation(req: Request, res: Response) {
  const input = automationInput.partial().parse(req.body);
  const automation = await Automation.findByIdAndUpdate(req.params.id, { ...input, updatedBy: req.user!._id }, { new: true, runValidators: true });
  if (!automation) throw new ApiError(404, 'Automation not found');
  res.json(automation);
}

export async function deleteAutomation(req: Request, res: Response) {
  const automation = await Automation.findByIdAndDelete(req.params.id);
  if (!automation) throw new ApiError(404, 'Automation not found');
  // Queued runs for a deleted automation would never resolve.
  await ScheduledAutomation.updateMany({ automation: automation._id, status: 'pending' }, { $set: { status: 'cancelled', error: 'Automation deleted' } });
  res.status(204).end();
}

// --- Logs, catalogue, migration -------------------------------------------

export async function listLogs(req: Request, res: Response) {
  const query = logListQuery.parse(req.query);
  const filter: Record<string, unknown> = {};
  for (const key of ['status', 'trigger', 'automation', 'conversation'] as const) if (query[key]) filter[key] = query[key];
  const [data, total] = await Promise.all([
    AutomationLog.find(filter)
      .populate('automation', 'name automationKey').populate('template', 'templateName templateKey')
      .populate('lead', 'contactName companyName phone').populate('conversation', 'phoneNumber customerName')
      .sort('-createdAt').skip((query.page - 1) * query.limit).limit(query.limit).lean(),
    AutomationLog.countDocuments(filter),
  ]);
  res.json({ data, pagination: { page: query.page, limit: query.limit, total, pages: Math.ceil(total / query.limit) } });
}

export async function logSummary(_req: Request, res: Response) {
  const since = new Date(Date.now() - 7 * 86400000);
  const [byStatus, pending] = await Promise.all([
    AutomationLog.aggregate([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    ScheduledAutomation.countDocuments({ status: 'pending' }),
  ]);
  res.json({ byStatus, pendingScheduled: pending });
}

/** Everything the template editor needs to render its pickers, in one request. */
export async function catalogue(_req: Request, res: Response) {
  res.json({
    triggers: TRIGGERS,
    variables: AVAILABLE_VARIABLES,
    categories: TEMPLATE_CATEGORIES,
    statuses: TEMPLATE_STATUSES,
    actionTypes: ACTION_TYPES,
    conditionFields: CONDITION_FIELDS,
  });
}

/** Re-runs the ARIA migration/seed from the CRM. Idempotent; admin-only at the route. */
export async function runMigration(_req: Request, res: Response) {
  res.json(await migrateToAriaAutomation());
}
