interface CrossAnalyticsParams {
  clientId: string;
  dateFrom: string;
  dateTo: string;
  level?: string;
  campaignId?: string;
  campaignName?: string;
  adsetName?: string;
  platform?: string;
  matchedOnly?: string | boolean;
}

interface CrossKpisParams {
  clientId: string;
  dateFrom: string;
  dateTo: string;
  platform?: string;
  matchedOnly?: string | boolean;
}

export function makeCampaignGroupKey(row: {
  platform?: string | null;
  campaign_id?: string | null;
  campaign_name?: string | null;
}): string {
  return [
    row.platform || '',
    row.campaign_id || '',
    row.campaign_name || '',
  ].join('|');
}

export function buildTotals(data: any[]) {
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

export async function queryCrossAnalytics(supabase: any, params: CrossAnalyticsParams) {
  const {
    clientId, dateFrom, dateTo, level,
    campaignId, campaignName, adsetName, platform, matchedOnly,
  } = params;

  const groupLevel = level || 'campaign';
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
    if (campaignId) q = q.eq('campaign_id', campaignId);
    if (campaignName) q = q.eq('campaign_name', campaignName);
    if (adsetName) q = q.eq('adset_name', adsetName);

    const { data: batch, error } = await q;
    if (error) throw new Error(error.message);
    if (!batch || batch.length === 0) break;

    allRows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    page++;
  }

  if (groupLevel === 'creative') {
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

    const data = Array.from(adMap.values()).map((r) => ({
      ...r,
      cpl: r.leads_crm > 0 ? r.spend / r.leads_crm : 0,
      ctr: r.impressions > 0 ? (r.clicks / r.impressions) * 100 : 0,
      cpc: r.clicks > 0 ? r.spend / r.clicks : 0,
    }));

    data.sort((a, b) => b.spend - a.spend);
    return { data, totals: buildTotals(data) };
  }

  if (groupLevel === 'adset') {
    const adsetMap = new Map<string, any>();
    for (const row of allRows) {
      const key = `${row.platform || ''}|${row.campaign_id || ''}|${row.adset_id || ''}`;
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
          campaign_id: row.campaign_id,
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

    const data = Array.from(adsetMap.values()).map((r) => ({
      ...r,
      cpl: r.leads_crm > 0 ? r.spend / r.leads_crm : 0,
      ctr: r.impressions > 0 ? (r.clicks / r.impressions) * 100 : 0,
      cpc: r.clicks > 0 ? r.spend / r.clicks : 0,
    }));

    data.sort((a, b) => b.spend - a.spend);
    return { data, totals: buildTotals(data) };
  }

  const campMap = new Map<string, any>();
  for (const row of allRows) {
    const key = makeCampaignGroupKey(row);
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
      if (row.campaign_status === 'ACTIVE') existing.campaign_status = 'ACTIVE';
    } else {
      campMap.set(key, {
        group_id: key,
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

  let data = Array.from(campMap.values()).map((r) => ({
    ...r,
    cpl: r.leads_crm > 0 ? r.spend / r.leads_crm : 0,
    ctr: r.impressions > 0 ? (r.clicks / r.impressions) * 100 : 0,
    cpc: r.clicks > 0 ? r.spend / r.clicks : 0,
  }));

  if (matchedOnly === 'true' || matchedOnly === true) {
    data = data.filter((campaign) => campaign.leads_crm > 0);
  }

  data.sort((a, b) => b.spend - a.spend);
  return { data, totals: buildTotals(data) };
}

export async function queryCrossKpis(supabase: any, params: CrossKpisParams) {
  const { clientId, dateFrom, dateTo, platform, matchedOnly } = params;

  async function aggregatePeriod(from: string, to: string) {
    const PAGE_SIZE = 1000;
    const rows: any[] = [];
    let page = 0;

    while (true) {
      let q = supabase
        .from('cross_analytics')
        .select('date, spend, spend_local, impressions, clicks, reach, leads_platform, leads_crm, qualified_leads, mql_leads, sales_count, revenue, campaign_id, campaign_name, platform')
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

    let filteredRows = rows;
    if (matchedOnly === 'true' || matchedOnly === true) {
      const campaignsWithLeads = new Set<string>();
      const leadsByCampaign: Record<string, number> = {};
      for (const row of rows) {
        const key = makeCampaignGroupKey(row);
        leadsByCampaign[key] = (leadsByCampaign[key] || 0) + (Number(row.leads_crm) || 0);
      }
      for (const [key, count] of Object.entries(leadsByCampaign)) {
        if (count > 0) campaignsWithLeads.add(key);
      }
      filteredRows = rows.filter((row) => campaignsWithLeads.has(makeCampaignGroupKey(row)));
    }

    const totals = {
      spend: 0, spend_local: 0, impressions: 0, clicks: 0, reach: 0,
      leads_platform: 0, leads_crm: 0, qualified_leads: 0, mql_leads: 0,
      sales_count: 0, revenue: 0,
    };
    const dailySpend: Record<string, number> = {};

    for (const row of filteredRows) {
      totals.spend += Number(row.spend) || 0;
      totals.spend_local += Number(row.spend_local) || 0;
      totals.impressions += Number(row.impressions) || 0;
      totals.clicks += Number(row.clicks) || 0;
      totals.reach += Number(row.reach) || 0;
      totals.leads_platform += Number(row.leads_platform) || 0;
      totals.leads_crm += Number(row.leads_crm) || 0;
      totals.qualified_leads += Number(row.qualified_leads) || 0;
      totals.mql_leads += Number(row.mql_leads) || 0;
      totals.sales_count += Number(row.sales_count) || 0;
      totals.revenue += Number(row.revenue) || 0;
      dailySpend[row.date] = (dailySpend[row.date] || 0) + (Number(row.spend) || 0);
    }

    return { totals, dailySpend };
  }

  const current = await aggregatePeriod(dateFrom, dateTo);

  const fromDate = new Date(dateFrom);
  const toDate = new Date(dateTo);
  const durationMs = toDate.getTime() - fromDate.getTime() + 24 * 60 * 60 * 1000;
  const prevTo = new Date(fromDate.getTime() - 24 * 60 * 60 * 1000);
  const prevFrom = new Date(prevTo.getTime() - durationMs + 24 * 60 * 60 * 1000);

  const previous = await aggregatePeriod(
    prevFrom.toISOString().split('T')[0],
    prevTo.toISOString().split('T')[0],
  );

  return {
    current: current.totals,
    previous: previous.totals,
    dailySpend: Object.entries(current.dailySpend)
      .map(([date, spend]) => ({ date, spend }))
      .sort((a, b) => a.date.localeCompare(b.date)),
  };
}
