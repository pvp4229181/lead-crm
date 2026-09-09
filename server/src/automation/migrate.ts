// Idempotent migration from the pre-ARIA automation system to the ARIA template pack.
//
// Safe to run any number of times: templates and automations are upserted on their key,
// and the only things ever deleted are rows this codebase itself seeded (the legacy
// follow-up rules and the two demo Meta templates). Anything an admin created is left
// alone, and every deletion is reported so nothing disappears silently.
import mongoose from 'mongoose';
import {
  Automation, AutomationTemplate, ScheduledAutomation, WhatsAppCampaign, WhatsAppTemplate,
} from '../models/index.js';
import { ARIA_AUTOMATIONS, ARIA_TEMPLATES, toTemplateDocument } from './aria-templates.js';

// The previous implementation's fingerprints. `followuprules` was a whole collection of
// hardcoded chase messages; the two Meta templates below were demo rows from the old seed.
const LEGACY_COLLECTIONS = ['followuprules'];
const LEGACY_META_TEMPLATE_NAMES = ['welcome_intro', 'demo_reminder'];

export type MigrationReport = {
  legacyFollowUpRulesRemoved: number;
  legacyMetaTemplatesRemoved: string[];
  legacyMetaTemplatesKept: { templateName: string; reason: string }[];
  templatesCreated: string[];
  templatesUpdated: string[];
  automationsCreated: string[];
  automationsUpdated: string[];
  warnings: string[];
};

/** Deletes the old FollowUpRule collection, which the ARIA automations fully replace. */
async function removeLegacyFollowUpRules(report: MigrationReport) {
  const db = mongoose.connection.db;
  if (!db) return;
  const existing = await db.listCollections().toArray();
  for (const name of LEGACY_COLLECTIONS) {
    if (!existing.some(collection => collection.name === name)) continue;
    const collection = db.collection(name);
    const rules = await collection.find({}).project({ _id: 1, name: 1 }).toArray();
    if (rules.length) console.log(`[migrate] removing ${rules.length} legacy follow-up rule(s): ${rules.map(rule => rule.name ?? rule._id).join(', ')}`);
    const outcome = await collection.deleteMany({});
    report.legacyFollowUpRulesRemoved += outcome.deletedCount ?? 0;
    await collection.drop().catch(() => undefined);
  }
}

/**
 * Removes the two demo Meta templates the old seed shipped. The Meta template registry
 * itself stays — it is the WhatsApp Cloud API's own approved-template list, not part of
 * the automation system — but a demo row still referenced by a campaign or the auto-greet
 * setting is kept and reported instead of being deleted out from under it.
 */
async function removeLegacyMetaTemplates(report: MigrationReport) {
  const legacy = await WhatsAppTemplate.find({ templateName: { $in: LEGACY_META_TEMPLATE_NAMES } });
  for (const template of legacy) {
    const campaigns = await WhatsAppCampaign.countDocuments({ template: template._id });
    if (campaigns > 0) {
      report.legacyMetaTemplatesKept.push({ templateName: template.templateName, reason: `still used by ${campaigns} campaign(s)` });
      continue;
    }
    // Never leave the auto-greet setting pointing at a template that no longer exists.
    const { AIConfiguration } = await import('../models/index.js');
    await AIConfiguration.updateMany({ autoGreetTemplate: template._id }, { $unset: { autoGreetTemplate: 1 }, $set: { autoGreetNewLeads: false } });
    await template.deleteOne();
    report.legacyMetaTemplatesRemoved.push(template.templateName);
  }
}

/** Upserts the twelve ARIA templates (plus the two supporting ones) by templateKey. */
async function seedTemplates(report: MigrationReport) {
  for (const seed of ARIA_TEMPLATES) {
    const document = toTemplateDocument(seed);
    const existing = await AutomationTemplate.findOne({ templateKey: seed.templateKey });
    if (!existing) {
      await AutomationTemplate.create(document);
      report.templatesCreated.push(seed.templateKey);
      continue;
    }
    // Re-running the seed must not silently overwrite wording an admin has edited. Only
    // structural fields (trigger, category, declared variables) are refreshed.
    const structural = {
      trigger: document.trigger, category: document.category,
      variables: document.variables, requiredVariables: document.requiredVariables,
      internalOnly: document.internalOnly, askMode: document.askMode,
      source: 'aria' as const, isSystem: true,
    };
    await AutomationTemplate.updateOne({ _id: existing._id }, { $set: structural });
    report.templatesUpdated.push(seed.templateKey);
  }
}

async function seedAutomations(report: MigrationReport) {
  for (const seed of ARIA_AUTOMATIONS) {
    const template = seed.templateKey ? await AutomationTemplate.findOne({ templateKey: seed.templateKey }).select('_id') : null;
    if (seed.templateKey && !template) {
      report.warnings.push(`Automation "${seed.automationKey}" references missing template "${seed.templateKey}"`);
      continue;
    }
    const existing = await Automation.findOne({ automationKey: seed.automationKey });
    const document = {
      name: seed.name, description: seed.description, trigger: seed.trigger,
      template: template?._id, actions: seed.actions ?? [], conditions: seed.conditions ?? [],
      delay: seed.delay ?? { value: 0, unit: 'minutes' },
      maxAttempts: seed.maxAttempts ?? 1, repeatEveryHours: seed.repeatEveryHours ?? 0,
      stopOn: seed.stopOn ?? [], priority: seed.priority ?? 100,
      source: 'aria' as const, isSystem: true,
    };
    if (!existing) {
      await Automation.create({ ...document, automationKey: seed.automationKey, status: 'active' });
      report.automationsCreated.push(seed.automationKey);
      continue;
    }
    // The admin's own status (paused/active) and delay tuning are preserved.
    await Automation.updateOne({ _id: existing._id }, {
      $set: { trigger: document.trigger, template: document.template, source: 'aria', isSystem: true, stopOn: document.stopOn },
    });
    report.automationsUpdated.push(seed.automationKey);
  }
}

export async function migrateToAriaAutomation(): Promise<MigrationReport> {
  const report: MigrationReport = {
    legacyFollowUpRulesRemoved: 0, legacyMetaTemplatesRemoved: [], legacyMetaTemplatesKept: [],
    templatesCreated: [], templatesUpdated: [], automationsCreated: [], automationsUpdated: [], warnings: [],
  };

  await removeLegacyFollowUpRules(report);
  await removeLegacyMetaTemplates(report);
  await seedTemplates(report);
  await seedAutomations(report);

  // Queued runs pointing at automations that no longer exist would sit pending forever.
  const liveIds = await Automation.distinct('_id');
  const orphaned = await ScheduledAutomation.updateMany(
    { status: 'pending', automation: { $nin: liveIds } },
    { $set: { status: 'cancelled', error: 'Automation removed during ARIA migration' } },
  );
  if (orphaned.modifiedCount) report.warnings.push(`Cancelled ${orphaned.modifiedCount} scheduled run(s) whose automation no longer exists`);

  const custom = await AutomationTemplate.countDocuments({ source: 'custom' });
  if (custom) report.warnings.push(`${custom} admin-created template(s) left untouched`);

  return report;
}

export function printMigrationReport(report: MigrationReport) {
  console.log('\nARIA automation migration');
  console.log(`  legacy follow-up rules removed : ${report.legacyFollowUpRulesRemoved}`);
  console.log(`  legacy Meta templates removed  : ${report.legacyMetaTemplatesRemoved.join(', ') || 'none'}`);
  for (const kept of report.legacyMetaTemplatesKept) console.log(`  kept "${kept.templateName}" — ${kept.reason}`);
  console.log(`  ARIA templates created         : ${report.templatesCreated.length} (${report.templatesCreated.join(', ') || '—'})`);
  console.log(`  ARIA templates refreshed       : ${report.templatesUpdated.length}`);
  console.log(`  ARIA automations created       : ${report.automationsCreated.length} (${report.automationsCreated.join(', ') || '—'})`);
  console.log(`  ARIA automations refreshed     : ${report.automationsUpdated.length}`);
  for (const warning of report.warnings) console.log(`  note: ${warning}`);
}
