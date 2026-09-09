import { Router } from 'express';
import { authorize } from '../middleware/auth.js';
import { asyncHandler } from '../utils/http.js';
import * as automation from './automation.controller.js';

// Mounted inside the authenticated API router (see routes/index.ts), so every route here
// already requires a signed-in user. Reading is open to any CRM user; anything that
// changes what ARIA sends is Administrator / Sales Manager only, and destructive or
// system-wide operations are Administrator only.
const managerUp = authorize('Administrator', 'Sales Manager');
const adminOnly = authorize('Administrator');

export const automationApi = Router();

automationApi.get('/automation/catalogue', asyncHandler(automation.catalogue));

automationApi.get('/automation-templates', asyncHandler(automation.listTemplates));
automationApi.post('/automation-templates', managerUp, asyncHandler(automation.createTemplate));
automationApi.get('/automation-templates/:id', asyncHandler(automation.getTemplate));
automationApi.put('/automation-templates/:id', managerUp, asyncHandler(automation.updateTemplate));
automationApi.patch('/automation-templates/:id', managerUp, asyncHandler(automation.updateTemplate));
automationApi.delete('/automation-templates/:id', adminOnly, asyncHandler(automation.deleteTemplate));
automationApi.post('/automation-templates/:id/duplicate', managerUp, asyncHandler(automation.duplicate));
automationApi.patch('/automation-templates/:id/status', managerUp, asyncHandler(automation.setTemplateStatus));
automationApi.post('/automation-templates/:id/test', managerUp, asyncHandler(automation.testTemplate));

automationApi.get('/automations', asyncHandler(automation.listAutomations));
automationApi.post('/automations', managerUp, asyncHandler(automation.createAutomation));
automationApi.put('/automations/:id', managerUp, asyncHandler(automation.updateAutomation));
automationApi.patch('/automations/:id', managerUp, asyncHandler(automation.updateAutomation));
automationApi.delete('/automations/:id', adminOnly, asyncHandler(automation.deleteAutomation));

automationApi.get('/automation-logs', managerUp, asyncHandler(automation.listLogs));
automationApi.get('/automation-logs/summary', managerUp, asyncHandler(automation.logSummary));

automationApi.post('/automation/migrate', adminOnly, asyncHandler(automation.runMigration));
