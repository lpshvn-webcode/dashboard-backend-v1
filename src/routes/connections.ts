import { Router } from 'express';
import { requireAuth, requireAuthFromQuery } from '../middleware/auth';
import { supabase } from '../lib/supabase';
import { syncAllAdsAccounts, syncSingleCrmConnection } from '../services/sync-orchestrator';
import { syncFacebookAccount } from '../services/facebook';
import { syncBitrix24 } from '../services/bitrix24';
import { syncAmoCRM } from '../services/amocrm';
import { matchUtmForClient } from '../services/utm-matcher';

const router = Router();

// ── Ad Accounts ────────────────────────────────────────────────────────────────

// GET /api/connections/ad-accounts?clientId=...
router.get('/ad-accounts', requireAuth, async (req, res) => {
  const { clientId } = req.query as Record<string, string>;
  const userId = (req as any).user.id;

  const { data: client } = await supabase
    .from('clients').select('id').eq('id', clientId).eq('user_id', userId).single();
  if (!client) return res.status(403).json({ error: 'Access denied' });

  const { data, error } = await supabase
    .from('ad_accounts')
    .select('id,platform,account_id,account_name,is_active,last_synced_at,created_at')
    .eq('client_id', clientId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ data });
});

// POST /api/connections/ad-accounts
// Body: { clientId, platform, accountId, accountName, accessToken, refreshToken? }
router.post('/ad-accounts', requireAuth, async (req, res) => {
  const { clientId, platform, accountId, accountName, accessToken, refreshToken } = req.body;
  const userId = (req as any).user.id;

  const { data: client } = await supabase
    .from('clients').select('id').eq('id', clientId).eq('user_id', userId).single();
  if (!client) return res.status(403).json({ error: 'Access denied' });

  // Check limit: max 5 accounts per platform per client
  const { count } = await supabase
    .from('ad_accounts')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', clientId)
    .eq('platform', platform);

  if ((count || 0) >= 5) {
    return res.status(400).json({ error: 'Maximum 5 accounts per platform' });
  }

  const { data, error } = await supabase
    .from('ad_accounts')
    .insert({
      client_id: clientId,
      platform,
      account_id: accountId,
      account_name: accountName,
      access_token: accessToken,
      refresh_token: refreshToken,
      is_active: true,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ data });
});

// DELETE /api/connections/ad-accounts/:id
router.delete('/ad-accounts/:id', requireAuth, async (req, res) => {
  const userId = (req as any).user.id;

  const { data: account } = await supabase
    .from('ad_accounts')
    .select('client_id')
    .eq('id', req.params.id)
    .single();

  if (!account) return res.status(404).json({ error: 'Not found' });

  const { data: client } = await supabase
    .from('clients').select('id').eq('id', account.client_id).eq('user_id', userId).single();
  if (!client) return res.status(403).json({ error: 'Access denied' });

  await supabase.from('ad_accounts').delete().eq('id', req.params.id);
  res.json({ ok: true });
});

// POST /api/connections/ad-accounts/:id/sync  — trigger manual sync
router.post('/ad-accounts/:id/sync', requireAuth, async (req, res) => {
  const userId = (req as any).user.id;

  const { data: account } = await supabase
    .from('ad_accounts')
    .select('*')
    .eq('id', req.params.id)
    .single();

  if (!account) return res.status(404).json({ error: 'Not found' });

  const { data: client } = await supabase
    .from('clients').select('id').eq('id', account.client_id).eq('user_id', userId).single();
  if (!client) return res.status(403).json({ error: 'Access denied' });

  // Trigger async sync (don't wait for it)
  syncAllAdsAccounts(account.client_id).catch(console.error);
  res.json({ ok: true, message: 'Sync started' });
});

// GET /api/connections/ad-accounts/:id/sync-stream  — SSE streaming ad account sync
const AD_SYNC_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

router.get('/ad-accounts/:id/sync-stream', requireAuthFromQuery, async (req, res) => {
  const userId = (req as any).user.id;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const timeout = setTimeout(() => {
    res.write(`data: ${JSON.stringify({ error: 'Sync timeout exceeded', step: 'Ошибка', progress: 0 })}\n\n`);
    res.end();
  }, AD_SYNC_TIMEOUT_MS);

  const sendProgress = (step: string, progress: number) => {
    res.write(`data: ${JSON.stringify({ step, progress, timestamp: Date.now() })}\n\n`);
  };

  try {
    const { data: account } = await supabase
      .from('ad_accounts').select('*').eq('id', req.params.id).single();

    if (!account) {
      clearTimeout(timeout);
      res.write(`data: ${JSON.stringify({ error: 'Account not found', step: 'Ошибка', progress: 0 })}\n\n`);
      return res.end();
    }

    const { data: client } = await supabase
      .from('clients').select('id').eq('id', account.client_id).eq('user_id', userId).single();

    if (!client) {
      clearTimeout(timeout);
      res.write(`data: ${JSON.stringify({ error: 'Access denied', step: 'Ошибка', progress: 0 })}\n\n`);
      return res.end();
    }

    // Determine date range (same logic as sync-orchestrator)
    const until = new Date();
    const since = new Date();
    if (account.last_synced_at) {
      since.setDate(since.getDate() - 2);
    } else {
      since.setDate(since.getDate() - 30);
    }
    const dateRange = {
      since: since.toISOString().split('T')[0],
      until: until.toISOString().split('T')[0],
    };

    let result: any;
    if (account.platform === 'facebook') {
      result = await syncFacebookAccount(account as any, dateRange, sendProgress);
    } else {
      // Google / other: fallback without progress
      sendProgress('Синхронизация...', 50);
      result = await syncAllAdsAccounts(account.client_id);
    }

    clearTimeout(timeout);
    res.write(`data: ${JSON.stringify({ step: 'Завершено', progress: 100, done: true, result })}\n\n`);
    res.end();
  } catch (error: any) {
    clearTimeout(timeout);
    console.error('[Ad Sync Stream] Error:', error);
    res.write(`data: ${JSON.stringify({ error: error.message || 'Ошибка синхронизации', step: 'Ошибка', progress: 0 })}\n\n`);
    res.end();
  }
});

// ── CRM Connections ────────────────────────────────────────────────────────────

// GET /api/connections/crm?clientId=...
router.get('/crm', requireAuth, async (req, res) => {
  const { clientId } = req.query as Record<string, string>;
  const userId = (req as any).user.id;

  const { data: client } = await supabase
    .from('clients').select('id').eq('id', clientId).eq('user_id', userId).single();
  if (!client) return res.status(403).json({ error: 'Access denied' });

  const { data, error } = await supabase
    .from('crm_connections')
    .select('id,type,domain,sync_type,is_active,last_synced_at,created_at')
    .eq('client_id', clientId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ data });
});

// POST /api/connections/crm
// Body: { clientId, type, domain, accessToken, refreshToken?, syncType? }
router.post('/crm', requireAuth, async (req, res) => {
  const { clientId, type, domain, accessToken, refreshToken, syncType } = req.body;
  const userId = (req as any).user.id;

  const { data: client } = await supabase
    .from('clients').select('id').eq('id', clientId).eq('user_id', userId).single();
  if (!client) return res.status(403).json({ error: 'Access denied' });

  const { data, error } = await supabase
    .from('crm_connections')
    .insert({
      client_id: clientId,
      type,
      domain: domain.replace(/^https?:\/\//, ''),
      access_token: accessToken,
      refresh_token: refreshToken,
      sync_type: syncType || 'leads',
      is_active: true,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ data });
});

// DELETE /api/connections/crm/:id
router.delete('/crm/:id', requireAuth, async (req, res) => {
  const userId = (req as any).user.id;

  const { data: conn } = await supabase
    .from('crm_connections').select('client_id').eq('id', req.params.id).single();
  if (!conn) return res.status(404).json({ error: 'Not found' });

  const { data: client } = await supabase
    .from('clients').select('id').eq('id', conn.client_id).eq('user_id', userId).single();
  if (!client) return res.status(403).json({ error: 'Access denied' });

  await supabase.from('crm_connections').delete().eq('id', req.params.id);
  res.json({ ok: true });
});

// POST /api/connections/crm/:id/sync  — trigger manual CRM sync (awaits completion)
router.post('/crm/:id/sync', requireAuth, async (req, res) => {
  const userId = (req as any).user.id;

  const { data: conn } = await supabase
    .from('crm_connections').select('*').eq('id', req.params.id).single();
  if (!conn) return res.status(404).json({ error: 'Not found' });

  const { data: client } = await supabase
    .from('clients').select('id').eq('id', conn.client_id).eq('user_id', userId).single();
  if (!client) return res.status(403).json({ error: 'Access denied' });

  try {
    const result = await syncSingleCrmConnection(conn);
    res.json({ ok: true, message: 'CRM sync complete', result });
  } catch (err: any) {
    console.error(`[Sync] CRM sync failed for ${conn.id}:`, err.message);
    res.status(500).json({ error: err.message || 'Sync failed' });
  }
});

// POST /api/connections/crm/:id/sync-stream  — SSE streaming CRM sync with progress
const SYNC_STREAM_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

router.get('/crm/:id/sync-stream', requireAuthFromQuery, async (req, res) => {
  const userId = (req as any).user.id;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Close SSE after 5 minutes to prevent indefinite connections
  const timeout = setTimeout(() => {
    res.write(`data: ${JSON.stringify({ error: 'Sync timeout exceeded', step: 'Ошибка', progress: 0 })}\n\n`);
    res.end();
  }, SYNC_STREAM_TIMEOUT_MS);

  const sendProgress = (step: string, progress: number) => {
    res.write(`data: ${JSON.stringify({ step, progress, timestamp: Date.now() })}\n\n`);
  };

  try {
    const { data: conn } = await supabase
      .from('crm_connections').select('*').eq('id', req.params.id).single();

    if (!conn) {
      clearTimeout(timeout);
      res.write(`data: ${JSON.stringify({ error: 'Connection not found', step: 'Ошибка', progress: 0 })}\n\n`);
      return res.end();
    }

    const { data: client } = await supabase
      .from('clients').select('id').eq('id', conn.client_id).eq('user_id', userId).single();

    if (!client) {
      clearTimeout(timeout);
      res.write(`data: ${JSON.stringify({ error: 'Access denied', step: 'Ошибка', progress: 0 })}\n\n`);
      return res.end();
    }

    let result: any;
    if (conn.type === 'bitrix24') {
      result = await syncBitrix24(conn as any, undefined, sendProgress);
    } else if (conn.type === 'amocrm') {
      result = await syncAmoCRM(conn as any, undefined, sendProgress);
    }

    // UTM-матчинг после синхронизации CRM
    sendProgress('UTM-матчинг...', 97);
    try {
      const matchResult = await matchUtmForClient(conn.client_id);
      result = { ...result, matched: matchResult.matched, skipped: matchResult.skipped };
    } catch (err: any) {
      console.error('[Sync Stream] UTM matching failed:', err.message);
    }

    clearTimeout(timeout);
    res.write(`data: ${JSON.stringify({ step: 'Завершено', progress: 100, done: true, result })}\n\n`);
    res.end();
  } catch (error: any) {
    clearTimeout(timeout);
    console.error('[Sync Stream] Error:', error);
    res.write(`data: ${JSON.stringify({ error: error.message || 'Ошибка синхронизации', step: 'Ошибка', progress: 0 })}\n\n`);
    res.end();
  }
});

export default router;
