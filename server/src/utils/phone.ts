// WhatsApp Cloud API always sends/expects numbers in bare E.164 digits (no '+', no
// spaces). Contacts/Leads elsewhere in the CRM store phone numbers loosely formatted,
// so every lookup normalizes both sides through this before comparing.
export function normalizePhone(value: string): string {
  return value.replace(/[^\d]/g, '').replace(/^0+/, '');
}

export function toE164(value: string): string {
  const digits = normalizePhone(value);
  return digits ? `+${digits}` : '';
}
