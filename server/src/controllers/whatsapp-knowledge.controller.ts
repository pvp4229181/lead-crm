import type { Request, Response } from 'express';
import type mongoose from 'mongoose';
import { Contact, FAQ, KnowledgeArticle, Product, Service, WhatsAppCampaign, WhatsAppTemplate, Lead } from '../models/index.js';
import { ApiError } from '../utils/http.js';
import { normalizePhone } from '../utils/phone.js';
import { productInput, serviceInput, faqInput, articleInput, templateInput, campaignInput } from '../validators/whatsapp.validators.js';
import { fetchMessageTemplates, sendTemplateMessage } from '../services/whatsapp.service.js';

// Products, Services, FAQs and Knowledge Articles are all simple admin-curated
// content the AI retrieves from (see knowledge.service.ts) — same CRUD shape for each.
const asAny = (model: unknown) => model as mongoose.Model<any>;
const registry = {
  products: { model: asAny(Product), schema: productInput },
  services: { model: asAny(Service), schema: serviceInput },
  faqs: { model: asAny(FAQ), schema: faqInput },
  articles: { model: asAny(KnowledgeArticle), schema: articleInput },
};
type Kind = keyof typeof registry;

export const listKnowledge = (kind: Kind) => async (_req: Request, res: Response) => {
  const { model } = registry[kind];
  res.json(await model.find({}).sort('-createdAt').limit(500));
};
export const createKnowledge = (kind: Kind) => async (req: Request, res: Response) => {
  const { model, schema } = registry[kind];
  res.status(201).json(await model.create(schema.parse(req.body)));
};
export const updateKnowledge = (kind: Kind) => async (req: Request, res: Response) => {
  const { model, schema } = registry[kind];
  const doc = await model.findByIdAndUpdate(req.params.id, schema.partial().parse(req.body), { new: true, runValidators: true });
  if (!doc) throw new ApiError(404, 'Record not found');
  res.json(doc);
};
export const deleteKnowledge = (kind: Kind) => async (req: Request, res: Response) => {
  const { model } = registry[kind];
  const doc = await model.findByIdAndDelete(req.params.id);
  if (!doc) throw new ApiError(404, 'Record not found');
  res.status(204).end();
};

export async function listTemplates(_req: Request, res: Response) { res.json(await WhatsAppTemplate.find({}).sort('-createdAt')); }
export async function createTemplate(req: Request, res: Response) { res.status(201).json(await WhatsAppTemplate.create(templateInput.parse(req.body))); }
export async function updateTemplate(req: Request, res: Response) {
  const doc = await WhatsAppTemplate.findByIdAndUpdate(req.params.id, templateInput.partial().parse(req.body), { new: true, runValidators: true });
  if (!doc) throw new ApiError(404, 'Template not found');
  res.json(doc);
}
// POST /whatsapp/templates/sync — pull the WABA's real templates in from Meta.
// Without this the picker is empty and users type a template name by hand, which is how
// you get "(#132001) Template name does not exist" for a human phrase like "hi sir".
// Upserted on (templateName, language) — the collection's unique key — so re-syncing
// refreshes approval status rather than duplicating.
export async function syncTemplates(_req: Request, res: Response) {
  const result = await fetchMessageTemplates();
  if (!result.ok) throw new ApiError(502, result.error ?? 'Could not load templates from Meta');

  let created = 0;
  let updated = 0;
  for (const template of result.templates) {
    // Meta has categories we don't model (and adds more over time); anything unknown is
    // stored as UTILITY so one unrecognised category can't fail the whole sync.
    const category = ['MARKETING', 'UTILITY', 'AUTHENTICATION'].includes(template.category ?? '') ? template.category : 'UTILITY';
    const status = ['APPROVED', 'REJECTED'].includes(template.status) ? template.status : 'PENDING';
    const outcome = await WhatsAppTemplate.updateOne(
      { templateName: template.name, language: template.language },
      {
        $set: {
          category, status, metaTemplateId: template.metaTemplateId,
          header: template.header, footer: template.footer, buttons: template.buttons,
          // A template can legitimately have an empty body (media-only); the field is
          // required, so fall back to the name rather than failing the upsert.
          body: template.body || template.name,
          variableSample: Array.from({ length: template.variableCount }, (_, i) => `{{${i + 1}}}`),
        },
      },
      { upsert: true },
    );
    if (outcome.upsertedCount) created += 1; else if (outcome.modifiedCount) updated += 1;
  }

  const templates = await WhatsAppTemplate.find({}).sort('-createdAt');
  res.json({ created, updated, total: result.templates.length, templates });
}

export async function deleteTemplate(req: Request, res: Response) {
  const doc = await WhatsAppTemplate.findByIdAndDelete(req.params.id);
  if (!doc) throw new ApiError(404, 'Template not found');
  res.status(204).end();
}

export async function listCampaigns(_req: Request, res: Response) { res.json(await WhatsAppCampaign.find({}).populate('template', 'templateName category').sort('-createdAt')); }

async function resolveAudience(audience: Record<string, any>) {
  const filter: Record<string, unknown> = { phone: { $exists: true, $ne: '' } };
  if (audience.stage?.length) filter.qualificationStatus = { $in: audience.stage };
  if (audience.tags?.length) filter.tags = { $in: audience.tags };
  if (audience.temperature?.length) filter.leadTemperature = { $in: audience.temperature };
  if (audience.salesperson?.length) filter.salesperson = { $in: audience.salesperson };
  if (audience.source?.length) filter.source = { $in: audience.source };
  if (audience.lastActivityBefore || audience.lastActivityAfter) {
    filter.lastAiAnalysisAt = { ...(audience.lastActivityBefore ? { $lte: audience.lastActivityBefore } : {}), ...(audience.lastActivityAfter ? { $gte: audience.lastActivityAfter } : {}) };
  }
  const leads = await Lead.find(filter).select('_id phone contactName companyName').lean();

  // WhatsApp policy: never message a contact who has opted out. Contacts are matched by
  // normalized phone, since Lead stores a formatted number and Contact stores whatsappId.
  const optedOut = await Contact.find({ whatsappOptIn: false }).select('whatsappId phone mobile').lean();
  if (!optedOut.length) return leads;
  const blocked = new Set(optedOut.flatMap(c => [c.whatsappId, c.phone, c.mobile].filter(Boolean).map(v => normalizePhone(String(v)))));
  return leads.filter(lead => !blocked.has(normalizePhone(String(lead.phone ?? ''))));
}

export async function createCampaign(req: Request, res: Response) {
  const input = campaignInput.parse(req.body);
  const audience = await resolveAudience(input.audience);
  const campaign = await WhatsAppCampaign.create({ ...input, status: input.scheduledAt ? 'scheduled' : 'draft', audienceSize: audience.length, createdBy: req.user!._id });
  res.status(201).json(campaign);
}

export async function previewCampaignAudience(req: Request, res: Response) {
  const audience = campaignInput.shape.audience.parse(req.body.audience ?? {});
  const leads = await resolveAudience(audience);
  res.json({ count: leads.length, sample: leads.slice(0, 10) });
}

// WhatsApp only allows business-initiated messages via pre-approved templates
// (24-hour session rule), so campaign sends always go through sendTemplateMessage —
// never free-form text — respecting Meta's opt-in and template policies.
export async function sendCampaign(req: Request, res: Response) {
  const campaign = await WhatsAppCampaign.findById(req.params.id).populate('template');
  if (!campaign) throw new ApiError(404, 'Campaign not found');
  if (campaign.status === 'sending' || campaign.status === 'completed') throw new ApiError(409, 'Campaign already sent');
  const template = campaign.template as any;
  if (!template || template.status !== 'APPROVED') throw new ApiError(422, 'Select an approved template before sending');

  campaign.status = 'sending'; await campaign.save();
  const leads = await resolveAudience(campaign.audience as any);
  let sent = 0, failed = 0;
  for (const lead of leads) {
    if (!lead.phone) { failed += 1; continue; }
    const result = await sendTemplateMessage(lead.phone.replace(/[^\d]/g, ''), template.templateName, template.language ?? 'en_US');
    if (result.ok) sent += 1; else failed += 1;
  }
  campaign.sent = sent; campaign.failed = failed; campaign.audienceSize = leads.length; campaign.status = 'completed';
  await campaign.save();
  res.json(campaign);
}

export async function deleteCampaign(req: Request, res: Response) {
  const doc = await WhatsAppCampaign.findByIdAndDelete(req.params.id);
  if (!doc) throw new ApiError(404, 'Campaign not found');
  res.status(204).end();
}
