import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';

import statsRouter from './routes/stats';
import connectionsRouter from './routes/connections';
import cronRouter from './routes/cron';
import webhooksRouter from './routes/webhooks';
import { syncAllAdsAccounts, syncAllCrmConnections } from './services/sync-orchestrator';

const app = express();

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Routes ─────────────────────────────────────────────────────────────────────
app.use('/api/stats', statsRouter);
app.use('/api/connections', connectionsRouter);
app.use('/api/cron', cronRouter);
app.use('/api/webhooks', webhooksRouter);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

// ── Nightly auto-sync scheduler ────────────────────────────────────────────────
// Runs once a night between 00:00–01:00 (server local time).
// Syncs all active ad accounts (last 5 days) and all CRM connections.
// Random minute prevents all deploys from hitting FB/CRM APIs at exactly midnight.
const nightSyncMinute = Math.floor(Math.random() * 60);
console.log(`[Scheduler] Nightly sync scheduled at 00:${String(nightSyncMinute).padStart(2, '0')}`);

cron.schedule(`${nightSyncMinute} 0 * * *`, async () => {
  console.log('[Scheduler] ── Nightly sync starting (5-day incremental) ──');

  try {
    await syncAllAdsAccounts(undefined, 5);
    console.log('[Scheduler] Ads sync complete');
  } catch (err: any) {
    console.error('[Scheduler] Ads sync failed:', err.message);
  }

  try {
    await syncAllCrmConnections();
    console.log('[Scheduler] CRM sync complete');
  } catch (err: any) {
    console.error('[Scheduler] CRM sync failed:', err.message);
  }

  console.log('[Scheduler] ── Nightly sync finished ──');
});

// ── Start ──────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`[Server] Running on port ${PORT}`);
});

export default app;
