import cron from 'node-cron';
import { runFollowUps } from '../automation/scheduler.service.js';

// Only meaningful under a persistent process (local dev / traditional hosting via
// server.ts). On Vercel serverless there is no long-lived process to hold this timer,
// so that entry point never calls this — use Vercel Cron against
// POST /api/whatsapp/jobs/run-followups instead (see vercel.json).
export function scheduleFollowUpJob() {
  cron.schedule('*/15 * * * *', () => {
    runFollowUps().catch(error => console.error('[followup job] failed', error));
  });
  console.log('ARIA automation scheduler running (every 15 minutes)');
}
