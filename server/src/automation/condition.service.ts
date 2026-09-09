// Rules an automation must satisfy before it is allowed to run. Conditions are stored
// as plain {field, operator, value} triples so they stay editable from the CRM, and are
// evaluated against a flat view of the lead / conversation / contact / trigger payload.
import type { ConditionOperator } from '../models/automation.js';

export type Condition = { field: string; operator?: ConditionOperator; value?: unknown };

// Only these paths can be referenced. An unknown field fails closed (the condition is
// false), so a typo in the CRM never turns into "always send".
export const CONDITION_FIELDS = [
  'lead.leadScore', 'lead.leadTemperature', 'lead.qualificationStatus', 'lead.status',
  'lead.budget', 'lead.email', 'lead.companyName', 'lead.contactName', 'lead.purchaseTimeline',
  'lead.productInterest', 'lead.requirements', 'lead.location', 'lead.salesperson',
  'conversation.controlStatus', 'conversation.mode', 'conversation.aiEnabled', 'conversation.status',
  'conversation.optedOut', 'conversation.automationPaused', 'conversation.language', 'conversation.unreadCount',
  'contact.whatsappOptIn', 'trigger', 'intent',
] as const;

export type ConditionContext = {
  lead?: any; conversation?: any; contact?: any;
  trigger?: string; intent?: string; data?: Record<string, unknown>;
};

function readPath(context: ConditionContext, field: string): unknown {
  // `data.*` is the escape hatch for values supplied by whoever fired the trigger.
  const path = field.startsWith('data.') ? field.split('.').slice(1) : field.split('.');
  let cursor: any = field.startsWith('data.') ? context.data : context;
  for (const key of path) {
    if (cursor === null || cursor === undefined) return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

const asNumber = (value: unknown) => (typeof value === 'number' ? value : Number(String(value ?? '')));
const asArray = (value: unknown) => (Array.isArray(value) ? value : String(value ?? '').split(',').map(part => part.trim()).filter(Boolean));
const asText = (value: unknown) => (Array.isArray(value) ? value.join(', ') : String(value ?? '')).toLowerCase();
const present = (value: unknown) => !(value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0));

export function evaluateCondition(condition: Condition, context: ConditionContext): boolean {
  const actual = readPath(context, condition.field);
  const expected = condition.value;
  switch (condition.operator ?? 'equals') {
    case 'equals': return asText(actual) === asText(expected);
    case 'not_equals': return asText(actual) !== asText(expected);
    case 'contains': return asText(actual).includes(asText(expected));
    case 'not_contains': return !asText(actual).includes(asText(expected));
    case 'exists': return present(actual);
    case 'not_exists': return !present(actual);
    case 'gt': return asNumber(actual) > asNumber(expected);
    case 'gte': return asNumber(actual) >= asNumber(expected);
    case 'lt': return asNumber(actual) < asNumber(expected);
    case 'lte': return asNumber(actual) <= asNumber(expected);
    case 'in': return asArray(expected).map(item => String(item).toLowerCase()).includes(asText(actual));
    case 'not_in': return !asArray(expected).map(item => String(item).toLowerCase()).includes(asText(actual));
    case 'is_true': return actual === true || asText(actual) === 'true';
    case 'is_false': return actual === false || asText(actual) === 'false';
    default: return false;
  }
}

/** All conditions must pass (AND). An empty list means "no restrictions". */
export function evaluateConditions(conditions: Condition[] | undefined, context: ConditionContext): { passed: boolean; failed?: Condition } {
  for (const condition of conditions ?? []) {
    if (!evaluateCondition(condition, context)) return { passed: false, failed: condition };
  }
  return { passed: true };
}

export const describeCondition = (condition: Condition) =>
  `${condition.field} ${(condition.operator ?? 'equals').replace(/_/g, ' ')}${condition.value === undefined ? '' : ` ${String(condition.value)}`}`;
