// The façade the rest of the application calls. Nothing outside this folder needs to know
// how automations are stored, delayed or logged — the pipeline just says "this happened".
import { Automation, AutomationTemplate, delayToMs } from '../models/index.js';
import { isKnownTrigger } from './trigger.service.js';
import { executeAutomation, executeTemplate, type ExecutionContext, type ExecutionResult } from './automation.executor.js';
import { logSkipped } from './automation-log.service.js';
import { scheduleAutomation } from './scheduler.service.js';

export type DispatchResult = {
  trigger: string;
  /** Automations that completed without error. */
  ran: number;
  /** Automations that actually put a message on the thread — including one WhatsApp then
   *  rejected. The pipeline uses this to decide whether the model should also reply, since
   *  a rejected send has still been composed, stored and shown in the inbox. */
  delivered: number;
  scheduled: number;
  results: ExecutionResult[];
};

/**
 * Fires every active automation listening on `trigger`.
 *
 * Automations with a delay are queued for the scheduler instead of running now; the rest
 * execute immediately, in priority order. Never throws: an automation failing must not
 * take down the webhook or CRM request that triggered it.
 */
export async function dispatchTrigger(trigger: string, context: Omit<ExecutionContext, 'trigger'> = {}): Promise<DispatchResult> {
  const result: DispatchResult = { trigger, ran: 0, delivered: 0, scheduled: 0, results: [] };
  if (!isKnownTrigger(trigger)) {
    await logSkipped({ trigger, reason: `Unknown trigger "${trigger}"`, conversation: context.conversation?._id, lead: context.lead?._id });
    return result;
  }

  const automations = await Automation.find({ trigger, status: 'active' }).sort({ priority: 1, updatedAt: -1 });
  for (const automation of automations) {
    try {
      const wait = delayToMs(automation.delay);
      if (wait > 0) {
        const queued = await scheduleAutomation(automation, { ...context, trigger }, new Date(Date.now() + wait));
        if (queued) result.scheduled += 1;
        continue;
      }
      const outcome = await executeAutomation(automation, { ...context, trigger });
      result.results.push(outcome);
      if (outcome.status === 'completed') result.ran += 1;
      if (outcome.delivered) result.delivered += 1;
    } catch (error) {
      console.error(`[automation] dispatch of "${automation.name}" threw`, error);
    }
  }
  return result;
}

/**
 * Sends one template by key, outside any automation. Used for the pieces of the flow the
 * pipeline owns directly (welcome, outside-hours, handoff confirmations) so that copy
 * still lives in the database rather than in code.
 */
export async function sendTemplateByKey(templateKey: string, context: Omit<ExecutionContext, 'trigger'> & { trigger?: string }): Promise<ExecutionResult> {
  const template = await AutomationTemplate.findOne({ templateKey: templateKey.toLowerCase() });
  if (!template) {
    await logSkipped({ trigger: context.trigger ?? templateKey, reason: `Template "${templateKey}" not found`, conversation: context.conversation?._id, lead: context.lead?._id });
    return { status: 'skipped', reason: `Template "${templateKey}" not found` };
  }
  if (template.status !== 'active' && !context.dryRun) {
    await logSkipped({ template: template._id, trigger: context.trigger ?? template.trigger, reason: `Template "${templateKey}" is ${template.status}`, conversation: context.conversation?._id, lead: context.lead?._id });
    return { status: 'skipped', reason: `Template is ${template.status}` };
  }
  return executeTemplate(template, { ...context, trigger: context.trigger ?? template.trigger });
}

export { executeAutomation, executeTemplate };
export type { ExecutionContext, ExecutionResult };
