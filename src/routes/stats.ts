import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { supabase } from '../lib/supabase';
import { matchUtmForClient } from '../services/utm-matcher';

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

  // Paginate to avoid Supabase 1000-row default limit.
  // Exclude duplicates (is_duplicate=true) — they should not appear in dashboard.
  const PAGE_SIZE = 1000;
  const allRows: any[] = [];
  let page = 0;

  while (true) {
    let q = supabase
      .from('crm_leads')
      .select('*')
      .eq('client_id', clientId)
      .eq('is_duplicate', false)
      .order('created_at_crm', { ascending: false })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

    if (dateFrom) q = q.gte('created_at_crm', dateFrom);
    if (dateTo) q = q.lte('created_at_crm', dateTo + 'T23:59:59');
    if (crmType) q = q.eq('crm_type', crmType);

    const { data: batch, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    if (!batch || batch.length === 0) break;

    allRows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    page++;
  }

  res.json({ data: allRows });
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

// GET /api/stats/debug-utm?clientId=...
// Диагностика UTM-матчинга: показывает состояние лидов и кампаний
router.get('/debug-utm', requireAuth, async (req, res) => {
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

  // Всего лидов
  const { count: totalLeads } = await supabase
    .from('crm_leads')
    .select('*', { count: 'exact', head: true })
    .eq('client_id', clientId);

  // Лиды с хоть одной UTM-меткой
  const { count: leadsWithUtm } = await supabase
    .from('crm_leads')
    .select('*', { count: 'exact', head: true })
    .eq('client_id', clientId)
    .or('utm_source.not.is.null,utm_medium.not.is.null,utm_campaign.not.is.null,utm_content.not.is.null,utm_term.not.is.null');

  // Лиды с успешным матчингом
  const { count: matchedLeads } = await supabase
    .from('crm_leads')
    .select('*', { count: 'exact', head: true })
    .eq('client_id', clientId)
    .not('matched_campaign_id', 'is', null);

  // Примеры лидов с UTM
  const { data: sampleLeads, error: sampleError } = await supabase
    .from('crm_leads')
    .select('id, name, utm_source, utm_medium, utm_campaign, utm_content, utm_term, matched_campaign_id')
    .eq('client_id', clientId)
    .or('utm_campaign.not.is.null,utm_source.not.is.null,utm_content.not.is.null')
    .limit(5);

  // Первые лиды БЕЗ UTM (для понимания проблемы)
  const { data: leadsNoUtm } = await supabase
    .from('crm_leads')
    .select('id, name, utm_source, utm_medium, utm_campaign, utm_content, utm_term')
    .eq('client_id', clientId)
    .is('utm_campaign', null)
    .is('utm_source', null)
    .limit(3);

  // Уникальные имена кампаний из campaign_stats
  const { data: campaigns } = await supabase
    .from('campaign_stats')
    .select('campaign_name')
    .eq('client_id', clientId)
    .limit(50);

  const uniqueCampaignNames = [...new Set((campaigns || []).map((c: any) => c.campaign_name))];

  let diagnosis = '';
  if ((leadsWithUtm || 0) === 0) {
    diagnosis = 'PROBLEM: CRM leads have NO UTM tags. Check that landing pages pass utm_* params to the CRM.';
  } else if ((matchedLeads || 0) === 0) {
    diagnosis = 'PROBLEM: Leads have UTM tags but no campaign name matches. Compare sampleLeadsWithUtm.utm_campaign vs sampleCampaignNames.';
  } else {
    diagnosis = `OK: ${matchedLeads} leads matched to campaigns.`;
  }

  res.json({
    totalLeads: totalLeads || 0,
    leadsWithUtm: leadsWithUtm || 0,
    matchedLeads: matchedLeads || 0,
    diagnosis,
    sampleLeadsWithUtm: sampleLeads || [],
    sampleLeadsWithoutUtm: leadsNoUtm || [],
    sampleCampaignNames: uniqueCampaignNames,
    sampleError: sampleError?.message,
  });
});

// POST /api/stats/match-utm?clientId=...&force=true
// Запускает UTM-матчинг вручную для клиента
router.post('/match-utm', requireAuth, async (req, res) => {
  const { clientId, force } = req.query as Record<string, string>;
  const userId = (req as any).user.id;

  if (!clientId) return res.status(400).json({ error: 'clientId required' });

  const { data: client } = await supabase
    .from('clients')
    .select('id')
    .eq('id', clientId)
    .eq('user_id', userId)
    .single();

  if (!client) return res.status(403).json({ error: 'Access denied' });

  try {
    const result = await matchUtmForClient(clientId, force === 'true');
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
