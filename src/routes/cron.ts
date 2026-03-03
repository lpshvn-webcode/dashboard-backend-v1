import { Router } from 'express';
import { requireCronSecret } from '../middleware/auth';
import { syncAllAdsAccounts, syncAllCrmConnections } from '../services/sync-orchestrator';

const router = Router();

// POST /api/cron/sync-ads  — called by Vercel Cron every 4 hours
router.post('/sync-ads', requireCronSecret, async (req, res) => {
  console.log('[Cron] Starting ads sync...');
  try {
    await syncAllAdsAccounts();
    res.json({ ok: true, message: 'Ads sync completed' });
  } catch (err: any) {
    console.error('[Cron] Ads sync failed:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/cron/sync-crm  — called by Vercel Cron every 3 hours
router.post('/sync-crm', requireCronSecret, async (req, res) => {
  console.log('[Cron] Starting CRM sync...');
  try {
    await syncAllCrmConnections();
    res.json({ ok: true, message: 'CRM sync completed' });
  } catch (err: any) {
    console.error('[Cron] CRM sync failed:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
