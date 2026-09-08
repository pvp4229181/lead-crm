// Button payload ids exchanged with WhatsApp. Routing is keyed off these ids rather than
// the button titles, because titles are display text an admin may reword or translate.
export const WA_ACTION = {
  HUMAN: 'wa_action_human',
  AI: 'wa_action_ai',
  PRICING: 'wa_action_pricing',
  QUESTION: 'wa_action_question',
} as const;

export type WaActionId = (typeof WA_ACTION)[keyof typeof WA_ACTION];

// WhatsApp allows at most 3 reply buttons per message, each title <= 20 characters.
export const BUTTON_TITLE_LIMIT = 20;
export const MAX_BUTTONS = 3;

export const isWaAction = (value?: string): value is WaActionId =>
  Boolean(value) && Object.values(WA_ACTION).includes(value as WaActionId);
