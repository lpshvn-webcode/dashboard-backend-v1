import { Router } from 'express';
import { requireAuth, requireAuthFromQuery } from '../middleware/auth';
import { supabase } from '../lib/supabase';
import { syncAllAdsAccounts, syncSingleCrmConnection } from '../services/sync-orchestrator';
import { syncFacebookAccount } from '../services/facebook';
import { syncBitrix24, fetchBitrixEntities, fetchBitrixStages, fetchBitrixFieldOptions } from '../services/bitrix24';
import { syncAmoCRM } from '../services/amocrm';
import { matchUtmForClient } from '../services/utm-matcher';
import { buildCrossAnalytics } from '../services/cross-analytics-builder';
import axios from 'axios';
import crypto from 'crypto';

const router = Router();

// ── Facebook OAuth ──────────────────────────────────────────────────────────────

const FB_API_VERSION = 'v19.0';

// In-memory OAuth state store (TTL: 10 minutes)
const oauthStates = new Map<string, { userId: string; clientId: string; expires: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of oauthStates.entries()) {
    if (val.expires < now) oauthStates.delete(key);
  }
}, 60_000);

/** HTML page sent after OAuth callback — sends postMessage to opener and closes popup */
function oauthCallbackHtml(payload: object): string {
  const json = JSON.stringify(payload);
  return `<!DOCTYPE html><html><body><script>
    try { window.opener.postMessage(${json}, '*'); } catch(e) {}
    window.close();
  </script></body></html>`;
}

// GET /api/connections/facebook/oauth/start?token=...&clientId=...
// Opens FB OAuth dialog (called from a popup window, auth via query token)
router.get('/facebook/oauth/start', requireAuthFromQuery, async (req, res) => {
  const { clientId } = req.query as Record<string, string>;
  const userId = (req as any).user.id;

  const { data: client } = await supabase
    .from('clients').select('id').eq('id', clientId).eq('user_id', userId).single();
  if (!client) return res.status(403).send('Access denied');

  const state = crypto.randomUUID();
  oauthStates.set(state, { userId, clientId, expires: Date.now() + 10 * 60 * 1000 });

  const backendUrl = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 3001}`;
  const params = new URLSearchParams({
    client_id: process.env.FACEBOOK_APP_ID!,
    redirect_uri: `${backendUrl}/api/connections/facebook/oauth/callback`,
    scope: 'ads_management,ads_read,business_management,pages_read_engagement,pages_show_list',
    response_type: 'code',
    state,
  });

  res.redirect(`https://www.facebook.com/${FB_API_VERSION}/dialog/oauth?${params}`);
});

// GET /api/connections/facebook/oauth/callback
// FB redirects here after user authorizes. Exchanges code for long-lived token,
// fetches available ad accounts, sends result via postMessage to the opener popup.
router.get('/facebook/oauth/callback', async (req, res) => {
  const { code, state, error: fbError } = req.query as Record<string, string>;

  if (fbError || !code || !state) {
    return res.send(oauthCallbackHtml({ error: fbError || 'OAuth cancelled' }));
  }

  const stateData = oauthStates.get(state);
  if (!stateData || stateData.expires < Date.now()) {
    return res.send(oauthCallbackHtml({ error: 'Invalid or expired OAuth state' }));
  }
  oauthStates.delete(state);

  try {
    const backendUrl = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 3001}`;
    const redirectUri = `${backendUrl}/api/connections/facebook/oauth/callback`;

    // 1. Exchange code → short-lived token
    const tokenRes = await axios.get(`https://graph.facebook.com/${FB_API_VERSION}/oauth/access_token`, {
      params: {
        client_id: process.env.FACEBOOK_APP_ID,
        client_secret: process.env.FACEBOOK_APP_SECRET,
        redirect_uri: redirectUri,
        code,
      },
    });
    const shortToken: string = tokenRes.data.access_token;

    // 2. Exchange short-lived → long-lived token (~60 days)
    const longTokenRes = await axios.get(`https://graph.facebook.com/${FB_API_VERSION}/oauth/access_token`, {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: process.env.FACEBOOK_APP_ID,
        client_secret: process.env.FACEBOOK_APP_SECRET,
        fb_exchange_token: shortToken,
      },
    });
    const longToken: string = longTokenRes.data.access_token;
    const expiresIn: number = longTokenRes.data.expires_in; // seconds (~5184000 = 60 days)

    // 3. Fetch all ad accounts the user has access to
    const accountsRes = await axios.get(`https://graph.facebook.com/${FB_API_VERSION}/me/adaccounts`, {
      params: {
        access_token: longToken,
        fields: 'account_id,name,currency,account_status,business',
        limit: 100,
      },
    });
    const accounts: Array<{ account_id: string; name: string; currency: string; account_status: number; business?: { id: string; name: string } }> =
      accountsRes.data.data || [];

    return res.send(oauthCallbackHtml({
      ok: true,
      accessToken: longToken,
      expiresIn,
      clientId: stateData.clientId,
      accounts,
    }));
  } catch (err: any) {
    const msg = err.response?.data?.error?.message || err.message || 'OAuth error';
    console.error('[FB OAuth] Callback error:', msg);
    return res.send(oauthCallbackHtml({ error: msg }));
  }
});

// POST /api/connections/facebook/oauth/save-accounts
// Body: { clientId, accountIds: string[], accessToken: string, expiresIn: number }
// Saves selected ad accounts to the database
router.post('/facebook/oauth/save-accounts', requireAuth, async (req, res) => {
  const { clientId, accountIds, accessToken, expiresIn } = req.body as {
    clientId: string;
    accountIds: string[];
    accessToken: string;
    expiresIn: number;
  };
  const userId = (req as any).user.id;

  const { data: client } = await supabase
    .from('clients').select('id').eq('id', clientId).eq('user_id', userId).single();
  if (!client) return res.status(403).json({ error: 'Access denied' });

  const tokenExpiresAt = expiresIn
    ? new Date(Date.now() + expiresIn * 1000).toISOString()
    : new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(); // 60 days fallback

  const { accountNames = {} } = req.body as { accountNames?: Record<string, string> };
  const records = accountIds.map(accountId => {
    const cleanId = accountId.replace(/^act_/, '');
    return {
      client_id: clientId,
      platform: 'facebook',
      account_id: cleanId,
      account_name: accountNames[cleanId] || accountNames[accountId] || cleanId,
      access_token: accessToken,
      token_expires_at: tokenExpiresAt,
      is_active: true,
    };
  });

  const { error } = await supabase
    .from('ad_accounts')
    .upsert(records, { onConflict: 'client_id,platform,account_id' });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, saved: records.length });
});

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

    // Manual sync always covers the last 90 days (full re-pull with daily breakdown).
    // This ensures cross_analytics has complete data regardless of last_synced_at.
    const until = new Date();
    const since = new Date();
    since.setDate(since.getDate() - 90);
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
      result = await syncAllAdsAccounts(account.client_id, 90);
    }

    // Rebuild cross-analytics after manual ad sync
    sendProgress('Сквозная аналитика...', 95);
    try {
      const crossResult = await buildCrossAnalytics(account.client_id, {
        dateFrom: dateRange.since,
        dateTo: dateRange.until,
      });
      console.log(`[Ad Sync Stream] Cross-analytics built: rows=${crossResult.rowsUpserted}, leads=${crossResult.leadsAttributed}`);
    } catch (err: any) {
      console.error('[Ad Sync Stream] Cross-analytics build failed:', err.message);
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
    .select('id,type,domain,sync_type,sync_config,is_active,last_synced_at,created_at')
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

// GET /api/connections/crm/:id/bitrix-entities  — fetch available entities from Bitrix24
router.get('/crm/:id/bitrix-entities', requireAuth, async (req, res) => {
  const userId = (req as any).user.id;

  const { data: conn } = await supabase
    .from('crm_connections').select('*').eq('id', req.params.id).single();
  if (!conn) return res.status(404).json({ error: 'Not found' });

  const { data: client } = await supabase
    .from('clients').select('id').eq('id', conn.client_id).eq('user_id', userId).single();
  if (!client) return res.status(403).json({ error: 'Access denied' });

  if (conn.type !== 'bitrix24') return res.status(400).json({ error: 'Only supported for Bitrix24' });

  try {
    const entities = await fetchBitrixEntities(conn as any);
    res.json({ data: entities });
  } catch (err: any) {
    console.error('[Bitrix entities] Error:', err.message);
    res.status(500).json({ error: err.message || 'Ошибка при получении сущностей' });
  }
});

// GET /api/connections/crm/:id/stages  — fetch pipeline stages from CRM
router.get('/crm/:id/stages', requireAuth, async (req, res) => {
  const userId = (req as any).user.id;
  const { data: conn } = await supabase
    .from('crm_connections').select('*').eq('id', req.params.id).single();
  if (!conn) return res.status(404).json({ error: 'Not found' });
  const { data: client } = await supabase
    .from('clients').select('id').eq('id', conn.client_id).eq('user_id', userId).single();
  if (!client) return res.status(403).json({ error: 'Access denied' });

  try {
    const result = await fetchBitrixStages(conn as any);
    res.json(result);
  } catch (err: any) {
    console.error('[Bitrix stages] Error:', err.message);
    res.status(500).json({ error: err.message || 'Ошибка при получении стадий' });
  }
});

// GET /api/connections/crm/:id/field-options?fieldCode=XXX  — fetch enum options for a field
router.get('/crm/:id/field-options', requireAuth, async (req, res) => {
  const userId = (req as any).user.id;
  const { fieldCode } = req.query as Record<string, string>;
  if (!fieldCode) return res.status(400).json({ error: 'fieldCode is required' });

  const { data: conn } = await supabase
    .from('crm_connections').select('*').eq('id', req.params.id).single();
  if (!conn) return res.status(404).json({ error: 'Not found' });
  const { data: client } = await supabase
    .from('clients').select('id').eq('id', conn.client_id).eq('user_id', userId).single();
  if (!client) return res.status(403).json({ error: 'Access denied' });

  try {
    const result = await fetchBitrixFieldOptions(conn as any, fieldCode);
    res.json(result);
  } catch (err: any) {
    console.error('[Bitrix field options] Error:', err.message);
    res.status(500).json({ error: err.message || 'Ошибка при получении вариантов поля' });
  }
});

// PATCH /api/connections/crm/:id/sync-config  — save granular sync config
router.patch('/crm/:id/sync-config', requireAuth, async (req, res) => {
  const userId = (req as any).user.id;
  const { sync_config } = req.body;

  const { data: conn } = await supabase
    .from('crm_connections').select('client_id').eq('id', req.params.id).single();
  if (!conn) return res.status(404).json({ error: 'Not found' });

  const { data: client } = await supabase
    .from('clients').select('id').eq('id', conn.client_id).eq('user_id', userId).single();
  if (!client) return res.status(403).json({ error: 'Access denied' });

  const { error } = await supabase
    .from('crm_connections')
    .update({ sync_config })
    .eq('id', req.params.id);

  if (error) return res.status(500).json({ error: error.message });
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

  // sendProgress is safe: never throws even if the client closed the SSE connection early.
  // syncBitrix24 sends progress=100 internally (step "Завершение..."), which may cause
  // the frontend to close the EventSource — after that res.write() would throw EPIPE.
  // Wrapping prevents that error from bubbling up and skipping the UTM matching step.
  const sendProgress = (step: string, progress: number) => {
    if (res.writableEnded) return;
    try {
      res.write(`data: ${JSON.stringify({ step, progress, timestamp: Date.now() })}\n\n`);
    } catch (_) { /* client disconnected — ignore, server-side work must continue */ }
  };

  // Validate connection and permissions before starting sync
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

  try {
    let result: any;
    if (conn.type === 'bitrix24') {
      result = await syncBitrix24(conn as any, undefined, sendProgress);
    } else if (conn.type === 'amocrm') {
      result = await syncAmoCRM(conn as any, undefined, sendProgress);
    }

    // UTM-матчинг после синхронизации CRM.
    // Runs unconditionally — even if frontend already closed the SSE connection,
    // server-side matching must complete so Supabase data is up to date.
    sendProgress('UTM-матчинг...', 90);
    try {
      const matchResult = await matchUtmForClient(conn.client_id);
      console.log(`[Sync Stream] UTM matching done: matched=${matchResult.matched}, skipped=${matchResult.skipped}`);
      result = { ...result, matched: matchResult.matched, skipped: matchResult.skipped };
    } catch (err: any) {
      console.error('[Sync Stream] UTM matching failed:', err.message);
    }

    // Build cross-analytics table
    sendProgress('Сквозная аналитика...', 95);
    try {
      const crossResult = await buildCrossAnalytics(conn.client_id);
      console.log(`[Sync Stream] Cross-analytics built: rows=${crossResult.rowsUpserted}, leads=${crossResult.leadsAttributed}`);
    } catch (err: any) {
      console.error('[Sync Stream] Cross-analytics build failed:', err.message);
    }

    clearTimeout(timeout);
    sendProgress('Завершено', 100);
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ step: 'Завершено', progress: 100, done: true, result })}\n\n`);
      res.end();
    }
  } catch (error: any) {
    clearTimeout(timeout);
    console.error('[Sync Stream] Error:', error);
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ error: error.message || 'Ошибка синхронизации', step: 'Ошибка', progress: 0 })}\n\n`);
      res.end();
    }
  }
});

export default router;
