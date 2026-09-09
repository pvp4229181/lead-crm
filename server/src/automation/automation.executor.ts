// Runs one automation end to end: conditions → variables → template → action → log.
//
// Everything customer-visible funnels through `sendTemplateAction`, which is the only
// place in the codebase allowed to put an automation's words on a WhatsApp thread. It
// refuses to send when a human owns the conversation, when the contact opted out, or when
// the same automation attempt already sent (the retry guard).
import {
  Automation, AutomationTemplate, Contact, Lead, PipelineStage, Tag,
  WhatsAppConversation, WhatsAppMessage,
  type AutomationDoc, type AutomationTemplateDoc, type LogStatus,
} from '../models/index.js';
import { appendMessage } from '../services/conversation.service.js';
import { sendInteractiveButtons, sendTextMessage } from '../services/whatsapp.service.js';
import { getActiveAIConfig } from '../services/ai.service.js';
import { adminAndManagerIds, notifyUsers } from '../services/notification.service.js';
import { createFollowUpActivity } from '../services/activity.service.js';
import { emitToConversation } from '../realtime.js';
import { evaluateConditions, describeCondition } from './condition.service.js';
import { renderForContext } from './template.service.js';
import { finishLog, recordAction, startLog } from './automation-log.service.js';

export type ExecutionContext = {
  trigger: string;
  conversation?: any;
  lead?: any;
  contact?: any;
  intent?: string;
  /** Values supplied by the caller for variables the CRM does not store (quote, invoice…). */
  data?: Record<string, unknown>;
  attempt?: number;
  /** Overrides the computed idempotency key; used by the scheduler for retried runs. */
  dedupeKey?: string;
  /**
   * Identifies the event this run answers - the inbound WhatsApp message id, normally.
   * It scopes the idempotency key so a retry of the *same* event is blocked, while the
   * same automation firing again later (a second handoff request, say) is not.
   */
  occurrenceKey?: string;
  /** Test sends render and log but never touch WhatsApp. */
  dryRun?: boolean;
};

export type ExecutionResult = {
  status: LogStatus;
  reason?: string;
  text?: string;
  missing?: string[];
  messageId?: string;
  /** A message was put on the thread (even if WhatsApp then rejected the delivery). */
  delivered?: boolean;
};

const idOf = (value: any) => (value && typeof value === 'object' && '_id' in value ? value._id : value);

// Hydrates whatever the caller left as an id, so conditions and variables always see
// real documents rather than a mix of ObjectIds and populated objects.
async function hydrate(context: ExecutionContext) {
  const conversation = context.conversation && typeof context.conversation === 'object' && 'phoneNumber' in context.conversation
    ? context.conversation
    : context.conversation ? await WhatsAppConversation.findById(idOf(context.conversation)) : null;
  const lead = context.lead && typeof context.lead === 'object' && 'title' in context.lead
    ? context.lead
    : await Lead.findById(idOf(context.lead) ?? conversation?.lead).catch(() => null);
  const contact = context.contact && typeof context.contact === 'object' && 'name' in context.contact
    ? context.contact
    : conversation?.contact ? await Contact.findById(idOf(conversation.contact)).catch(() => null) : null;
  return { conversation, lead, contact };
}

/** Blocks customer-facing sends the CRM must never make. Internal alerts bypass this. */
function customerSendBlockedReason(conversation: any, contact: any): string | null {
  if (!conversation) return 'No WhatsApp conversation for this record';
  if (conversation.optedOut) return 'Customer opted out of WhatsApp messages';
  if (contact && contact.whatsappOptIn === false) return 'Contact opted out of WhatsApp messages';
  if (conversation.automationPaused) return 'Automation is paused for this conversation';
  if (conversation.mode === 'human' || conversation.controlStatus === 'HUMAN_ACTIVE') return 'A human agent has taken over this conversation';
  return null;
}

async function sendTemplateAction(
  template: AutomationTemplateDoc,
  automation: AutomationDoc | null,
  context: ExecutionContext,
  records: { conversation: any; lead: any; contact: any },
  config: any,
): Promise<ExecutionResult> {
  const rendered = await renderForContext(template, { ...records, config, data: context.data });
  if (!rendered.text) return { status: 'skipped', reason: 'Template rendered empty after variable resolution', missing: rendered.missing };
  if (rendered.blocked) return { status: 'skipped', reason: `Required variables missing: ${rendered.missing.join(', ')}`, missing: rendered.missing };

  // Internal alerts go to staff notifications, never to the lead's phone.
  if (template.internalOnly || template.messageType === 'internal') {
    const explicit = idOf(template.assignedAgent) ?? idOf(automation?.assignedAgent);
    const recipients = explicit ? [explicit] : records.lead?.salesperson ? [records.lead.salesperson] : await adminAndManagerIds();
    if (!recipients.length) return { status: 'skipped', reason: 'No internal recipient for this alert', text: rendered.text };
    if (!context.dryRun) await notifyUsers(recipients, 'automation', template.templateName, rendered.text, '/whatsapp');
    return { status: 'completed', text: rendered.text };
  }

  const blocked = customerSendBlockedReason(records.conversation, records.contact);
  if (blocked) return { status: 'skipped', reason: blocked, text: rendered.text };

  // Idempotency: one message per automation, per conversation, per triggering event. With
  // no occurrence key (a CRM-initiated send) it falls back to a one-minute bucket, which
  // still absorbs an accidental double-fire without muting the automation forever.
  const occurrence = context.occurrenceKey ?? `t${Math.floor(Date.now() / 60_000)}`;
  const dedupeKey = context.dedupeKey
    ?? `${automation ? String(automation._id) : template.templateKey}:${String(records.conversation._id)}:${context.attempt ?? 1}:${occurrence}`;
  if (await WhatsAppMessage.exists({ dedupeKey })) return { status: 'skipped', reason: 'Already sent for this automation attempt', text: rendered.text };

  if (context.dryRun) return { status: 'completed', text: rendered.text, missing: rendered.missing };

  const buttons = (template.buttons ?? []).filter(button => button.id && button.title).map(button => ({ id: button.id!, title: button.title! }));
  const result = template.messageType === 'interactive' && buttons.length
    ? await sendInteractiveButtons(records.conversation.phoneNumber, rendered.text, buttons)
    : await sendTextMessage(records.conversation.phoneNumber, rendered.text);

  try {
    const message = await appendMessage({
      conversation: records.conversation, direction: 'OUTBOUND',
      type: template.messageType === 'interactive' && buttons.length ? 'interactive' : 'text',
      text: rendered.text, aiGenerated: true,
      status: result.ok ? 'SENT' : 'FAILED', whatsappMessageId: result.whatsappMessageId,
      automation: automation?._id, automationTemplate: template._id, dedupeKey,
    });
    await WhatsAppConversation.updateOne({ _id: records.conversation._id }, { lastAutomationAt: new Date() });
    if (!result.ok) return { status: 'failed', reason: result.error ?? 'WhatsApp rejected the message', text: rendered.text, messageId: String(message._id) };
    return { status: 'completed', text: rendered.text, messageId: String(message._id) };
  } catch (error: any) {
    // A duplicate-key collision here means a concurrent run won the race — not a failure.
    if (error?.code === 11000) return { status: 'skipped', reason: 'Duplicate send prevented', text: rendered.text };
    throw error;
  }
}

async function runAction(
  action: { type: string; config?: any },
  template: AutomationTemplateDoc | null,
  automation: AutomationDoc | null,
  context: ExecutionContext,
  records: { conversation: any; lead: any; contact: any },
  config: any,
): Promise<ExecutionResult> {
  const settings = action.config ?? {};
  switch (action.type) {
    case 'send_template': {
      const target = settings.templateKey ? await AutomationTemplate.findOne({ templateKey: String(settings.templateKey).toLowerCase() }) : template;
      if (!target) return { status: 'skipped', reason: 'No template configured for this action' };
      return sendTemplateAction(target, automation, context, records, config);
    }
    case 'notify_agent': {
      const explicit = idOf(settings.agent) ?? idOf(automation?.assignedAgent);
      const recipients = explicit ? [explicit] : records.lead?.salesperson ? [records.lead.salesperson] : await adminAndManagerIds();
      if (!recipients.length) return { status: 'skipped', reason: 'No recipient to notify' };
      const title = settings.title ?? automation?.name ?? 'WhatsApp automation';
      const body = settings.message ?? `${records.lead?.contactName || records.conversation?.phoneNumber || 'A lead'} — ${context.trigger.replace(/_/g, ' ')}`;
      if (!context.dryRun) await notifyUsers(recipients, 'automation', title, body, '/whatsapp');
      return { status: 'completed' };
    }
    case 'create_activity': {
      if (!records.lead) return { status: 'skipped', reason: 'No lead to attach the activity to' };
      if (!context.dryRun) {
        await createFollowUpActivity({
          leadId: records.lead._id, assignedTo: records.lead.salesperson,
          kind: settings.kind ?? 'Follow-up',
          summary: settings.summary ?? `${automation?.name ?? 'Automation'} — ${records.lead.contactName || records.conversation?.phoneNumber || 'lead'}`,
          dueInHours: settings.dueInHours,
        });
      }
      return { status: 'completed' };
    }
    case 'assign_agent': {
      const agent = idOf(settings.agent) ?? idOf(automation?.assignedAgent);
      if (!agent) return { status: 'skipped', reason: 'No agent configured' };
      if (!context.dryRun) {
        if (records.conversation) await WhatsAppConversation.updateOne({ _id: records.conversation._id }, { assignedTo: agent });
        if (records.lead && !records.lead.salesperson) await Lead.updateOne({ _id: records.lead._id }, { salesperson: agent });
      }
      return { status: 'completed' };
    }
    case 'set_pipeline_stage': {
      if (!records.lead) return { status: 'skipped', reason: 'No lead to move' };
      const stageName = settings.stage ?? (automation?.assignedPipeline ? (await PipelineStage.findById(automation.assignedPipeline).select('name').lean())?.name : undefined);
      if (!stageName) return { status: 'skipped', reason: 'No pipeline stage configured' };
      const { moveQualificationStage } = await import('../services/lead.service.js');
      if (!context.dryRun) await moveQualificationStage(records.lead, String(stageName).toLowerCase(), settings.allowBackward === true);
      return { status: 'completed', reason: `Stage ${stageName}` };
    }
    case 'pause_ai': {
      if (!records.conversation) return { status: 'skipped', reason: 'No conversation' };
      if (!context.dryRun) {
        const update = { controlStatus: 'WAITING_HUMAN', mode: 'human', aiEnabled: false, automationPaused: settings.pauseFollowUps !== false, status: 'human_handoff' };
        await WhatsAppConversation.updateOne({ _id: records.conversation._id }, update);
        emitToConversation(String(records.conversation._id), 'conversation:updated', { conversation: { ...records.conversation.toObject?.() ?? records.conversation, ...update } });
      }
      return { status: 'completed' };
    }
    case 'resume_ai': {
      if (!records.conversation) return { status: 'skipped', reason: 'No conversation' };
      if (!context.dryRun) {
        const update = { controlStatus: 'AI_ACTIVE', mode: 'ai', aiEnabled: true, humanTakeover: false, automationPaused: false, aiMessageCount: 0, status: 'open' };
        await WhatsAppConversation.updateOne({ _id: records.conversation._id }, update);
        emitToConversation(String(records.conversation._id), 'conversation:updated', { conversation: { ...records.conversation.toObject?.() ?? records.conversation, ...update } });
      }
      return { status: 'completed' };
    }
    case 'stop_followups': {
      if (!records.conversation) return { status: 'skipped', reason: 'No conversation' };
      if (!context.dryRun) {
        const { cancelScheduledFor } = await import('./scheduler.service.js');
        await cancelScheduledFor(records.conversation._id, 'stopped by automation');
      }
      return { status: 'completed' };
    }
    case 'tag_lead': {
      if (!records.lead || !settings.tag) return { status: 'skipped', reason: 'No lead or tag configured' };
      if (!context.dryRun) {
        const tag = await Tag.findOneAndUpdate({ name: settings.tag }, { $setOnInsert: { name: settings.tag, active: true } }, { new: true, upsert: true });
        await Lead.updateOne({ _id: records.lead._id }, { $addToSet: { tags: tag._id } });
      }
      return { status: 'completed' };
    }
    default:
      return { status: 'skipped', reason: `Unknown action type "${action.type}"` };
  }
}

/**
 * Executes one automation now. Conditions are checked here (not by the caller), every
 * outcome is logged, and a thrown error is caught and recorded rather than escaping into
 * the webhook that triggered it.
 */
export async function executeAutomation(automation: AutomationDoc, context: ExecutionContext): Promise<ExecutionResult> {
  const records = await hydrate(context);
  const template = automation.template ? await AutomationTemplate.findById(idOf(automation.template)) : null;
  const log = await startLog({
    automation: automation._id, template: template?._id,
    conversation: records.conversation?._id, lead: records.lead?._id, contact: records.contact?._id,
    trigger: context.trigger, attempt: context.attempt ?? 1,
    metadata: { automationName: automation.name, dryRun: Boolean(context.dryRun), data: context.data ?? {} },
  });

  try {
    if (template && template.status !== 'active' && !context.dryRun) {
      await finishLog(log, 'skipped', { error: `Template "${template.templateKey}" is ${template.status}` });
      return { status: 'skipped', reason: `Template is ${template.status}` };
    }

    const conditionContext = { ...records, trigger: context.trigger, intent: context.intent, data: context.data };
    const own = evaluateConditions(automation.conditions as any, conditionContext);
    const inherited = template ? evaluateConditions(template.conditions as any, conditionContext) : { passed: true as const };
    if (!own.passed || !inherited.passed) {
      const failed = own.failed ?? (inherited as any).failed;
      await finishLog(log, 'skipped', { error: `Condition not met: ${describeCondition(failed)}` });
      return { status: 'skipped', reason: `Condition not met: ${describeCondition(failed)}` };
    }

    // An automation with no explicit actions simply sends its template — the common case.
    const actions = automation.actions?.length ? automation.actions : [{ type: 'send_template', config: {} }];
    const config = await getActiveAIConfig();
    // Every action runs even if an earlier one failed. A WhatsApp send that Meta rejected
    // is exactly when the "pause the AI and notify a human" actions matter most, so a
    // failed send must never silently skip them.
    let sendResult: ExecutionResult | null = null;
    let failure: ExecutionResult | null = null;
    for (const action of actions) {
      const outcome = await runAction(action as any, template, automation, context, records, config);
      recordAction(log, action.type, outcome.status === 'completed' ? 'completed' : outcome.status === 'failed' ? 'failed' : 'skipped', outcome.reason ?? outcome.text?.slice(0, 200));
      if (action.type === 'send_template') sendResult = outcome;
      if (outcome.status === 'failed' && !failure) failure = outcome;
    }

    const result: ExecutionResult = failure ?? sendResult ?? { status: 'completed' };
    // `delivered` distinguishes "we put a message on the thread" from "nothing was sent",
    // which is what the pipeline needs to decide whether the model should also reply.
    const delivered = Boolean(sendResult && (sendResult.status === 'completed' || sendResult.status === 'failed'));
    await finishLog(log, result.status, { error: result.status === 'completed' ? undefined : result.reason });
    await Automation.updateOne({ _id: automation._id }, {
      $inc: { runCount: 1 }, $set: { lastRunAt: new Date(), lastError: result.status === 'failed' ? result.reason : undefined },
    });
    return { ...result, delivered };
  } catch (error: any) {
    console.error(`[automation] "${automation.name}" failed`, error);
    await finishLog(log, 'failed', { error: error?.message ?? String(error) });
    await Automation.updateOne({ _id: automation._id }, { $set: { lastRunAt: new Date(), lastError: error?.message ?? 'Unknown error' } });
    return { status: 'failed', reason: error?.message ?? 'Unknown error' };
  }
}

/**
 * Sends a single template outside the automation machinery (welcome menus, human handoff
 * confirmations, admin test sends). Still logged, still deduplicated, still refuses to
 * message a customer a human has taken over.
 */
export async function executeTemplate(template: AutomationTemplateDoc, context: ExecutionContext): Promise<ExecutionResult> {
  const records = await hydrate(context);
  const log = await startLog({
    template: template._id, conversation: records.conversation?._id, lead: records.lead?._id, contact: records.contact?._id,
    trigger: context.trigger, attempt: context.attempt ?? 1,
    metadata: { templateKey: template.templateKey, dryRun: Boolean(context.dryRun), data: context.data ?? {} },
  });
  try {
    const result = await sendTemplateAction(template, null, context, records, await getActiveAIConfig());
    recordAction(log, 'send_template', result.status === 'completed' ? 'completed' : result.status === 'failed' ? 'failed' : 'skipped', result.reason ?? result.text?.slice(0, 200));
    await finishLog(log, result.status, { error: result.status === 'completed' ? undefined : result.reason });
    return { ...result, delivered: result.status === 'completed' || result.status === 'failed' };
  } catch (error: any) {
    console.error(`[automation] template "${template.templateKey}" failed`, error);
    await finishLog(log, 'failed', { error: error?.message ?? String(error) });
    return { status: 'failed', reason: error?.message ?? 'Unknown error' };
  }
}
