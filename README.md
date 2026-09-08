# Lead CRM

An ERP-style lead and opportunity CRM built with React, Express, TypeScript and MongoDB.

## Start locally

1. Copy `server/.env.example` to `server/.env`.
2. Start MongoDB locally (transactions in lead conversion require a replica set in production).
3. Run `npm install`, `npm run seed`, then `npm run dev`.
4. Sign in with `admin@orbitcrm.test` / `Password123!`.

The web app runs at `http://localhost:5173` and the API at `http://localhost:4000`.

## WhatsApp AI Sales Agent

Configure the Meta Cloud API and AI provider values in `server/.env` (see `server/.env.example`).
The agent runs without credentials using the built-in `mock` provider, so the whole
pipeline is exercisable before any keys exist.

- **Inbox:** `/whatsapp` — conversations, chat, and the linked CRM lead panel.
- **Configuration:** `/whatsapp/settings` (Administrator / Sales Manager only) — agent
  persona, knowledge base, templates, campaigns, and connected accounts.
- **Webhook:** point Meta at `POST /api/webhooks/whatsapp`, using `WHATSAPP_VERIFY_TOKEN`
  for the handshake. Once `WHATSAPP_APP_SECRET` is set, unsigned requests are rejected.
- **Follow-ups:** `node-cron` runs them every 15 minutes under `npm run dev`. On serverless,
  Vercel Cron calls `/api/whatsapp/jobs/run-followups` with `CRON_SECRET` instead.

### Verifying it works

- `npm run smoke -w server` — end-to-end pipeline test against an in-memory MongoDB:
  lead creation, qualification, stage movement, escalation, human takeover, duplicate
  webhook delivery, and AI-failure handling. Needs no credentials.
- `npm run ai-check -w server` — calls the configured AI provider with the real key in
  `server/.env` and prints the reply plus parsed analysis.

If the AI provider is unreachable (rate limit, expired key), the pipeline never leaves the
customer on silent read: it flags the conversation **Waiting for Human**, disables auto-reply,
and notifies the assigned salesperson. Free OpenRouter models share a rate-limited pool and
return 429 frequently — set `AI_FALLBACK_MODELS` to route around it, or use a paid model.

## Email invitations and roles

Configure `RESEND_API_KEY`, `EMAIL_FROM`, and `APP_URL` in `server/.env`. Then sign in as an Administrator and open **Configuration → Users → Invite person**. Select the recipient's role and Lead CRM will email a single-use link where they set their own password.

Get an API key from the [Resend dashboard](https://resend.com/api-keys). `EMAIL_FROM` must be an address on a domain you've verified in Resend (e.g. `Lead CRM <no-reply@yourdomain.com>`) — Resend rejects sends from unverified domains. In production, `APP_URL` must be the public HTTPS URL of the web application.
