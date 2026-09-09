// Every automation run leaves a row here — including the ones that were skipped because a
// condition failed. "Why did the customer not get the follow-up?" is otherwise unanswerable.
import { AutomationLog, type ActionType, type LogStatus } from '../models/automation.js';

export type LogHandle = { _id: unknown; startedAt: number; actions: { type: string; status: string; detail?: string }[] };

export async function startLog(input: {
  automation?: unknown; template?: unknown; conversation?: unknown; lead?: unknown; contact?: unknown;
  trigger: string; attempt?: number; metadata?: Record<string, unknown>;
}): Promise<LogHandle> {
  const doc = await AutomationLog.create({
    automation: input.automation ?? undefined, template: input.template ?? undefined,
    conversation: input.conversation ?? undefined, lead: input.lead ?? undefined, contact: input.contact ?? undefined,
    trigger: input.trigger, attempt: input.attempt ?? 1, status: 'running',
    startedAt: new Date(), metadata: input.metadata ?? {},
  });
  return { _id: doc._id, startedAt: Date.now(), actions: [] };
}

export function recordAction(handle: LogHandle, type: ActionType | string, status: 'completed' | 'failed' | 'skipped', detail?: string) {
  handle.actions.push({ type, status, detail });
}

export async function finishLog(handle: LogHandle, status: LogStatus, extra: { error?: string; metadata?: Record<string, unknown> } = {}) {
  await AutomationLog.updateOne({ _id: handle._id }, {
    $set: {
      status, completedAt: new Date(), durationMs: Date.now() - handle.startedAt,
      executedActions: handle.actions, ...(extra.error ? { error: extra.error.slice(0, 1000) } : {}),
      ...(extra.metadata ? { metadata: extra.metadata } : {}),
    },
  });
}

/** One-shot log for something that never got as far as running (no template, bad trigger…). */
export async function logSkipped(input: { automation?: unknown; template?: unknown; conversation?: unknown; lead?: unknown; trigger: string; reason: string; status?: LogStatus }) {
  await AutomationLog.create({
    automation: input.automation ?? undefined, template: input.template ?? undefined,
    conversation: input.conversation ?? undefined, lead: input.lead ?? undefined,
    trigger: input.trigger, status: input.status ?? 'skipped',
    startedAt: new Date(), completedAt: new Date(), durationMs: 0,
    error: input.reason, metadata: { reason: input.reason },
  });
}
