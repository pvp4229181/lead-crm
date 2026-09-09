import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { WhatsAppMessage } from '../models/index.js';
import { processInboundMessage, type NormalizedInboundMessage } from '../pipeline/whatsapp.pipeline.js';
import { emitToConversation } from '../realtime.js';
import { getWebhookSubscription, subscribeWebhook } from '../services/whatsapp.service.js';

// GET /api/webhooks/whatsapp — Meta's one-time subscription verification handshake.
export function verifyWebhook(req: Request, res: Response) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) return res.status(200).send(String(challenge ?? ''));
  return res.sendStatus(403);
}

function verifyOperatorToken(req: Request, res: Response): boolean {
  const expected = process.env.WHATSAPP_VERIFY_TOKEN;
  const supplied = req.header('x-whatsapp-verify-token');
  if (!expected || supplied !== expected) {
    res.sendStatus(403);
    return false;
  }
  return true;
}

// Recovery endpoints for deployments where Meta's dashboard exposes callback
// verification but not the WABA subscription control. They only read or enable the
// configured WABA subscription and require the same server-side verification secret.
export async function webhookSubscriptionStatus(req: Request, res: Response) {
  if (!verifyOperatorToken(req, res)) return;
  res.json(await getWebhookSubscription());
}

export async function enableWebhookSubscription(req: Request, res: Response) {
  if (!verifyOperatorToken(req, res)) return;
  const result = await subscribeWebhook();
  res.status(result.ok ? 200 : 502).json(result);
}

// Verifies the X-Hub-Signature-256 header Meta signs every webhook POST with, using
// the raw request body captured by app.ts's express.json({verify}) hook. Rejects
// silently-forged requests before they ever touch a lead or conversation record.
export function verifySignature(req: Request, res: Response, next: () => void) {
  const secret = process.env.WHATSAPP_APP_SECRET;
  const signature = req.header('x-hub-signature-256');
  if (!secret) return next(); // not yet configured — allow through in dev, but this must be set before production use
  const raw = (req as any).rawBody as Buffer | undefined;
  if (!signature || !raw) return res.sendStatus(401);
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const ok = signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  if (!ok) return res.sendStatus(401);
  next();
}

function normalizeMessage(raw: any, contactName?: string): NormalizedInboundMessage | null {
  const base = { from: raw.from, profileName: contactName, whatsappMessageId: raw.id, timestamp: new Date(Number(raw.timestamp) * 1000) };
  switch (raw.type) {
    case 'text': return { ...base, type: 'text', text: raw.text?.body };
    case 'image': return { ...base, type: 'image', mediaId: raw.image?.id, mimeType: raw.image?.mime_type, caption: raw.image?.caption };
    case 'document': return { ...base, type: 'document', mediaId: raw.document?.id, mimeType: raw.document?.mime_type, filename: raw.document?.filename, caption: raw.document?.caption };
    case 'audio': return { ...base, type: 'audio', mediaId: raw.audio?.id, mimeType: raw.audio?.mime_type };
    case 'video': return { ...base, type: 'video', mediaId: raw.video?.id, mimeType: raw.video?.mime_type, caption: raw.video?.caption };
    case 'location': return { ...base, type: 'location', location: { lat: raw.location?.latitude, lng: raw.location?.longitude, name: raw.location?.name, address: raw.location?.address } };
    // Keep the payload id alongside the title: the id is what routing keys off, the title
    // is only what the customer saw on the button.
    case 'interactive': return {
      ...base, type: 'interactive',
      text: raw.interactive?.button_reply?.title ?? raw.interactive?.list_reply?.title,
      interactiveId: raw.interactive?.button_reply?.id ?? raw.interactive?.list_reply?.id,
    };
    case 'button': return { ...base, type: 'interactive', text: raw.button?.text, interactiveId: raw.button?.payload };
    default: return { ...base, type: 'unknown' };
  }
}

const STATUS_MAP: Record<string, string> = { sent: 'SENT', delivered: 'DELIVERED', read: 'READ', failed: 'FAILED' };

// POST /api/webhooks/whatsapp — incoming messages and outbound delivery/read/failed
// status callbacks. Always answers 200 (Meta retries aggressively on anything else),
// logging failures instead of surfacing them to the webhook caller.
export async function receiveWebhook(req: Request, res: Response) {
  try {
    const entries = req.body?.entry ?? [];
    for (const entry of entries) {
      for (const change of entry.changes ?? []) {
        const value = change.value ?? {};
        const contactName = value.contacts?.[0]?.profile?.name;
        for (const raw of value.messages ?? []) {
          const normalized = normalizeMessage(raw, contactName);
          if (normalized) await processInboundMessage(normalized).catch(error => console.error('[whatsapp webhook] failed to process message', error));
        }
        for (const status of value.statuses ?? []) {
          const mapped = STATUS_MAP[status.status];
          if (!mapped) continue;
          const message = await WhatsAppMessage.findOneAndUpdate(
            { whatsappMessageId: status.id },
            { status: mapped, statusUpdatedAt: new Date(), ...(status.errors?.length ? { failReason: status.errors[0]?.title } : {}) },
            { new: true },
          );
          if (message) emitToConversation(String(message.conversation), 'message:status', { messageId: String(message._id), status: mapped });
        }
      }
    }
  } catch (error) {
    console.error('[whatsapp webhook] error', error);
  }
  res.sendStatus(200);
}
