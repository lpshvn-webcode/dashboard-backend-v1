import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { supabase } from '../lib/supabase';
import { matchUtmForClient } from '../services/utm-matcher';
import { buildCrossAnalytics } from '../services/cross-analytics-builder';
import { syncExchangeRates, getExchangeRateHistory } from '../services/exchange-rate-service';

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

  // Paginate to avoid Supabase 1000-row default limit
  const PAGE_SIZE = 1000;
  const allRows: any[] = [];
  let page = 0;

  while (true) {
    let q = supabase
      .from('campaign_stats')
      .select('*')
      .eq('client_id', clientId)
      .order('date', { ascending: false })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

    if (dateFrom) q = q.gte('date', dateFrom);
    if (dateTo) q = q.lte('date', dateTo);
    if (platform) q = q.eq('platform', platform);

    const { data: batch, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    if (!batch || batch.length === 0) break;

    allRows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    page++;
  }

  res.json({ data: allRows });
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

  // Paginate to avoid Supabase 1000-row default limit
  const PAGE_SIZE = 1000;
  const allRows: any[] = [];
  let page = 0;

  while (true) {
    let q = supabase
      .from('adset_stats')
      .select('*')
      .eq('client_id', clientId)
      .order('date', { ascending: false })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

    if (dateFrom) q = q.gte('date', dateFrom);
    if (dateTo) q = q.lte('date', dateTo);
    if (campaignId) q = q.eq('campaign_id', campaignId);
    if (platform) q = q.eq('platform', platform);

    const { data: batch, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    if (!batch || batch.length === 0) break;

    allRows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    page++;
  }

  res.json({ data: allRows });
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

  // Paginate to avoid Supabase 1000-row default limit
  const PAGE_SIZE = 1000;
  const allRows: any[] = [];
  let page = 0;

  while (true) {
    let q = supabase
      .from('creative_stats')
      .select('*')
      .eq('client_id', clientId)
      .order('spend', { ascending: false })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

    if (dateFrom) q = q.gte('date', dateFrom);
    if (dateTo) q = q.lte('date', dateTo);
    if (platform) q = q.eq('platform', platform);
    if (campaignId) q = q.eq('campaign_id', campaignId);

    const { data: batch, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    if (!batch || batch.length === 0) break;

    allRows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    page++;
  }

  res.json({ data: allRows });
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

  // Fetch campaign stats for aggregation (paginated to avoid 1000-row limit)
  const STATS_PAGE_SIZE = 1000;
  const stats: any[] = [];
  let statsPage = 0;

  while (true) {
    let sq = supabase
      .from('campaign_stats')
      .select('platform,spend,impressions,clicks,leads,date')
      .eq('client_id', clientId)
      .order('date', { ascending: false })
      .range(statsPage * STATS_PAGE_SIZE, (statsPage + 1) * STATS_PAGE_SIZE - 1);

    if (dateFrom) sq = sq.gte('date', dateFrom);
    if (dateTo) sq = sq.lte('date', dateTo);

    const { data: statsBatch, error: statsError } = await sq;
    if (statsError) return res.status(500).json({ error: statsError.message });
    if (!statsBatch || statsBatch.length === 0) break;

    stats.push(...statsBatch);
    if (statsBatch.length < STATS_PAGE_SIZE) break;
    statsPage++;
  }

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
  const totals = stats.reduce((acc: { spend: number; impressions: number; clicks: number; leads: number }, row: any) => ({
    spend: acc.spend + (row.spend || 0),
    impressions: acc.impressions + (row.impressions || 0),
    clicks: acc.clicks + (row.clicks || 0),
    leads: acc.leads + (row.leads || 0),
  }), { spend: 0, impressions: 0, clicks: 0, leads: 0 });

  const ctr = totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : 0;
  const cpl = totals.leads > 0 ? totals.spend / totals.leads : 0;

  // By platform
  const byPlatform = stats.reduce((acc: Record<string, any>, row: any) => {
    if (!acc[row.platform]) acc[row.platform] = { spend: 0, clicks: 0, leads: 0 };
    acc[row.platform].spend += row.spend || 0;
    acc[row.platform].clicks += row.clicks || 0;
    acc[row.platform].leads += row.leads || 0;
    return acc;
  }, {});

  // Daily spend chart data
  const dailySpend = stats.reduce((acc: Record<string, number>, row: any) => {
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

// ── Cross-analytics endpoints ─────────────────────────────────────────────────

// POST /api/stats/build-cross-analytics?clientId=...
// Manual trigger to rebuild cross_analytics table
router.post('/build-cross-analytics', requireAuth, async (req, res) => {
  const { clientId, dateFrom, dateTo, fullRebuild } = req.query as Record<string, string>;
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
    const result = await buildCrossAnalytics(clientId, {
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
      fullRebuild: fullRebuild === 'true',
    });
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stats/exchange-rates?currency=KZT&days=90
// Returns stored exchange rate history for the last N days
router.get('/exchange-rates', requireAuth, async (req, res) => {
  const { currency = 'KZT', days = '90' } = req.query as Record<string, string>;
  try {
    const history = await getExchangeRateHistory(currency.toUpperCase(), Number(days));
    res.json({ currency: currency.toUpperCase(), history });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/stats/sync-exchange-rates?currency=KZT&days=90
// Sync exchange rates for the last N days using fawazahmed0 CDN (historical)
router.post('/sync-exchange-rates', requireAuth, async (req, res) => {
  const { currency = 'KZT', days = '90', force = 'false' } = req.query as Record<string, string>;
  const now = new Date();
  const dateTo = now.toISOString().substring(0, 10);
  const dateFrom = new Date(now.getTime() - Number(days) * 24 * 60 * 60 * 1000)
    .toISOString().substring(0, 10);

  try {
    // force=true: delete existing records so they get re-fetched with real historical rates
    if (force === 'true') {
      await supabase
        .from('exchange_rates')
        .delete()
        .eq('from_currency', 'USD')
        .eq('to_currency', currency.toUpperCase())
        .gte('date', dateFrom)
        .lte('date', dateTo);
    }
    const stored = await syncExchangeRates(currency.toUpperCase(), dateFrom, dateTo);
    res.json({ success: true, currency: currency.toUpperCase(), dateFrom, dateTo, stored });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stats/cross-analytics?clientId=...&dateFrom=...&dateTo=...
// &level=campaign|adset|creative&campaignName=...&adsetName=...
// &platform=...&matchedOnly=true
router.get('/cross-analytics', requireAuth, async (req, res) => {
  const { clientId, dateFrom, dateTo, level, campaignName, adsetName, platform, matchedOnly } =
    req.query as Record<string, string>;
  const userId = (req as any).user.id;

  if (!clientId) return res.status(400).json({ error: 'clientId required' });
  if (!dateFrom || !dateTo) return res.status(400).json({ error: 'dateFrom and dateTo required' });

  const { data: client } = await supabase
    .from('clients')
    .select('id')
    .eq('id', clientId)
    .eq('user_id', userId)
    .single();

  if (!client) return res.status(403).json({ error: 'Access denied' });

  const groupLevel = level || 'campaign';

  try {
    // Build base query with date & optional platform filter
    // We use raw SQL via rpc for GROUP BY, since Supabase JS doesn't support it natively.
    // Fallback: paginated select + JS aggregation.

    const PAGE_SIZE = 1000;
    const allRows: any[] = [];
    let page = 0;

    while (true) {
      let q = supabase
        .from('cross_analytics')
        .select('*')
        .eq('client_id', clientId)
        .gte('date', dateFrom)
        .lte('date', dateTo)
        .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

      if (platform) q = q.eq('platform', platform);
      if (campaignName) q = q.eq('campaign_name', campaignName);
      if (adsetName) q = q.eq('adset_name', adsetName);

      const { data: batch, error } = await q;
      if (error) return res.status(500).json({ error: error.message });
      if (!batch || batch.length === 0) break;

      allRows.push(...batch);
      if (batch.length < PAGE_SIZE) break;
      page++;
    }

    // Aggregate based on level
    if (groupLevel === 'creative') {
      // No aggregation — return raw rows (already per ad per day, but group by ad)
      const adMap = new Map<string, any>();
      for (const row of allRows) {
        const key = `${row.ad_id}|${row.ad_account_id}`;
        const existing = adMap.get(key);
        if (existing) {
          existing.spend += Number(row.spend) || 0;
          existing.spend_local = (existing.spend_local || 0) + (Number(row.spend_local) || 0);
          existing.impressions += Number(row.impressions) || 0;
          existing.clicks += Number(row.clicks) || 0;
          existing.reach += Number(row.reach) || 0;
          existing.leads_platform += Number(row.leads_platform) || 0;
          existing.leads_crm += Number(row.leads_crm) || 0;
          existing.qualified_leads += Number(row.qualified_leads) || 0;
          existing.mql_leads = (existing.mql_leads || 0) + (Number(row.mql_leads) || 0);
          existing.sales_count += Number(row.sales_count) || 0;
          existing.revenue += Number(row.revenue) || 0;
        } else {
          adMap.set(key, {
            ad_id: row.ad_id,
            ad_name: row.ad_name,
            ad_status: row.ad_status,
            adset_name: row.adset_name,
            campaign_name: row.campaign_name,
            platform: row.platform,
            image_url: row.image_url,
            thumbnail_url: row.thumbnail_url,
            video_url: row.video_url,
            spend: Number(row.spend) || 0,
            impressions: Number(row.impressions) || 0,
            clicks: Number(row.clicks) || 0,
            reach: Number(row.reach) || 0,
            leads_platform: Number(row.leads_platform) || 0,
            leads_crm: Number(row.leads_crm) || 0,
            qualified_leads: Number(row.qualified_leads) || 0,
            mql_leads: Number(row.mql_leads) || 0,
            sales_count: Number(row.sales_count) || 0,
            revenue: Number(row.revenue) || 0,
            spend_local: Number(row.spend_local) || 0,
          });
        }
      }
      const data = Array.from(adMap.values()).map(r => ({
        ...r,
        cpl: r.leads_crm > 0 ? r.spend / r.leads_crm : 0,
        ctr: r.impressions > 0 ? (r.clicks / r.impressions) * 100 : 0,
        cpc: r.clicks > 0 ? r.spend / r.clicks : 0,
      }));
      data.sort((a, b) => b.spend - a.spend);
      return res.json({ data, totals: buildTotals(data) });
    }

    if (groupLevel === 'adset') {
      const adsetMap = new Map<string, any>();
      for (const row of allRows) {
        const key = `${row.adset_id}|${row.campaign_name}`;
        const existing = adsetMap.get(key);
        if (existing) {
          existing.spend += Number(row.spend) || 0;
          existing.spend_local = (existing.spend_local || 0) + (Number(row.spend_local) || 0);
          existing.impressions += Number(row.impressions) || 0;
          existing.clicks += Number(row.clicks) || 0;
          existing.reach += Number(row.reach) || 0;
          existing.leads_platform += Number(row.leads_platform) || 0;
          existing.leads_crm += Number(row.leads_crm) || 0;
          existing.qualified_leads += Number(row.qualified_leads) || 0;
          existing.mql_leads = (existing.mql_leads || 0) + (Number(row.mql_leads) || 0);
          existing.sales_count += Number(row.sales_count) || 0;
          existing.revenue += Number(row.revenue) || 0;
        } else {
          adsetMap.set(key, {
            adset_id: row.adset_id,
            adset_name: row.adset_name,
            campaign_name: row.campaign_name,
            platform: row.platform,
            spend: Number(row.spend) || 0,
            impressions: Number(row.impressions) || 0,
            clicks: Number(row.clicks) || 0,
            reach: Number(row.reach) || 0,
            leads_platform: Number(row.leads_platform) || 0,
            leads_crm: Number(row.leads_crm) || 0,
            qualified_leads: Number(row.qualified_leads) || 0,
            mql_leads: Number(row.mql_leads) || 0,
            sales_count: Number(row.sales_count) || 0,
            revenue: Number(row.revenue) || 0,
            spend_local: Number(row.spend_local) || 0,
          });
        }
      }
      const data = Array.from(adsetMap.values()).map(r => ({
        ...r,
        cpl: r.leads_crm > 0 ? r.spend / r.leads_crm : 0,
        ctr: r.impressions > 0 ? (r.clicks / r.impressions) * 100 : 0,
        cpc: r.clicks > 0 ? r.spend / r.clicks : 0,
      }));
      data.sort((a, b) => b.spend - a.spend);
      return res.json({ data, totals: buildTotals(data) });
    }

    // Default: campaign level
    const campMap = new Map<string, any>();
    for (const row of allRows) {
      const key = row.campaign_name;
      const existing = campMap.get(key);
      if (existing) {
        existing.spend += Number(row.spend) || 0;
        existing.spend_local = (existing.spend_local || 0) + (Number(row.spend_local) || 0);
        existing.impressions += Number(row.impressions) || 0;
        existing.clicks += Number(row.clicks) || 0;
        existing.reach += Number(row.reach) || 0;
        existing.leads_platform += Number(row.leads_platform) || 0;
        existing.leads_crm += Number(row.leads_crm) || 0;
        existing.qualified_leads += Number(row.qualified_leads) || 0;
        existing.mql_leads = (existing.mql_leads || 0) + (Number(row.mql_leads) || 0);
        existing.sales_count += Number(row.sales_count) || 0;
        existing.revenue += Number(row.revenue) || 0;
        if (row.date < existing.first_date) existing.first_date = row.date;
        if (row.date > existing.last_date) existing.last_date = row.date;
        // Collect unique campaign_statuses — use ACTIVE if any row is active
        if (row.campaign_status === 'ACTIVE') existing.campaign_status = 'ACTIVE';
      } else {
        campMap.set(key, {
          campaign_name: row.campaign_name,
          campaign_id: row.campaign_id,
          campaign_status: row.campaign_status,
          platform: row.platform,
          spend: Number(row.spend) || 0,
          spend_local: Number(row.spend_local) || 0,
          impressions: Number(row.impressions) || 0,
          clicks: Number(row.clicks) || 0,
          reach: Number(row.reach) || 0,
          leads_platform: Number(row.leads_platform) || 0,
          leads_crm: Number(row.leads_crm) || 0,
          qualified_leads: Number(row.qualified_leads) || 0,
          mql_leads: Number(row.mql_leads) || 0,
          sales_count: Number(row.sales_count) || 0,
          revenue: Number(row.revenue) || 0,
          first_date: row.date,
          last_date: row.date,
        });
      }
    }

    let data = Array.from(campMap.values()).map(r => ({
      ...r,
      cpl: r.leads_crm > 0 ? r.spend / r.leads_crm : 0,
      ctr: r.impressions > 0 ? (r.clicks / r.impressions) * 100 : 0,
      cpc: r.clicks > 0 ? r.spend / r.clicks : 0,
    }));

    // matchedOnly: filter to campaigns that have at least 1 CRM lead
    if (matchedOnly === 'true') {
      data = data.filter(c => c.leads_crm > 0);
    }

    data.sort((a, b) => b.spend - a.spend);

    return res.json({ data, totals: buildTotals(data) });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/stats/cross-kpis?clientId=...&dateFrom=...&dateTo=...&platform=...&matchedOnly=true
router.get('/cross-kpis', requireAuth, async (req, res) => {
  const { clientId, dateFrom, dateTo, platform, matchedOnly } = req.query as Record<string, string>;
  const userId = (req as any).user.id;

  if (!clientId) return res.status(400).json({ error: 'clientId required' });
  if (!dateFrom || !dateTo) return res.status(400).json({ error: 'dateFrom and dateTo required' });

  const { data: client } = await supabase
    .from('clients')
    .select('id')
    .eq('id', clientId)
    .eq('user_id', userId)
    .single();

  if (!client) return res.status(403).json({ error: 'Access denied' });

  try {
    // Helper to aggregate a period
    async function aggregatePeriod(from: string, to: string) {
      const PAGE_SIZE = 1000;
      const rows: any[] = [];
      let page = 0;

      while (true) {
        let q = supabase
          .from('cross_analytics')
          .select('date, spend, spend_local, impressions, clicks, reach, leads_platform, leads_crm, qualified_leads, mql_leads, sales_count, revenue, campaign_name')
          .eq('client_id', clientId)
          .gte('date', from)
          .lte('date', to)
          .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

        if (platform) q = q.eq('platform', platform);

        const { data: batch, error } = await q;
        if (error) throw new Error(error.message);
        if (!batch || batch.length === 0) break;
        rows.push(...batch);
        if (batch.length < PAGE_SIZE) break;
        page++;
      }

      // If matchedOnly, first find campaigns with leads
      let filteredRows = rows;
      if (matchedOnly === 'true') {
        const campaignsWithLeads = new Set<string>();
        const leadsByCampaign: Record<string, number> = {};
        for (const r of rows) {
          leadsByCampaign[r.campaign_name] = (leadsByCampaign[r.campaign_name] || 0) + (Number(r.leads_crm) || 0);
        }
        for (const [name, count] of Object.entries(leadsByCampaign)) {
          if (count > 0) campaignsWithLeads.add(name);
        }
        filteredRows = rows.filter(r => campaignsWithLeads.has(r.campaign_name));
      }

      const totals = {
        spend: 0, spend_local: 0, impressions: 0, clicks: 0, reach: 0,
        leads_platform: 0, leads_crm: 0, qualified_leads: 0, mql_leads: 0,
        sales_count: 0, revenue: 0,
      };
      const dailySpend: Record<string, number> = {};

      for (const r of filteredRows) {
        totals.spend += Number(r.spend) || 0;
        totals.spend_local += Number(r.spend_local) || 0;
        totals.impressions += Number(r.impressions) || 0;
        totals.clicks += Number(r.clicks) || 0;
        totals.reach += Number(r.reach) || 0;
        totals.leads_platform += Number(r.leads_platform) || 0;
        totals.leads_crm += Number(r.leads_crm) || 0;
        totals.qualified_leads += Number(r.qualified_leads) || 0;
        totals.mql_leads += Number(r.mql_leads) || 0;
        totals.sales_count += Number(r.sales_count) || 0;
        totals.revenue += Number(r.revenue) || 0;
        dailySpend[r.date] = (dailySpend[r.date] || 0) + (Number(r.spend) || 0);
      }

      return { totals, dailySpend };
    }

    // Current period
    const current = await aggregatePeriod(dateFrom, dateTo);

    // Previous period (same duration, immediately before)
    const fromDate = new Date(dateFrom);
    const toDate = new Date(dateTo);
    const durationMs = toDate.getTime() - fromDate.getTime() + 24 * 60 * 60 * 1000; // inclusive
    const prevTo = new Date(fromDate.getTime() - 24 * 60 * 60 * 1000);
    const prevFrom = new Date(prevTo.getTime() - durationMs + 24 * 60 * 60 * 1000);

    const previous = await aggregatePeriod(
      prevFrom.toISOString().split('T')[0],
      prevTo.toISOString().split('T')[0],
    );

    res.json({
      current: current.totals,
      previous: previous.totals,
      dailySpend: Object.entries(current.dailySpend)
        .map(([date, spend]) => ({ date, spend }))
        .sort((a, b) => a.date.localeCompare(b.date)),
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/stats/debug-data?clientId=...&dateFrom=...&dateTo=...
// Detailed data integrity check: shows raw counts from all tables for a date range
router.get('/debug-data', requireAuth, async (req, res) => {
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

  const from = dateFrom || '2026-01-01';
  const to   = dateTo   || new Date().toISOString().split('T')[0];

  try {
    // ── creative_stats coverage ────────────────────────────────────────────
    const { data: creativeStats } = await supabase
      .from('creative_stats')
      .select('date, spend')
      .eq('client_id', clientId)
      .gte('date', from)
      .lte('date', to)
      .order('date', { ascending: true });

    const creativeByDate: Record<string, { count: number; spend: number }> = {};
    for (const r of creativeStats || []) {
      if (!creativeByDate[r.date]) creativeByDate[r.date] = { count: 0, spend: 0 };
      creativeByDate[r.date].count++;
      creativeByDate[r.date].spend += Number(r.spend) || 0;
    }

    // ── crm_leads breakdown ────────────────────────────────────────────────
    const { data: crmLeads } = await supabase
      .from('crm_leads')
      .select('record_type, is_duplicate, matched_campaign_id, created_at_crm')
      .eq('client_id', clientId)
      .gte('created_at_crm', from)
      .lte('created_at_crm', to + 'T23:59:59');

    const leadsBreakdown = {
      total: 0,
      byRecordType: {} as Record<string, number>,
      duplicates: 0,
      matched: 0,
      matchedNonDup: 0,
      matchedDealsOnly: 0,
    };
    for (const r of crmLeads || []) {
      leadsBreakdown.total++;
      leadsBreakdown.byRecordType[r.record_type || 'unknown'] =
        (leadsBreakdown.byRecordType[r.record_type || 'unknown'] || 0) + 1;
      if (r.is_duplicate) leadsBreakdown.duplicates++;
      if (r.matched_campaign_id) leadsBreakdown.matched++;
      if (r.matched_campaign_id && !r.is_duplicate) leadsBreakdown.matchedNonDup++;
      if (r.matched_campaign_id && !r.is_duplicate && r.record_type === 'deal') leadsBreakdown.matchedDealsOnly++;
    }

    // ── cross_analytics summary ────────────────────────────────────────────
    const { data: crossRows } = await supabase
      .from('cross_analytics')
      .select('spend, leads_crm, leads_platform, qualified_leads, mql_leads, sales_count, revenue')
      .eq('client_id', clientId)
      .gte('date', from)
      .lte('date', to);

    const crossTotals = { rows: 0, spend: 0, leads_crm: 0, leads_platform: 0, qualified_leads: 0, mql_leads: 0, sales_count: 0, revenue: 0 };
    for (const r of crossRows || []) {
      crossTotals.rows++;
      crossTotals.spend += Number(r.spend) || 0;
      crossTotals.leads_crm += Number(r.leads_crm) || 0;
      crossTotals.leads_platform += Number(r.leads_platform) || 0;
      crossTotals.qualified_leads += Number(r.qualified_leads) || 0;
      crossTotals.mql_leads += Number(r.mql_leads) || 0;
      crossTotals.sales_count += Number(r.sales_count) || 0;
      crossTotals.revenue += Number(r.revenue) || 0;
    }

    res.json({
      dateRange: { from, to },
      creativeStats: {
        totalRows: (creativeStats || []).length,
        totalSpend: Object.values(creativeByDate).reduce((s, d) => s + d.spend, 0),
        daysWithData: Object.keys(creativeByDate).length,
        // Show per-day breakdown for quick spotting of missing dates
        byDate: Object.entries(creativeByDate).map(([date, d]) => ({ date, rows: d.count, spend: Math.round(d.spend * 100) / 100 })),
      },
      crmLeads: leadsBreakdown,
      crossAnalytics: crossTotals,
      diagnosis: [
        leadsBreakdown.byRecordType['lead'] > 0 && leadsBreakdown.byRecordType['deal'] > 0
          ? `⚠️ DOUBLE-COUNT RISK: Both leads (${leadsBreakdown.byRecordType['lead']}) and deals (${leadsBreakdown.byRecordType['deal']}) present. Builder now uses deals only (matchedDealsOnly=${leadsBreakdown.matchedDealsOnly}).`
          : '✅ Single record type — no double-count risk.',
        crossTotals.spend < 10 && (creativeStats || []).length > 0
          ? `⚠️ LOW SPEND in cross_analytics ($${crossTotals.spend.toFixed(2)}) vs ${(creativeStats || []).length} creative_stats rows. Run build-cross-analytics to refresh.`
          : `✅ cross_analytics spend: $${crossTotals.spend.toFixed(2)}`,
        Object.keys(creativeByDate).length === 0
          ? '⚠️ No creative_stats data for this date range — trigger FB resync.'
          : `✅ creative_stats has ${Object.keys(creativeByDate).length} days of data.`,
      ],
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Helper function to build totals from aggregated data
function buildTotals(data: any[]) {
  return data.reduce(
    (acc, r) => ({
      spend: acc.spend + (r.spend || 0),
      impressions: acc.impressions + (r.impressions || 0),
      clicks: acc.clicks + (r.clicks || 0),
      reach: acc.reach + (r.reach || 0),
      leads_platform: acc.leads_platform + (r.leads_platform || 0),
      leads_crm: acc.leads_crm + (r.leads_crm || 0),
      qualified_leads: acc.qualified_leads + (r.qualified_leads || 0),
      mql_leads: acc.mql_leads + (r.mql_leads || 0),
      sales_count: acc.sales_count + (r.sales_count || 0),
      revenue: acc.revenue + (r.revenue || 0),
      spend_local: acc.spend_local + (r.spend_local || 0),
    }),
    { spend: 0, impressions: 0, clicks: 0, reach: 0, leads_platform: 0, leads_crm: 0, qualified_leads: 0, mql_leads: 0, sales_count: 0, revenue: 0, spend_local: 0 },
  );
}

export default router;
