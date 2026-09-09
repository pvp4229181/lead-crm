// Thin wrapper around the Meta WhatsApp Cloud API. Every call is best-effort: a
// missing WHATSAPP_ACCESS_TOKEN (no credentials configured yet) logs and returns a
// synthetic "not configured" result instead of throwing, so the rest of the pipeline
// (saving messages, updating the lead) keeps working before the account is wired up.

import { BUTTON_TITLE_LIMIT, MAX_BUTTONS } from './whatsapp.actions.js';

const GRAPH_VERSION = 'v21.0';
const graphUrl = (path: string) => `https://graph.facebook.com/${GRAPH_VERSION}/${path}`;

function credentials() {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  return { token, phoneNumberId, configured: Boolean(token && phoneNumberId) };
}

type SendResult = { ok: boolean; whatsappMessageId?: string; error?: string };
export type WebhookSubscriptionResult = {
  ok: boolean;
  configured: boolean;
  subscribed: boolean;
  apps?: { id?: string; name?: string }[];
  error?: string;
};

// Meta's top-level `error.message` is often a bare label ("Authentication Error") that
// tells the salesperson nothing. The useful text lives in error_user_msg / error_data.details,
// and an expired token — by far the most common failure here, since dashboard tokens last
// 24 hours — only identifies itself by code 190, so name that case explicitly.
function describeGraphError(error: any, status: number): string {
  if (!error) return `WhatsApp API error (${status})`;
  const detail: string | undefined = error.error_user_msg || error.error_data?.details || undefined;
  const label: string = error.message || `WhatsApp API error (${status})`;
  if (error.code === 190) {
    return `WhatsApp access token is invalid or expired — generate a new one in the Meta dashboard and update WHATSAPP_ACCESS_TOKEN. (${detail ?? label})`;
  }
  // Meta repeats itself: `message` is "(#131030) Recipient phone number not in allowed list"
  // while `details` opens with that same sentence. Concatenating both reads as a stutter, so
  // drop the label whenever the detail already covers it.
  if (!detail) return label;
  const core = label.replace(/^\(#\d+\)\s*/, '').trim();
  if (core && detail.toLowerCase().includes(core.toLowerCase())) return detail;
  return detail === label ? label : `${label}: ${detail}`;
}

async function post(path: string, body: unknown, token: string): Promise<SendResult> {
  try {
    const response = await fetch(graphUrl(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const json: any = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = describeGraphError(json?.error, response.status);
      console.error(`[whatsapp] ${path} failed (${response.status}):`, JSON.stringify(json?.error ?? {}));
      return { ok: false, error: message };
    }
    return { ok: true, whatsappMessageId: json?.messages?.[0]?.id };
  } catch (error: any) {
    return { ok: false, error: error?.message ?? 'Network error contacting WhatsApp API' };
  }
}

// Verifying the callback URL only registers the endpoint on the Meta app. Meta will not
// deliver real customer messages until that app is also subscribed to the WABA itself.
// These helpers keep the access token server-side and expose only subscription metadata.
export async function getWebhookSubscription(): Promise<WebhookSubscriptionResult> {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
  if (!token || !wabaId) return { ok: false, configured: false, subscribed: false, error: 'WHATSAPP_ACCESS_TOKEN and WHATSAPP_BUSINESS_ACCOUNT_ID are required' };
  try {
    const response = await fetch(graphUrl(`${wabaId}/subscribed_apps`), { headers: { Authorization: `Bearer ${token}` } });
    const json: any = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, configured: true, subscribed: false, error: describeGraphError(json?.error, response.status) };
    const apps = (json.data ?? []).map((item: any) => ({
      id: item.whatsapp_business_api_data?.id,
      name: item.whatsapp_business_api_data?.name,
    }));
    return { ok: true, configured: true, subscribed: apps.length > 0, apps };
  } catch (error: any) {
    return { ok: false, configured: true, subscribed: false, error: error?.message ?? 'Network error contacting WhatsApp API' };
  }
}

export async function subscribeWebhook(): Promise<WebhookSubscriptionResult> {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
  if (!token || !wabaId) return { ok: false, configured: false, subscribed: false, error: 'WHATSAPP_ACCESS_TOKEN and WHATSAPP_BUSINESS_ACCOUNT_ID are required' };
  try {
    const response = await fetch(graphUrl(`${wabaId}/subscribed_apps`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      // Current Graph API versions allow selecting fields directly on the WABA
      // subscription. Supplying this explicitly avoids dashboard/UI variants that
      // verify the callback but never attach the messages field.
      body: JSON.stringify({ subscribed_fields: ['messages'] }),
    });
    const json: any = await response.json().catch(() => ({}));
    if (!response.ok || json.success !== true) return { ok: false, configured: true, subscribed: false, error: describeGraphError(json?.error, response.status) };
    return getWebhookSubscription();
  } catch (error: any) {
    return { ok: false, configured: true, subscribed: false, error: error?.message ?? 'Network error contacting WhatsApp API' };
  }
}

export async function sendTextMessage(to: string, text: string): Promise<SendResult> {
  const { token, phoneNumberId, configured } = credentials();
  if (!configured) { console.warn(`[whatsapp] not configured — would send to ${to}: ${text}`); return { ok: false, error: 'WhatsApp account not configured' }; }
  return post(`${phoneNumberId}/messages`, { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }, token!);
}

export async function sendTemplateMessage(to: string, templateName: string, language: string, components: unknown[] = []): Promise<SendResult> {
  const { token, phoneNumberId, configured } = credentials();
  if (!configured) return { ok: false, error: 'WhatsApp account not configured' };
  return post(`${phoneNumberId}/messages`, { messaging_product: 'whatsapp', to, type: 'template', template: { name: templateName, language: { code: language }, components } }, token!);
}

// Interactive reply buttons — how the customer picks AI vs human without having to
// phrase it in a way the model has to interpret. Titles are truncated and the list capped
// to WhatsApp's limits, since exceeding either makes the API reject the whole message.
export async function sendInteractiveButtons(to: string, body: string, buttons: { id: string; title: string }[], footer?: string): Promise<SendResult> {
  const { token, phoneNumberId, configured } = credentials();
  if (!configured) { console.warn(`[whatsapp] not configured — would send buttons to ${to}: ${body}`); return { ok: false, error: 'WhatsApp account not configured' }; }
  return post(`${phoneNumberId}/messages`, {
    messaging_product: 'whatsapp', to, type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: body.slice(0, 1024) },
      ...(footer ? { footer: { text: footer.slice(0, 60) } } : {}),
      action: { buttons: buttons.slice(0, MAX_BUTTONS).map(button => ({ type: 'reply', reply: { id: button.id, title: button.title.slice(0, BUTTON_TITLE_LIMIT) } })) },
    },
  }, token!);
}

export async function markAsRead(whatsappMessageId: string): Promise<void> {
  const { token, phoneNumberId, configured } = credentials();
  if (!configured) return;
  await post(`${phoneNumberId}/messages`, { messaging_product: 'whatsapp', status: 'read', message_id: whatsappMessageId }, token!).catch(() => undefined);
}

export async function resolveMediaUrl(mediaId: string): Promise<{ url: string; mimeType?: string } | null> {
  const { token, configured } = credentials();
  if (!configured) return null;
  try {
    const response = await fetch(graphUrl(mediaId), { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) return null;
    const json: any = await response.json();
    return { url: json.url, mimeType: json.mime_type };
  } catch { return null; }
}

// Streams Meta media through our own server so the access token never reaches the
// browser (Meta's media URLs require the bearer token on every request).
export async function streamMedia(url: string): Promise<Response | null> {
  const { token, configured } = credentials();
  if (!configured) return null;
  try {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    return response.ok ? response : null;
  } catch { return null; }
}

// Meta is the only source of truth for which templates exist and are approved — a name
// typed by hand is the usual cause of error 132001. Pages through the WABA's template list
// so the CRM can offer the real ones instead of a free-text box.
export type MetaTemplate = {
  metaTemplateId?: string; name: string; language: string; status: string; category?: string;
  header?: string; body: string; footer?: string; buttons: unknown[]; variableCount: number;
};

export async function fetchMessageTemplates(): Promise<{ ok: boolean; templates: MetaTemplate[]; error?: string }> {
  const { token, configured } = credentials();
  const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
  if (!configured || !wabaId) return { ok: false, templates: [], error: 'WhatsApp account not configured (needs WHATSAPP_ACCESS_TOKEN and WHATSAPP_BUSINESS_ACCOUNT_ID)' };

  const templates: MetaTemplate[] = [];
  let url: string | null = graphUrl(`${wabaId}/message_templates?fields=id,name,status,category,language,components&limit=100`);
  try {
    // Meta paginates; follow `paging.next` so a WABA with many templates syncs fully.
    while (url) {
      const response: Response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const json: any = await response.json().catch(() => ({}));
      if (!response.ok) return { ok: false, templates: [], error: describeGraphError(json?.error, response.status) };
      for (const item of json.data ?? []) {
        const components: any[] = item.components ?? [];
        const part = (type: string) => components.find(c => c.type === type);
        const body = part('BODY')?.text ?? '';
        templates.push({
          metaTemplateId: item.id, name: item.name, language: item.language, status: item.status, category: item.category,
          header: part('HEADER')?.text ?? undefined, body, footer: part('FOOTER')?.text ?? undefined,
          buttons: part('BUTTONS')?.buttons ?? [],
          // The send form asks for one value per {{n}} placeholder, so count the distinct ones.
          variableCount: new Set(body.match(/\{\{\s*\d+\s*\}\}/g) ?? []).size,
        });
      }
      url = json.paging?.next ?? null;
    }
    return { ok: true, templates };
  } catch (error: any) {
    return { ok: false, templates: [], error: error?.message ?? 'Network error contacting WhatsApp API' };
  }
}

export const isWhatsAppConfigured = () => credentials().configured;
