import type { Request, Response } from 'express';
import { WhatsAppAccount } from '../models/index.js';
import { getActiveAIConfig, replaceWithRecommendedAgentTemplate } from '../services/ai.service.js';
import { aiConfigurationInput, accountInput } from '../validators/whatsapp.validators.js';
import { ApiError } from '../utils/http.js';
import { getWebhookSubscription, subscribeWebhook } from '../services/whatsapp.service.js';

export async function getAiSettings(_req: Request, res: Response) {
  res.json(await getActiveAIConfig());
}

export async function updateAiSettings(req: Request, res: Response) {
  const input = aiConfigurationInput.parse(req.body);
  const config = await getActiveAIConfig();
  Object.assign(config, input);
  await config.save();
  res.json(config);
}

export async function applyRecommendedTemplate(_req: Request, res: Response) {
  res.json(await replaceWithRecommendedAgentTemplate());
}

export async function listAccounts(_req: Request, res: Response) {
  res.json(await WhatsAppAccount.find({}).sort('-createdAt'));
}

export async function createAccount(req: Request, res: Response) {
  const input = accountInput.parse(req.body);
  res.status(201).json(await WhatsAppAccount.create(input));
}

export async function updateAccount(req: Request, res: Response) {
  const input = accountInput.partial().parse(req.body);
  const account = await WhatsAppAccount.findByIdAndUpdate(req.params.id, input, { new: true, runValidators: true });
  if (!account) throw new ApiError(404, 'Account not found');
  res.json(account);
}

export async function deleteAccount(req: Request, res: Response) {
  const account = await WhatsAppAccount.findByIdAndDelete(req.params.id);
  if (!account) throw new ApiError(404, 'Account not found');
  res.status(204).end();
}

export async function webhookSubscription(_req: Request, res: Response) {
  res.json(await getWebhookSubscription());
}

export async function enableWebhookSubscription(_req: Request, res: Response) {
  const result = await subscribeWebhook();
  if (!result.ok) throw new ApiError(502, result.error ?? 'Meta rejected the webhook subscription');
  res.json(result);
}
