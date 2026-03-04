import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { supabase } from '../lib/supabase';
import { syncAllAdsAccounts, syncSingleCrmConnection } from '../services/sync-orchestrator';

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

export default router;
