import 'dotenv/config';
import http from 'node:http';
import { app } from './app.js';
import { connectDatabase } from './config/database.js';
import { attachRealtime } from './realtime.js';
import { scheduleFollowUpJob } from './jobs/followup.job.js';
import { ensureWorkspaceDefaults } from './utils/bootstrap.js';

const port = Number(process.env.PORT ?? 4000);
const server = http.createServer(app);
attachRealtime(server);

connectDatabase()
  .then(() => {
    server.listen(port, () => console.log(`Lead CRM API listening on :${port}`));
    void ensureWorkspaceDefaults();
    scheduleFollowUpJob();
  })
  .catch(error => { console.error(error); process.exit(1); });
