import { supabase } from '../lib/supabase';

/**
 * Builds / refreshes the `cross_analytics` table for a given client.
 *
 * Data flow:
 *   1. Load creative_stats (finest grain – each ad per day)
 *   2. Join with adset_stats / campaign_stats to get hierarchy names
 *   3. Load matched CRM leads and attribute them to the correct ad + date
 *   4. Upsert everything into cross_analytics
 *
 * Called automatically after:
 *   – Ad-platform sync  (FB / Google)
 *   – CRM sync + UTM matching
 */

const PAGE_SIZE = 1000;

// ── Helpers ────────────────────────────────────────────────────────────────────

async function paginatedSelect(
  table: string,
  clientId: string,
  selectFields: string,
  extraFilters?: (q: any) => any,
): Promise<any[]> {
  const all: any[] = [];
  let page = 0;

  while (true) {
    let q = supabase
      .from(table)
      .select(selectFields)
      .eq('client_id', clientId)
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

    if (extraFilters) q = extraFilters(q);

    const { data: batch, error } = await q;
    if (error) {
      console.error(`[CrossBuilder] Failed to fetch ${table} page ${page}:`, error.message);
      break;
    }
    if (!batch || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    page++;
  }
  return all;
}

// ── Main builder ───────────────────────────────────────────────────────────────

export interface BuildOptions {
  dateFrom?: string;   // YYYY-MM-DD, defaults to 90 days ago
  dateTo?: string;     // YYYY-MM-DD, defaults to today
  fullRebuild?: boolean;
}

export async function buildCrossAnalytics(
  clientId: string,
  options?: BuildOptions,
): Promise<{ rowsUpserted: number; leadsAttributed: number }> {
  const now = new Date();
  const dateTo = options?.dateTo ?? now.toISOString().split('T')[0];
  const dateFrom =
    options?.dateFrom ??
    new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  console.log(`[CrossBuilder] Building for client=${clientId} range=${dateFrom}..${dateTo} fullRebuild=${!!options?.fullRebuild}`);

  // ── 1. Full rebuild: delete existing rows in date range ─────────────────────
  if (options?.fullRebuild) {
    const { error: delErr } = await supabase
      .from('cross_analytics')
      .delete()
      .eq('client_id', clientId)
      .gte('date', dateFrom)
      .lte('date', dateTo);
    if (delErr) console.error('[CrossBuilder] Delete failed:', delErr.message);
  }

  // ── 2. Load creative_stats (finest grain) ──────────────────────────────────
  const creatives = await paginatedSelect(
    'creative_stats',
    clientId,
    'ad_account_id, date, campaign_id, adset_id, ad_id, ad_name, status, spend, impressions, clicks, leads, ctr, cpl, image_url, thumbnail_url, video_url, currency, platform',
    (q) => q.gte('date', dateFrom).lte('date', dateTo),
  );
  console.log(`[CrossBuilder] Loaded ${creatives.length} creative_stats rows`);

  // ── 3. Build name maps from campaign_stats & adset_stats ───────────────────
  const campaignRows = await paginatedSelect(
    'campaign_stats',
    clientId,
    'campaign_id, campaign_name, status, platform',
  );
  // campaign_id → { name, status }
  const campaignMap = new Map<string, { name: string; status: string }>();
  for (const r of campaignRows) {
    if (r.campaign_id && !campaignMap.has(r.campaign_id)) {
      campaignMap.set(r.campaign_id, { name: r.campaign_name, status: r.status });
    }
  }

  const adsetRows = await paginatedSelect(
    'adset_stats',
    clientId,
    'adset_id, adset_name, campaign_id',
  );
  // adset_id → { name, campaign_id }
  const adsetMap = new Map<string, { name: string; campaignId: string }>();
  for (const r of adsetRows) {
    if (r.adset_id && !adsetMap.has(r.adset_id)) {
      adsetMap.set(r.adset_id, { name: r.adset_name, campaignId: r.campaign_id });
    }
  }

  console.log(`[CrossBuilder] Maps: ${campaignMap.size} campaigns, ${adsetMap.size} adsets`);

  // ── 4. Build cross_analytics rows from creatives ───────────────────────────
  interface CrossRow {
    client_id: string;
    date: string;
    platform: string;
    ad_account_id: string;
    campaign_id: string;
    campaign_name: string;
    campaign_status: string | null;
    adset_id: string;
    adset_name: string;
    ad_id: string;
    ad_name: string;
    ad_status: string | null;
    image_url: string | null;
    thumbnail_url: string | null;
    video_url: string | null;
    spend: number;
    impressions: number;
    clicks: number;
    reach: number;
    leads_platform: number;
    ctr: number;
    cpc: number;
    currency: string;
    leads_crm: number;
    qualified_leads: number;
    sales_count: number;
    revenue: number;
  }

  // Key for lookup: campaign_name|adset_name|ad_name|date
  const rowMap = new Map<string, CrossRow>();

  function makeKey(campaignName: string, adsetName: string, adName: string, date: string): string {
    return `${campaignName}|${adsetName}|${adName}|${date}`;
  }

  let skippedNoHierarchy = 0;

  for (const c of creatives) {
    const adsetInfo = adsetMap.get(c.adset_id);
    const campaignId = adsetInfo?.campaignId ?? c.campaign_id;
    const campaignInfo = campaignMap.get(campaignId);

    if (!campaignInfo || !adsetInfo) {
      skippedNoHierarchy++;
      continue;
    }

    const row: CrossRow = {
      client_id: clientId,
      date: c.date,
      platform: c.platform,
      ad_account_id: c.ad_account_id,
      campaign_id: campaignId,
      campaign_name: campaignInfo.name,
      campaign_status: campaignInfo.status,
      adset_id: c.adset_id,
      adset_name: adsetInfo.name,
      ad_id: c.ad_id,
      ad_name: c.ad_name,
      ad_status: c.status,
      image_url: c.image_url ?? null,
      thumbnail_url: c.thumbnail_url ?? null,
      video_url: c.video_url ?? null,
      spend: Number(c.spend) || 0,
      impressions: Number(c.impressions) || 0,
      clicks: Number(c.clicks) || 0,
      reach: 0,   // creative_stats usually doesn't have reach; will aggregate from adsets
      leads_platform: Number(c.leads) || 0,
      ctr: Number(c.ctr) || 0,
      cpc: Number(c.spend) && Number(c.clicks) ? Number(c.spend) / Number(c.clicks) : 0,
      currency: c.currency || 'USD',
      leads_crm: 0,
      qualified_leads: 0,
      sales_count: 0,
      revenue: 0,
    };

    const key = makeKey(campaignInfo.name, adsetInfo.name, c.ad_name, c.date);
    // If duplicate key (same ad_id + date from different accounts is unlikely, but handle)
    const existing = rowMap.get(key);
    if (existing) {
      existing.spend += row.spend;
      existing.impressions += row.impressions;
      existing.clicks += row.clicks;
      existing.leads_platform += row.leads_platform;
    } else {
      rowMap.set(key, row);
    }
  }

  console.log(`[CrossBuilder] Built ${rowMap.size} cross rows, skipped ${skippedNoHierarchy} (no hierarchy)`);

  // ── 5. Load matched CRM leads and attribute to cross rows ──────────────────
  const leads = await paginatedSelect(
    'crm_leads',
    clientId,
    'id, matched_campaign_id, matched_adset_id, matched_ad_id, created_at_crm, price, status, is_duplicate',
    (q) => q.not('matched_campaign_id', 'is', null).eq('is_duplicate', false),
  );

  console.log(`[CrossBuilder] Loaded ${leads.length} matched CRM leads`);

  let leadsAttributed = 0;
  let leadsUnattributed = 0;

  for (const lead of leads) {
    const campaignName = lead.matched_campaign_id as string;
    const adsetName = lead.matched_adset_id as string;
    const adName = lead.matched_ad_id as string;

    // Extract date from created_at_crm
    const createdDate = lead.created_at_crm
      ? lead.created_at_crm.substring(0, 10)   // "2026-03-05T12:00:00" → "2026-03-05"
      : null;

    if (!createdDate || !campaignName) {
      leadsUnattributed++;
      continue;
    }

    // Try exact match by name + date
    const key = makeKey(campaignName, adsetName || '', adName || '', createdDate);
    let target = rowMap.get(key);

    // If no exact date match, try to find ANY row for this ad triple (closest date)
    if (!target && adsetName && adName) {
      // Create a zero-spend attribution row
      // Find any existing row with this ad triple to get platform/ad_account_id
      let templateRow: CrossRow | undefined;
      for (const [k, r] of rowMap) {
        if (r.campaign_name === campaignName && r.adset_name === adsetName && r.ad_name === adName) {
          templateRow = r;
          break;
        }
      }

      if (templateRow) {
        target = {
          ...templateRow,
          date: createdDate,
          spend: 0,
          impressions: 0,
          clicks: 0,
          reach: 0,
          leads_platform: 0,
          ctr: 0,
          cpc: 0,
          leads_crm: 0,
          qualified_leads: 0,
          sales_count: 0,
          revenue: 0,
        };
        rowMap.set(key, target);
      }
    }

    if (target) {
      target.leads_crm += 1;
      target.revenue += Number(lead.price) || 0;
      // TODO: qualified_leads and sales_count based on stage config
      leadsAttributed++;
    } else {
      leadsUnattributed++;
    }
  }

  console.log(`[CrossBuilder] Leads attributed=${leadsAttributed}, unattributed=${leadsUnattributed}`);

  // ── 6. Upsert into cross_analytics in batches ─────────────────────────────
  const allRows = Array.from(rowMap.values());
  const BATCH = 200;
  let upsertErrors = 0;

  for (let i = 0; i < allRows.length; i += BATCH) {
    const batch = allRows.slice(i, i + BATCH);

    const { error } = await supabase
      .from('cross_analytics')
      .upsert(
        batch.map((r) => ({
          client_id: r.client_id,
          date: r.date,
          platform: r.platform,
          ad_account_id: r.ad_account_id,
          campaign_id: r.campaign_id,
          campaign_name: r.campaign_name,
          campaign_status: r.campaign_status,
          adset_id: r.adset_id,
          adset_name: r.adset_name,
          ad_id: r.ad_id,
          ad_name: r.ad_name,
          ad_status: r.ad_status,
          image_url: r.image_url,
          thumbnail_url: r.thumbnail_url,
          video_url: r.video_url,
          spend: r.spend,
          impressions: r.impressions,
          clicks: r.clicks,
          reach: r.reach,
          leads_platform: r.leads_platform,
          ctr: r.ctr,
          cpc: r.cpc,
          currency: r.currency,
          leads_crm: r.leads_crm,
          qualified_leads: r.qualified_leads,
          sales_count: r.sales_count,
          revenue: r.revenue,
          updated_at: new Date().toISOString(),
        })),
        { onConflict: 'client_id,date,ad_id,ad_account_id' },
      );

    if (error) {
      upsertErrors++;
      if (upsertErrors <= 3) console.error('[CrossBuilder] Upsert error:', error.message);
    }
  }

  const rowsUpserted = allRows.length;
  console.log(`[CrossBuilder] Done: ${rowsUpserted} rows upserted, ${upsertErrors} errors, ${leadsAttributed} leads attributed`);

  return { rowsUpserted, leadsAttributed };
}
