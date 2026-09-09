# Lead CRM

An ERP-style lead and opportunity CRM built with React, Express, TypeScript and MongoDB.

## Start locally

1. Copy `server/.env.example` to `server/.env`.
2. Start MongoDB locally (transactions in lead conversion require a replica set in production).
3. Run `npm install`, `npm run seed`, then `npm run dev`.
   (`npm run seed` wipes and rebuilds the demo workspace. To install or refresh only the
   ARIA automation templates against an existing database, run `npm run seed:automation`.)
4. Sign in with `admin@orbitcrm.test` / `Password123!`.

The web app runs at `http://localhost:5173` and the API at `http://localhost:4000`.

## ARIA — WhatsApp AI sales agent

**ARIA** is the AI agent that answers WhatsApp, qualifies the lead, and drives the CRM.
Configure the Meta Cloud API and AI provider values in `server/.env` (see `server/.env.example`).
The agent runs without credentials using the built-in `mock` provider, so the whole pipeline
is exercisable before any keys exist.

- **Inbox:** `/whatsapp` — conversations, chat, and the linked CRM lead panel.
- **Automation:** `/whatsapp/automation` (Administrator / Sales Manager only) — templates,
  automations, triggers, variables, run logs, AI settings, knowledge base, broadcasts and
  connected accounts.
- **Webhook:** point Meta at `POST /api/webhooks/whatsapp`, using `WHATSAPP_VERIFY_TOKEN`
  for the handshake. Once `WHATSAPP_APP_SECRET` is set, unsigned requests are rejected.
- **Scheduler:** `node-cron` runs follow-ups and delayed automations every 15 minutes under
  `npm run dev`. On serverless, Vercel Cron calls `/api/whatsapp/jobs/run-followups` with
  `CRON_SECRET` instead.

### No customer-facing copy lives in the code

Every message ARIA sends is an **automation template** stored in MongoDB and edited from
**WhatsApp Automation → Templates**. Controllers, routes, the webhook handler and the AI
services resolve a template at run time; none of them contain a customer-visible sentence.
Changing what ARIA says never requires a deploy.

A template has a stable `templateKey`, a trigger, a message body with `{{variables}}`,
optional conditions, a delay, reply buttons, a priority and a status
(`draft` / `active` / `paused` / `archived`). The twelve ARIA templates ship active:

| Key | Trigger | Purpose |
| --- | --- | --- |
| `welcome_message` | `new_whatsapp_lead` | First reply, with AI/pricing/human buttons |
| `lead_qualification` | `lead_requires_qualification` | Asks only for the fields the CRM lacks |
| `product_service_enquiry` | `product_or_service_interest` | Knowledge-base product answer |
| `appointment_booking` | `appointment_requested` | Collects a preferred slot |
| `human_handoff` | `human_agent_requested` | Confirms transfer, pauses ARIA |
| `quotation_ready` | `quotation_created` | Quote summary and link |
| `no_response_follow_up` | `lead_no_response` | 1-4 reply mapped to a CRM outcome |
| `hot_lead_alert` | `lead_score_threshold_reached` | Internal only — never sent to the lead |
| `payment_reminder` | `payment_due` | Pending invoice |
| `payment_confirmation` | `payment_successful` | Confirmed payment only |
| `order_project_status` | `status_changed` | Order/project update |
| `customer_feedback` | `service_completed` | 1-5 rating, stored on the lead |

Three supporting templates (`outside_business_hours`, `ai_resumed`, `service_catalogue`)
cover the rest of the flow so no wording is left in code.

**Variables** are resolved in one place (`server/src/automation/variable.service.ts`). A
variable with no value is never sent as `{{name}}`: the line is dropped, a safe fallback is
used (`{{first_name}}` → "there"), or — when the template marks it required — the message
is not sent at all. `quotation_ready` cannot send without a quote number and amount, and
`product_service_enquiry` cannot send without a real catalogue item, so ARIA cannot invent
a price or a quote.

### Seeding and migrating

`npm run seed:automation` cleans up the previous automation system and installs the ARIA
pack. It is idempotent — `templateKey` is the unique identifier, so running it repeatedly
never duplicates anything:

1. deletes the legacy `followuprules` collection (its hardcoded chase messages are now
   automations),
2. deletes the two demo Meta templates the old seed shipped (`welcome_intro`,
   `demo_reminder`) unless a campaign still references them, in which case they are kept
   and reported,
3. upserts the ARIA templates and automations,
4. cancels scheduled runs whose automation no longer exists,
5. prints a report of everything it removed, created and deliberately left alone.

Admin-created templates (`source: 'custom'`) are never touched, and wording an admin edited
on an ARIA template survives re-seeding — only structural fields are refreshed. The same
migration runs automatically on a cold start when the template collection is empty, so a
workspace created through admin signup is never left with a mute agent.

### Lead scoring and pipeline

Scoring points and the Cold / Warm / Qualified / Hot thresholds are configurable under
**AI Settings**: requested pricing +10, demo +20, quotation +25, budget +15, timeline under
30 days +15, company +5, email +5, repeated engagement +5, asked for a human +10, capped at
100. Crossing the hot threshold fires the internal alert once. The qualification stage moves
forward only (`new → contacted → engaged → qualified → proposal → negotiation → won`, or
sideways into `lost`); nothing moves a lead backwards without an explicit rule.

### Human takeover

A conversation carries a `mode` of `ai`, `human` or `hybrid`. Taking it over — from the
inbox, a customer tapping "Talk to a human", or an escalation — sets `human`, pauses ARIA,
cancels every queued follow-up, and blocks automation sends at the executor. Returning it to
AI mode resumes both.

### Verifying it works

- `npm run smoke -w server` — end-to-end pipeline test against an in-memory MongoDB: lead
  creation, template-driven welcome, qualification, stage movement, escalation, human
  takeover, duplicate webhook delivery, follow-up capping and AI-failure handling.
- `npm run automation-check -w server` — the automation API: template CRUD, search, filters,
  duplication, preview/test, automation CRUD, logs, variable resolution and conditions.
- `npm run bootstrap-check -w server` — workspace bootstrapping, the ARIA migration's
  legacy cleanup, and the guarantee that admin-created templates survive it.
- `npm run ai-check -w server` — calls the configured AI provider with the real key in
  `server/.env` and prints the reply plus parsed analysis.

None of these need credentials except `ai-check`.

If the AI provider is unreachable (rate limit, expired key), the pipeline never leaves the
customer on silent read: it flags the conversation **Waiting for Human**, disables auto-reply,
and notifies the assigned salesperson. Free OpenRouter models share a rate-limited pool and
return 429 frequently — set `AI_FALLBACK_MODELS` to route around it, or use a paid model.

## Email invitations and roles

Configure `RESEND_API_KEY`, `EMAIL_FROM`, and `APP_URL` in `server/.env`. Then sign in as an Administrator and open **Configuration → Users → Invite person**. Select the recipient's role and Lead CRM will email a single-use link where they set their own password.

Get an API key from the [Resend dashboard](https://resend.com/api-keys). `EMAIL_FROM` must be an address on a domain you've verified in Resend (e.g. `Lead CRM <no-reply@yourdomain.com>`) — Resend rejects sends from unverified domains. In production, `APP_URL` must be the public HTTPS URL of the web application.
