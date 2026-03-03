import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { supabase } from '../lib/supabase';

const router = Router();

// All stats routes require authentication

// GET /api/stats/campaigns?clientId=...&dateFrom=...&dateTo=...&platform=...
router.get('/campaigns', requireAuth, async (req, res) => {
  const { clientId, dateFrom, dateTo, platform } = req.query as Record<string, string>;
  const userId = (req as any).user.id;

  if (!clientId) return res.status(400).json({ error: 'clientId required' });

  // Verify client belongs to user
  const { data: client } = await supabase
    .from('clients')
    .select('id')
    .eq('id', clientId)
    .eq('user_id', userId)
    .single();

  if (!client) return res.status(403).json({ error: 'Access denied' });

  let query = supabase
    .from('campaign_stats')
    .select('*')
    .eq('client_id', clientId)
    .order('date', { ascending: false });

  if (dateFrom) query = query.gte('date', dateFrom);
  if (dateTo) query = query.lte('date', dateTo);
  if (platform) query = query.eq('platform', platform);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  res.json({ data });
});

// GET /api/stats/adsets?clientId=...&dateFrom=...&dateTo=...&campaignId=...
router.get('/adsets', requireAuth, async (req, res) => {
  const { clientId, dateFrom, dateTo, campaignId, platform } = req.query as Record<string, string>;
  const userId = (req as any).user.id;

  if (!clientId) return res.status(400).json({ error: 'clientId required' });

  const { data: client } = await supabase
    .from('clients')
    .select('id')
    .eq('id', clientId)
    .eq('user_id', userId)
    .single();

  if (!client) return res.status(403).json({ error: 'Access denied' });

  let query = supabase
    .from('adset_stats')
    .select('*')
    .eq('client_id', clientId)
    .order('date', { ascending: false });

  if (dateFrom) query = query.gte('date', dateFrom);
  if (dateTo) query = query.lte('date', dateTo);
  if (campaignId) query = query.eq('campaign_id', campaignId);
  if (platform) query = query.eq('platform', platform);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  res.json({ data });
});

// GET /api/stats/creatives?clientId=...&dateFrom=...&dateTo=...
router.get('/creatives', requireAuth, async (req, res) => {
  const { clientId, dateFrom, dateTo, platform, campaignId } = req.query as Record<string, string>;
  const userId = (req as any).user.id;

  if (!clientId) return res.status(400).json({ error: 'clientId required' });

  const { data: client } = await supabase
    .from('clients')
    .select('id')
    .eq('id', clientId)
    .eq('user_id', userId)
    .single();

  if (!client) return res.status(403).json({ error: 'Access denied' });

  let query = supabase
    .from('creative_stats')
    .select('*')
    .eq('client_id', clientId)
    .order('spend', { ascending: false });

  if (dateFrom) query = query.gte('date', dateFrom);
  if (dateTo) query = query.lte('date', dateTo);
  if (platform) query = query.eq('platform', platform);
  if (campaignId) query = query.eq('campaign_id', campaignId);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  res.json({ data });
});

// GET /api/stats/leads?clientId=...&dateFrom=...&dateTo=...&crmType=...
router.get('/leads', requireAuth, async (req, res) => {
  const { clientId, dateFrom, dateTo, crmType } = req.query as Record<string, string>;
  const userId = (req as any).user.id;

  if (!clientId) return res.status(400).json({ error: 'clientId required' });

  const { data: client } = await supabase
    .from('clients')
    .select('id')
    .eq('id', clientId)
    .eq('user_id', userId)
    .single();

  if (!client) return res.status(403).json({ error: 'Access denied' });

  let query = supabase
    .from('crm_leads')
    .select('*')
    .eq('client_id', clientId)
    .order('created_at_crm', { ascending: false });

  if (dateFrom) query = query.gte('created_at_crm', dateFrom);
  if (dateTo) query = query.lte('created_at_crm', dateTo + 'T23:59:59');
  if (crmType) query = query.eq('crm_type', crmType);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  res.json({ data });
});

// GET /api/stats/overview?clientId=...&dateFrom=...&dateTo=...
// Aggregated totals for dashboard overview
router.get('/overview', requireAuth, async (req, res) => {
  const { clientId, dateFrom, dateTo } = req.query as Record<string, string>;
  const userId = (req as any).user.id;

  if (!clientId) return res.status(400).json({ error: 'clientId required' });

  const { data: client } = await supabase
    .from('clients')
    .select('id')
    .eq('id', clientId)
    .eq('user_id', userId)
    .single();

  if (!client) return res.status(403).json({ error: 'Access denied' });

  // Fetch campaign stats for aggregation
  let statsQuery = supabase
    .from('campaign_stats')
    .select('platform,spend,impressions,clicks,leads,date')
    .eq('client_id', clientId);

  if (dateFrom) statsQuery = statsQuery.gte('date', dateFrom);
  if (dateTo) statsQuery = statsQuery.lte('date', dateTo);

  const { data: stats, error: statsError } = await statsQuery;
  if (statsError) return res.status(500).json({ error: statsError.message });

  // Fetch leads count
  let leadsQuery = supabase
    .from('crm_leads')
    .select('id,crm_type,utm_campaign', { count: 'exact', head: false })
    .eq('client_id', clientId);

  if (dateFrom) leadsQuery = leadsQuery.gte('created_at_crm', dateFrom);
  if (dateTo) leadsQuery = leadsQuery.lte('created_at_crm', dateTo + 'T23:59:59');

  const { data: leads, count: totalLeads, error: leadsError } = await leadsQuery;
  if (leadsError) return res.status(500).json({ error: leadsError.message });

  // Aggregate
  const totals = (stats || []).reduce((acc: { spend: number; impressions: number; clicks: number; leads: number }, row: any) => ({
    spend: acc.spend + (row.spend || 0),
    impressions: acc.impressions + (row.impressions || 0),
    clicks: acc.clicks + (row.clicks || 0),
    leads: acc.leads + (row.leads || 0),
  }), { spend: 0, impressions: 0, clicks: 0, leads: 0 });

  const ctr = totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : 0;
  const cpl = totals.leads > 0 ? totals.spend / totals.leads : 0;

  // By platform
  const byPlatform = (stats || []).reduce((acc: Record<string, any>, row: any) => {
    if (!acc[row.platform]) acc[row.platform] = { spend: 0, clicks: 0, leads: 0 };
    acc[row.platform].spend += row.spend || 0;
    acc[row.platform].clicks += row.clicks || 0;
    acc[row.platform].leads += row.leads || 0;
    return acc;
  }, {});

  // Daily spend chart data
  const dailySpend = (stats || []).reduce((acc: Record<string, number>, row: any) => {
    acc[row.date] = (acc[row.date] || 0) + (row.spend || 0);
    return acc;
  }, {});

  res.json({
    totals: { ...totals, ctr, cpl },
    byPlatform,
    dailySpend: Object.entries(dailySpend)
      .map(([date, spend]) => ({ date, spend }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    crmLeads: totalLeads || 0,
  });
});

// GET /api/stats/sync-status?clientId=...
router.get('/sync-status', requireAuth, async (req, res) => {
  const { clientId } = req.query as Record<string, string>;
  const userId = (req as any).user.id;

  if (!clientId) return res.status(400).json({ error: 'clientId required' });

  const { data: client } = await supabase
    .from('clients')
    .select('id')
    .eq('id', clientId)
    .eq('user_id', userId)
    .single();

  if (!client) return res.status(403).json({ error: 'Access denied' });

  const { data: logs } = await supabase
    .from('sync_logs')
    .select('*')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false })
    .limit(20);

  const { data: adAccounts } = await supabase
    .from('ad_accounts')
    .select('id,platform,account_name,last_synced_at,is_active')
    .eq('client_id', clientId);

  const { data: crmConnections } = await supabase
    .from('crm_connections')
    .select('id,type,domain,last_synced_at,is_active')
    .eq('client_id', clientId);

  res.json({ logs, adAccounts, crmConnections });
});

export default router;
