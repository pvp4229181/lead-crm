// Delayed and repeating automations.
//
// Two jobs run on the same tick (see jobs/followup.job.ts and the Vercel Cron route):
//   runDueAutomations() — automations that were queued with a delay and are now due.
//   runFollowUps()      — the no-response sweep that queues the next follow-up attempt.
//
// Both are safe to run concurrently and repeatedly: queuing is guarded by a unique
// dedupeKey, and claiming a queued row is an atomic findOneAndUpdate.
import mongoose from 'mongoose';
import { Automation, Lead, ScheduledAutomation, WhatsAppConversation, delayToMs, type AutomationDoc } from '../models/index.js';
import { executeAutomation, type ExecutionContext } from './automation.executor.js';
import { logSkipped } from './automation-log.service.js';

const id = (value: any) => (value && typeof value === 'object' && '_id' in value ? String(value._id) : value ? String(value) : '');

/** Queues an automation to run later. Returns false when an identical run is already queued. */
export async function scheduleAutomation(automation: AutomationDoc, context: ExecutionContext, runAt: Date, attempt = 1) {
  const conversationId = id(context.conversation);
  const dedupeKey = context.dedupeKey ?? `${String(automation._id)}:${conversationId || id(context.lead)}:${attempt}`;
  try {
    await ScheduledAutomation.create({
      automation: automation._id, template: automation.template ?? undefined,
      conversation: conversationId || undefined, lead: id(context.lead) || undefined, contact: id(context.contact) || undefined,
      trigger: context.trigger, runAt, attempt, dedupeKey,
      payload: { data: context.data ?? {}, intent: context.intent },
    });
    return true;
  } catch (error: any) {
    if (error?.code === 11000) return false; // already queued — exactly what the key is for
    throw error;
  }
}

/** Cancels every pending run for a conversation. Called whenever a stop condition is met. */
export async function cancelScheduledFor(conversationId: mongoose.Types.ObjectId | string, reason: string) {
  const outcome = await ScheduledAutomation.updateMany(
    { conversation: conversationId, status: 'pending' },
    { $set: { status: 'cancelled', error: reason } },
  );
  return outcome.modifiedCount ?? 0;
}

/**
 * Stop conditions from spec §7. Called when the customer replies, the lead is won/lost or
 * opts out, or a human takes ownership — anything that must silence pending follow-ups.
 */
export async function stopFollowUps(conversationId: mongoose.Types.ObjectId | string, reason: string) {
  return cancelScheduledFor(conversationId, reason);
}

const STOPPED_STAGES = ['won', 'lost'];

// A conversation is only eligible for an automated customer message while ARIA still owns
// it and the customer has neither opted out nor been handed to a person.
function conversationIsEligible(conversation: any, lead: any): string | null {
  if (!conversation) return 'conversation missing';
  if (conversation.archived) return 'conversation archived';
  if (conversation.optedOut) return 'customer opted out';
  if (conversation.automationPaused) return 'automation paused';
  if (conversation.mode !== 'ai' || conversation.controlStatus !== 'AI_ACTIVE') return 'human owns the conversation';
  if (lead && STOPPED_STAGES.includes(String(lead.qualificationStatus))) return `lead is ${lead.qualificationStatus}`;
  return null;
}

/** Runs everything queued and due. Each row is claimed atomically so parallel ticks can't double-send. */
export async function runDueAutomations(limit = 50) {
  let executed = 0, cancelled = 0;
  for (let index = 0; index < limit; index += 1) {
    const claimed = await ScheduledAutomation.findOneAndUpdate(
      { status: 'pending', runAt: { $lte: new Date() } },
      { $set: { status: 'running', lockedAt: new Date() } },
      { new: true, sort: { runAt: 1 } },
    );
    if (!claimed) break;

    const automation = await Automation.findById(claimed.automation);
    if (!automation || automation.status !== 'active') {
      await ScheduledAutomation.updateOne({ _id: claimed._id }, { status: 'cancelled', error: 'Automation is no longer active' });
      cancelled += 1;
      continue;
    }

    const [conversation, lead] = await Promise.all([
      claimed.conversation ? WhatsAppConversation.findById(claimed.conversation) : null,
      claimed.lead ? Lead.findById(claimed.lead) : null,
    ]);
    const blocked = conversation ? conversationIsEligible(conversation, lead) : null;
    if (blocked) {
      await ScheduledAutomation.updateOne({ _id: claimed._id }, { status: 'cancelled', error: blocked });
      await logSkipped({ automation: automation._id, conversation: claimed.conversation, lead: claimed.lead, trigger: claimed.trigger, reason: `Stop condition: ${blocked}` });
      cancelled += 1;
      continue;
    }

    const payload = (claimed.payload ?? {}) as { data?: Record<string, unknown>; intent?: string };
    const result = await executeAutomation(automation, {
      trigger: claimed.trigger, conversation, lead, intent: payload.intent, data: payload.data,
      attempt: claimed.attempt, dedupeKey: claimed.dedupeKey,
    });
    await ScheduledAutomation.updateOne({ _id: claimed._id }, {
      status: result.status === 'failed' ? 'failed' : 'completed',
      error: result.status === 'completed' ? undefined : result.reason,
    });
    if (result.status === 'completed') executed += 1; else cancelled += 1;

    // A repeating automation queues its next attempt only after this one actually landed.
    if (result.status === 'completed' && claimed.attempt < (automation.maxAttempts ?? 1) && (automation.repeatEveryHours ?? 0) > 0) {
      await scheduleAutomation(
        automation,
        { trigger: claimed.trigger, conversation, lead, data: payload.data, intent: payload.intent },
        new Date(Date.now() + automation.repeatEveryHours! * 3_600_000),
        claimed.attempt + 1,
      );
    }
  }
  return { executed, cancelled };
}

/**
 * The no-response sweep. For every active `lead_no_response` automation, finds conversations
 * that have been quiet for longer than the automation's delay and runs the next attempt.
 *
 * Attempts are counted from `conversation.followUpsSent`, so the cap survives restarts and
 * a conversation can never be chased more than `maxAttempts` times by the same automation.
 */
export async function runFollowUps(perAutomationLimit = 200) {
  const automations = await Automation.find({ trigger: 'lead_no_response', status: 'active' }).sort({ priority: 1 });
  let processed = 0, skipped = 0;

  for (const automation of automations) {
    const waitMs = delayToMs(automation.delay) || 24 * 3_600_000;
    const cutoff = new Date(Date.now() - waitMs);
    const key = automation.automationKey || String(automation._id);

    const conversations = await WhatsAppConversation.find({
      archived: false, optedOut: { $ne: true }, automationPaused: { $ne: true },
      mode: 'ai', controlStatus: 'AI_ACTIVE',
      lastInboundAt: { $ne: null, $lte: cutoff },
    }).populate('lead').limit(perAutomationLimit);

    for (const conversation of conversations) {
      const lead = conversation.lead as any;
      const blocked = conversationIsEligible(conversation, lead);
      if (blocked) { skipped += 1; continue; }

      const sent = (conversation.followUpsSent ?? []).filter(entry => entry.rule === key);
      if (sent.length >= (automation.maxAttempts ?? 1)) continue;

      // Space repeat attempts out rather than firing them all on the first quiet tick.
      const lastAt = sent.length ? sent[sent.length - 1]!.at?.getTime() ?? 0 : 0;
      const gapMs = (automation.repeatEveryHours ?? 0) * 3_600_000 || waitMs;
      if (lastAt && Date.now() - lastAt < gapMs) continue;

      const attempt = sent.length + 1;
      const result = await executeAutomation(automation, {
        trigger: 'lead_no_response', conversation, lead, attempt,
        dedupeKey: `${String(automation._id)}:${String(conversation._id)}:${attempt}`,
      });
      // The attempt counts as spent as soon as the message reached the thread. Counting
      // only clean successes would let a WhatsApp outage re-chase the same lead on every
      // tick once the API recovered — the opposite of a capped follow-up.
      if (result.delivered) {
        await WhatsAppConversation.updateOne({ _id: conversation._id }, { $push: { followUpsSent: { rule: key, at: new Date() } } });
        processed += 1;
      } else {
        skipped += 1;
      }
    }
  }

  const due = await runDueAutomations();
  return { processed, skipped, ...due };
}
