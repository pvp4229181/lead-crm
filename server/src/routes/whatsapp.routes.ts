import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { authorize } from '../middleware/auth.js';
import { asyncHandler } from '../utils/http.js';
import * as wa from '../controllers/whatsapp.controller.js';
import * as ai from '../controllers/whatsapp-ai.controller.js';
import * as kb from '../controllers/whatsapp-knowledge.controller.js';
import { verifyWebhook, verifySignature, receiveWebhook } from '../webhooks/whatsapp.webhook.js';
import { runFollowUps } from '../services/automation.service.js';

// Mounted publicly (before requireAuth) — Meta calls these directly, authenticated
// only by the verify-token handshake and the X-Hub-Signature-256 check.
export const whatsappWebhook = Router();
whatsappWebhook.get('/webhooks/whatsapp', verifyWebhook);
whatsappWebhook.post('/webhooks/whatsapp', verifySignature, asyncHandler(receiveWebhook));

// Vercel Cron (or any external scheduler) hits this with a shared secret instead of a
// user session, since serverless functions can't host a persistent node-cron timer.
// Mounted publicly for the same reason the webhook is: there is no user to authenticate as.
// Vercel Cron issues a GET request signed as `Authorization: Bearer <CRON_SECRET>`;
// other schedulers can POST with an `x-cron-secret` header instead — either is accepted.
const cronLimiter = rateLimit({ windowMs: 60_000, limit: 6 });
const runFollowUpsHandler = asyncHandler(async (req, res) => {
  const authorized = Boolean(process.env.CRON_SECRET) && (req.header('x-cron-secret') === process.env.CRON_SECRET || req.header('authorization') === `Bearer ${process.env.CRON_SECRET}`);
  if (!authorized) return res.sendStatus(401);
  res.json(await runFollowUps());
});
whatsappWebhook.get('/whatsapp/jobs/run-followups', cronLimiter, runFollowUpsHandler);
whatsappWebhook.post('/whatsapp/jobs/run-followups', cronLimiter, runFollowUpsHandler);

const managerUp = authorize('Administrator', 'Sales Manager');
const adminOnly = authorize('Administrator');

export const whatsappApi = Router();

whatsappApi.get('/whatsapp/conversations', asyncHandler(wa.listConversations));
whatsappApi.get('/whatsapp/conversations/:id', asyncHandler(wa.getConversation));
whatsappApi.patch('/whatsapp/conversations/:id', asyncHandler(wa.updateConversation));
// Irreversible and it destroys the customer's own messages, so it sits behind a manager
// role even though the scope check would already limit it. Salespeople archive instead.
whatsappApi.delete('/whatsapp/conversations/:id', managerUp, asyncHandler(wa.deleteConversation));
whatsappApi.get('/whatsapp/conversations/:id/messages', asyncHandler(wa.listMessages));
whatsappApi.post('/whatsapp/conversations/:id/messages', asyncHandler(wa.sendMessage));
whatsappApi.post('/whatsapp/conversations/:id/suggest-reply', asyncHandler(wa.suggestReply));
whatsappApi.post('/whatsapp/conversations/:id/read', asyncHandler(wa.markRead));
whatsappApi.patch('/whatsapp/conversations/:id/ai', asyncHandler(wa.setAiEnabled));
whatsappApi.post('/whatsapp/conversations/:id/takeover', asyncHandler(wa.takeover));
whatsappApi.post('/whatsapp/conversations/:id/resume-ai', asyncHandler(wa.resumeAi));
whatsappApi.post('/whatsapp/send', asyncHandler(wa.sendTemplate));
whatsappApi.get('/whatsapp/messages/:id/media', asyncHandler(wa.getMedia));
whatsappApi.get('/whatsapp/dashboard/metrics', asyncHandler(wa.dashboardMetrics));

whatsappApi.get('/whatsapp/ai-settings', managerUp, asyncHandler(ai.getAiSettings));
whatsappApi.patch('/whatsapp/ai-settings', managerUp, asyncHandler(ai.updateAiSettings));
whatsappApi.get('/whatsapp/accounts', managerUp, asyncHandler(ai.listAccounts));
whatsappApi.post('/whatsapp/accounts', adminOnly, asyncHandler(ai.createAccount));
whatsappApi.patch('/whatsapp/accounts/:id', adminOnly, asyncHandler(ai.updateAccount));
whatsappApi.delete('/whatsapp/accounts/:id', adminOnly, asyncHandler(ai.deleteAccount));

for (const kind of ['products', 'services', 'faqs', 'articles'] as const) {
  whatsappApi.get(`/whatsapp/knowledge/${kind}`, asyncHandler(kb.listKnowledge(kind)));
  whatsappApi.post(`/whatsapp/knowledge/${kind}`, managerUp, asyncHandler(kb.createKnowledge(kind)));
  whatsappApi.patch(`/whatsapp/knowledge/${kind}/:id`, managerUp, asyncHandler(kb.updateKnowledge(kind)));
  whatsappApi.delete(`/whatsapp/knowledge/${kind}/:id`, managerUp, asyncHandler(kb.deleteKnowledge(kind)));
}

whatsappApi.get('/whatsapp/templates', asyncHandler(kb.listTemplates));
whatsappApi.post('/whatsapp/templates', managerUp, asyncHandler(kb.createTemplate));
whatsappApi.post('/whatsapp/templates/sync', managerUp, asyncHandler(kb.syncTemplates));
whatsappApi.patch('/whatsapp/templates/:id', managerUp, asyncHandler(kb.updateTemplate));
whatsappApi.delete('/whatsapp/templates/:id', managerUp, asyncHandler(kb.deleteTemplate));

whatsappApi.get('/whatsapp/campaigns', managerUp, asyncHandler(kb.listCampaigns));
whatsappApi.post('/whatsapp/campaigns', managerUp, asyncHandler(kb.createCampaign));
whatsappApi.post('/whatsapp/campaigns/preview-audience', managerUp, asyncHandler(kb.previewCampaignAudience));
whatsappApi.post('/whatsapp/campaigns/:id/send', managerUp, asyncHandler(kb.sendCampaign));
whatsappApi.delete('/whatsapp/campaigns/:id', managerUp, asyncHandler(kb.deleteCampaign));
