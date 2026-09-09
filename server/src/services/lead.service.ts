import mongoose from 'mongoose';
import { Lead, TimelineEvent, WhatsAppConversation } from '../models/index.js';
import type { ConversationAnalysis } from '../ai/provider.js';
import { calculateLeadScore, classifyTemperature, isHotTemperature, isNearTermTimeline, scoringRules } from './qualification.service.js';
import { convertLead } from './crm.service.js';
import { ensureSystemUser } from '../utils/systemUser.js';
import { getActiveAIConfig } from './ai.service.js';

// Automatic CRM stage movement (spec §6): only ever moves forward along this order (or
// sideways into 'lost'), so a stray "just curious" message can't undo real qualification
// progress. `moveQualificationStage` is the only writer, and automations go through it too.
export const STAGE_ORDER = ['new', 'contacted', 'engaged', 'qualified', 'proposal', 'negotiation', 'won', 'lost'] as const;
export type Stage = (typeof STAGE_ORDER)[number];
const rank = (stage: string) => STAGE_ORDER.indexOf(stage as Stage);
export const isStage = (value: string): value is Stage => STAGE_ORDER.includes(value as Stage);

function nextStage(current: Stage, analysis: ConversationAnalysis, hasRequirements: boolean, messageCount: number): Stage {
  if (analysis.intent === 'NOT_INTERESTED' && analysis.sentimentConfidence >= 0.6) return 'lost';
  if (current === 'new') return 'contacted';
  // Real qualification data beats the engagement heuristic: a lead that stated a budget or
  // requirement is qualified, not merely engaged, however few messages it took.
  if ((current === 'contacted' || current === 'engaged') && hasRequirements) return 'qualified';
  if (current === 'contacted' && messageCount > 2) return 'engaged';
  if (current === 'qualified' && (analysis.wantsPricing || analysis.intent === 'PRICING_REQUEST')) return 'proposal';
  if (current === 'proposal' && analysis.intent === 'NEGOTIATION') return 'negotiation';
  if ((current === 'proposal' || current === 'negotiation') && analysis.buyingIntent && analysis.intent === 'PURCHASE_INTENT') return 'won';
  return current;
}

/**
 * Moves a lead's qualification stage, refusing to go backwards unless explicitly allowed.
 * Returns whether the stage actually changed, and logs a timeline entry when it does.
 */
export async function moveQualificationStage(lead: any, target: string, allowBackward = false): Promise<boolean> {
  if (!isStage(target)) return false;
  const current = (lead.qualificationStatus ?? 'new') as Stage;
  const forward = rank(target) > rank(current) || (target === 'lost' && current !== 'lost');
  if (!forward && !allowBackward) return false;
  if (target === current) return false;

  const systemUserId = await ensureSystemUser();
  lead.qualificationStatus = target;
  if (target === 'qualified') lead.status = 'qualified';
  if (target === 'lost') lead.status = 'disqualified';
  lead.updatedBy = new mongoose.Types.ObjectId(systemUserId);
  await lead.save();

  await TimelineEvent.create({
    createdBy: systemUserId, relatedModel: 'Lead', relatedId: lead._id,
    eventType: 'stage_changed', message: `ARIA moved lead to "${target}"${lead.leadTemperature ? ` (${lead.leadTemperature})` : ''}`,
  });
  if (target === 'won') {
    // Already converted, or no pipeline stage configured — leave it as a won qualification.
    try { await convertLead(String(lead._id), new mongoose.Types.ObjectId(systemUserId)); } catch { /* non-fatal */ }
  }
  return true;
}

export type ApplyAnalysisResult = { lead: InstanceType<typeof Lead>; stageChanged: boolean; becameHot: boolean };

// Folds the AI's read of the conversation into the CRM lead: merge in newly-learned facts
// (never blanking out something already known), recompute score/temperature, and move the
// qualification stage forward when warranted. Notifications and hot-lead alerts are raised
// by the automation engine, not here.
export async function applyAnalysisToLead(leadId: mongoose.Types.ObjectId | string, analysis: ConversationAnalysis, messageCount: number): Promise<ApplyAnalysisResult> {
  const lead = await Lead.findById(leadId);
  if (!lead) throw new Error('Lead not found for AI analysis');
  const config = await getActiveAIConfig();
  const rules = scoringRules(config);
  const wasHot = isHotTemperature(lead.leadTemperature);

  if (analysis.customerName && !lead.contactName) lead.contactName = analysis.customerName;
  if (analysis.companyName && !lead.companyName) lead.companyName = analysis.companyName;
  if (analysis.email && !lead.email) lead.email = analysis.email;
  if (analysis.location && !lead.location) lead.location = analysis.location;
  if (analysis.budget) lead.budget = analysis.budget;
  if (analysis.purchaseTimeline) lead.purchaseTimeline = analysis.purchaseTimeline;
  if (analysis.quantity) lead.quantity = analysis.quantity;
  if (analysis.requirements.length) lead.requirements = [...new Set([...(lead.requirements ?? []), ...analysis.requirements])];
  if (analysis.productInterest.length) lead.productInterest = [...new Set([...(lead.productInterest ?? []), ...analysis.productInterest])];
  if (analysis.painPoints.length) lead.painPoints = [...new Set([...(lead.painPoints ?? []), ...analysis.painPoints])];
  if (analysis.objections.length) lead.objections = [...new Set([...(lead.objections ?? []), ...analysis.objections])];
  lead.customerIntent = analysis.intent;
  if (analysis.summary) lead.aiSummary = analysis.summary;
  if (analysis.recommendedNextAction) lead.recommendedNextAction = analysis.recommendedNextAction;
  lead.salesProbability = analysis.salesProbability;
  lead.lastAiAnalysisAt = new Date();

  const { score, reasons } = calculateLeadScore({
    messageCount,
    hasCompany: Boolean(lead.companyName), hasEmail: Boolean(lead.email), hasBudget: Boolean(lead.budget),
    timelineUnder30Days: isNearTermTimeline(lead.purchaseTimeline),
    requestedPricing: analysis.wantsPricing,
    requestedDemo: analysis.wantsDemo || analysis.wantsMeeting,
    requestedQuotation: analysis.intent === 'PRICING_REQUEST' && Boolean(lead.budget),
    requestedHuman: analysis.wantsHuman,
  }, rules);
  lead.leadScore = score;
  lead.leadTemperature = classifyTemperature(score, rules);
  lead.qualificationReason = reasons.join('; ') || undefined;

  const systemUserId = await ensureSystemUser();
  lead.updatedBy = new mongoose.Types.ObjectId(systemUserId);
  await lead.save();

  const hasRequirements = lead.requirements.length > 0 || Boolean(lead.budget) || Boolean(lead.purchaseTimeline);
  const proposed = nextStage((lead.qualificationStatus ?? 'new') as Stage, analysis, hasRequirements, messageCount);
  const stageChanged = await moveQualificationStage(lead, proposed);

  const becameHot = !wasHot && isHotTemperature(lead.leadTemperature);
  return { lead, stageChanged, becameHot };
}

export async function assignSalespersonRoundRobin(): Promise<mongoose.Types.ObjectId | undefined> {
  // Simple, deterministic round robin across active Salespersons by least-recently-assigned lead.
  const { User, Role } = await import('../models/index.js');
  const role = await Role.findOne({ name: 'Salesperson' }).select('_id');
  if (!role) return undefined;
  const candidates = await User.find({ role: role._id, active: true }).select('_id').lean();
  if (!candidates.length) return undefined;
  const counts = await Lead.aggregate([{ $match: { salesperson: { $in: candidates.map(c => c._id) } } }, { $group: { _id: '$salesperson', count: { $sum: 1 } } }]);
  const countMap = new Map(counts.map(c => [String(c._id), c.count]));
  candidates.sort((a, b) => (countMap.get(String(a._id)) ?? 0) - (countMap.get(String(b._id)) ?? 0));
  return candidates[0]?._id;
}

export async function conversationForLead(leadId: mongoose.Types.ObjectId | string) {
  return WhatsAppConversation.findOne({ lead: leadId });
}

/** The qualification fields ARIA is still missing, in the order it should ask for them. */
export function missingQualificationFields(lead: any): string[] {
  const checks: [string, unknown][] = [
    ['name', lead?.contactName],
    ['company', lead?.companyName],
    ['email', lead?.email],
    ['interest', lead?.productInterest?.length || lead?.requirements?.length],
    ['budget', lead?.budget],
    ['timeline', lead?.purchaseTimeline],
  ];
  return checks.filter(([, value]) => !value).map(([field]) => field);
}
