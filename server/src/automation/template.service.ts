// Reading, rendering and previewing automation templates. Callers never touch the
// message body directly — they ask for a template by key or trigger and get back text
// that has already been through the variable resolver.
import { WhatsAppMessage } from '../models/index.js';
import { AutomationTemplate, type AutomationTemplateDoc } from '../models/automation.js';
import { AVAILABLE_VARIABLES, extractVariables, renderTemplate, resolveVariables, type RenderResult, type VariableContext } from './variable.service.js';

export async function templateByKey(key: string): Promise<AutomationTemplateDoc | null> {
  return AutomationTemplate.findOne({ templateKey: key.toLowerCase() });
}

/** The template an automation should use: its own, or the highest-priority one on the trigger. */
export async function templateForTrigger(trigger: string): Promise<AutomationTemplateDoc | null> {
  return AutomationTemplate.findOne({ trigger, status: 'active' }).sort({ priority: 1, updatedAt: -1 });
}

/**
 * Whether this conversation already received a given template recently.
 *
 * Intent-driven templates would otherwise re-fire on every message about the same topic —
 * the customer asks two pricing questions in a row and gets the same product card twice.
 * After the first send, the AI's own reply handles the follow-ups.
 */
export async function sentTemplateRecently(conversationId: unknown, templateKey: string, withinMs: number): Promise<boolean> {
  const template = await AutomationTemplate.findOne({ templateKey: templateKey.toLowerCase() }).select('_id').lean();
  if (!template) return false;
  return Boolean(await WhatsAppMessage.exists({
    conversation: conversationId, automationTemplate: template._id,
    timestamp: { $gte: new Date(Date.now() - withinMs) },
  }));
}

export type RenderedTemplate = RenderResult & { values: Record<string, string>; template: AutomationTemplateDoc };

/** Resolves every variable for `context` and substitutes them into the template body. */
export async function renderForContext(template: AutomationTemplateDoc, context: VariableContext): Promise<RenderedTemplate> {
  const values = await resolveVariables(context);
  const rendered = renderTemplate(template.message, values, template.requiredVariables ?? [], template.askMode === true);
  return { ...rendered, values, template };
}

/**
 * Editor preview: fills unknown variables with the catalogue's sample values so the admin
 * sees the shape of a real message instead of a page of gaps. Explicit `values` (from a
 * live record) always win over the samples.
 */
export function previewWithSamples(message: string, values: Record<string, string> = {}, askMode = false): RenderResult {
  const provided = Object.fromEntries(Object.entries(values).filter(([, value]) => value));
  // An ask-mode preview must show the questions, so sample values are deliberately not
  // filled in — supplying them would drop every line the admin wants to see.
  const samples = askMode ? {} : Object.fromEntries(AVAILABLE_VARIABLES.map(variable => [variable.name, variable.sample]));
  return renderTemplate(message, { ...samples, ...provided }, [], askMode);
}

/** Keeps `variables` in step with the body, so the stored list is never stale. */
export function syncDeclaredVariables<T extends { message?: string; variables?: string[] }>(input: T): T {
  if (typeof input.message !== 'string') return input;
  return { ...input, variables: extractVariables(input.message) };
}

/** Copies a template under a new key, always as a draft so a duplicate can't start sending. */
export async function duplicateTemplate(id: string, userId?: unknown): Promise<AutomationTemplateDoc | null> {
  const original = await AutomationTemplate.findById(id).lean();
  if (!original) return null;
  const { _id, createdAt, updatedAt, templateKey, templateName, ...rest } = original as any;

  // welcome_message -> welcome_message_copy -> welcome_message_copy_2 …
  let key = `${templateKey}_copy`;
  let suffix = 2;
  while (await AutomationTemplate.exists({ templateKey: key })) key = `${templateKey}_copy_${suffix++}`;

  return AutomationTemplate.create({
    ...rest,
    templateKey: key,
    templateName: `${templateName} (copy)`,
    status: 'draft',
    source: 'custom',
    isSystem: false,
    createdBy: userId, updatedBy: userId,
  });
}
