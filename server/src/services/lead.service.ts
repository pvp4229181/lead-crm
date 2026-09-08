import mongoose from 'mongoose';
import { Lead, TimelineEvent, WhatsAppConversation } from '../models/index.js';
import type { ConversationAnalysis } from '../ai/provider.js';
import { calculateLeadScore, classifyTemperature } from './qualification.service.js';
import { convertLead } from './crm.service.js';
import { ensureSystemUser } from '../utils/systemUser.js';
import { notifyUsers } from './notification.service.js';

// Automatic CRM Stage Movement: only ever moves forward along this order (or sideways
// into 'lost'), so a stray "just curious" message can't undo real qualification progress.
const STAGE_ORDER = ['new', 'contacted', 'qualified', 'proposal', 'negotiation', 'won', 'lost'] as const;
type Stage = (typeof STAGE_ORDER)[number];
const rank = (stage: string) => STAGE_ORDER.indexOf(stage as Stage);

function nextStage(current: Stage, analysis: ConversationAnalysis, hasRequirements: boolean): Stage {
  if (analysis.intent === 'NOT_INTERESTED' && analysis.sentimentConfidence >= 0.6) return 'lost';
  if (current === 'new') return 'contacted';
  if (current === 'contacted' && hasRequirements) return 'qualified';
  if (current === 'qualified' && (analysis.wantsPricing || analysis.intent === 'PRICING_REQUEST')) return 'proposal';
  if (current === 'proposal' && analysis.intent === 'NEGOTIATION') return 'negotiation';
  if ((current === 'proposal' || current === 'negotiation') && analysis.buyingIntent && analysis.intent === 'PURCHASE_INTENT') return 'won';
  return current;
}

export type ApplyAnalysisResult = { lead: InstanceType<typeof Lead>; stageChanged: boolean; becameHot: boolean };

// Step 11 of the pipeline: fold the AI's read of the conversation into the CRM lead —
// merge in newly-learned facts (never blank out something already known), recompute
// score/temperature, and move the qualification stage forward when warranted.
export async function applyAnalysisToLead(leadId: mongoose.Types.ObjectId | string, analysis: ConversationAnalysis, messageCount: number): Promise<ApplyAnalysisResult> {
  const lead = await Lead.findById(leadId);
  if (!lead) throw new Error('Lead not found for AI analysis');
  const wasHot = lead.leadTemperature === 'Hot' || lead.leadTemperature === 'Very Hot';

  if (analysis.customerName && !lead.contactName) lead.contactName = analysis.customerName;
  if (analysis.companyName && !lead.companyName) lead.companyName = analysis.companyName;
  if (analysis.email && !lead.email) lead.email = analysis.email;
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

  const score = calculateLeadScore({
    messageCount,
    hasName: Boolean(lead.contactName), hasCompany: Boolean(lead.companyName),
    hasBudget: Boolean(lead.budget), hasTimeline: Boolean(lead.purchaseTimeline),
    requestedPricing: analysis.wantsPricing, requestedDemo: analysis.wantsDemo, requestedMeeting: analysis.wantsMeeting,
    buyingIntent: analysis.buyingIntent,
  });
  lead.leadScore = score;
  lead.leadTemperature = classifyTemperature(score);

  const hasRequirements = lead.requirements.length > 0 || Boolean(lead.budget) || Boolean(lead.purchaseTimeline);
  const current = (lead.qualificationStatus ?? 'new') as Stage;
  const proposed = nextStage(current, analysis, hasRequirements);
  const stageChanged = rank(proposed) > rank(current) || (proposed === 'lost' && current !== 'lost');
  if (stageChanged) {
    lead.qualificationStatus = proposed;
    if (proposed === 'qualified') lead.status = 'qualified';
    if (proposed === 'lost') lead.status = 'disqualified';
  }

  const systemUserId = await ensureSystemUser();
  lead.updatedBy = new mongoose.Types.ObjectId(systemUserId);
  await lead.save();

  if (stageChanged) {
    await TimelineEvent.create({
      createdBy: systemUserId, relatedModel: 'Lead', relatedId: lead._id,
      eventType: 'stage_changed', message: `AI moved lead to "${proposed}"${lead.leadTemperature ? ` (${lead.leadTemperature})` : ''}`,
    });
    if (proposed === 'won') {
      try { await convertLead(String(lead._id), new mongoose.Types.ObjectId(systemUserId)); } catch { /* already converted or no pipeline stage configured — leave as won qualification only */ }
    }
  }

  const becameHot = !wasHot && (lead.leadTemperature === 'Hot' || lead.leadTemperature === 'Very Hot');
  if (becameHot && lead.salesperson) {
    await notifyUsers([lead.salesperson], 'hot_lead', 'Hot lead detected', `${lead.contactName || lead.title} is now a ${lead.leadTemperature} lead.`, `/leads`);
  }

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
