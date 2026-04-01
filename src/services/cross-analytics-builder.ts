import he from 'he';
import { supabase } from '../lib/supabase';

/**
 * Builds / refreshes the `cross_analytics` table for a given client.
 *
 * Data flow:
 *   1. Delete existing rows in date range (clean-slate approach, removes stale promo rows)
 *   2. Load creative_stats (finest grain – each ad per day)
 *   3. Join with adset_stats / campaign_stats to get hierarchy names
 *   4. Skip promo/boost posts (campaign = adset = ad name after normalization)
 *   5. Load matched CRM leads and attribute them to the correct ad + date
 *   6. Upsert everything into cross_analytics
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

/**
 * Normalize string for comparison (same logic as utm-matcher.ts):
 *  1. Decode HTML entities
 *  2. Lowercase
 *  3. Collapse whitespace / hyphens / dashes / underscores → single space + trim
 */
function normalize(s: string | null | undefined): string {
  if (!s) return '';
  const decoded = he.decode(s);
  return decoded.toLowerCase().replace(/[\s\-\u2013\u2014_]+/g, ' ').trim();
}

// ── Main builder ───────────────────────────────────────────────────────────────

export interface BuildOptions {
  dateFrom?: string;   // YYYY-MM-DD, defaults to 90 days ago
  dateTo?: string;     // YYYY-MM-DD, defaults to today
  /** @deprecated – kept for backward compat; builder always does clean rebuild for the date range */
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

  console.log(`[CrossBuilder] Building for client=${clientId} range=${dateFrom}..${dateTo}`);

  // ── 1. Always delete existing rows in date range (clean slate) ──────────────
  // This removes stale promo rows and ensures the table stays consistent.
  const { error: delErr } = await supabase
    .from('cross_analytics')
    .delete()
    .eq('client_id', clientId)
    .gte('date', dateFrom)
    .lte('date', dateTo);
  if (delErr) console.error('[CrossBuilder] Delete failed:', delErr.message);

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
  let skippedPromo = 0;

  for (const c of creatives) {
    const adsetInfo = adsetMap.get(c.adset_id);
    const campaignId = adsetInfo?.campaignId ?? c.campaign_id;
    const campaignInfo = campaignMap.get(campaignId);

    if (!campaignInfo || !adsetInfo) {
      skippedNoHierarchy++;
      continue;
    }

    // ── Skip promo/boost posts (all 3 names identical after normalization) ────
    // Mirrors the same check in utm-matcher.ts: these posts have no UTM tags
    // and cannot be matched to CRM leads — including them only pollutes the table.
    const normCampaign = normalize(campaignInfo.name);
    const normAdset   = normalize(adsetInfo.name);
    const normAd      = normalize(c.ad_name);
    const namesSet = new Set([normCampaign, normAdset, normAd]);
    if (namesSet.size < 2) {
      skippedPromo++;
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
      // NOTE: creative_stats does not include `reach`; this column will always be 0
      // until the FB sync service is updated to store reach at the ad level.
      reach: 0,
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
    // If duplicate key (same ad appears in multiple batches — merge metrics)
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

  console.log(
    `[CrossBuilder] Built ${rowMap.size} cross rows, ` +
    `skipped ${skippedNoHierarchy} (no hierarchy), ${skippedPromo} (promo/boost)`
  );

  // ── 5. Load matched CRM leads and attribute to cross rows ──────────────────
  //
  // Some CRMs (Bitrix24 sync_type='both') create BOTH a Lead (form submission
  // with UTM) AND a Deal (sales pipeline entry) for the same contact. Both get
  // matched by the UTM matcher → double-counting leads_crm.
  //
  // Resolution rule (no config needed):
  //   • If ANY matched non-dup Lead exists → count ONLY Leads.
  //     Rationale: Leads are the raw form submission — the correct unit for
  //     "how many people clicked the ad and filled the form".
  //   • If NO matched Leads exist but Deals do → count Deals.
  //     Rationale: client uses Deals as their primary lead entity (AMO, etc.)
  //
  // This avoids 2× inflation without requiring per-client configuration.

  // Determine which record_type(s) to count based on the client's CRM sync_config.
  //
  // sync_config reflects what the user explicitly chose to sync in the UI:
  //   • include_leads=false, deal_category_ids=[...] → only deals
  //   • include_leads=true,  deal_category_ids=[]    → only leads
  //   • include_leads=true,  deal_category_ids=[...] → both (is_duplicate handles dedup)
  //   • no sync_config (legacy sync_type)            → fallback to range-count heuristic
  //
  const { data: crmConns } = await supabase
    .from('crm_connections')
    .select('sync_config, sync_type')
    .eq('client_id', clientId)
    .eq('is_active', true);

  let recordTypeFilter: 'lead' | 'deal' | null = null; // null = no filter (count both)

  if (crmConns && crmConns.length > 0) {
    // Pick the first active connection that has explicit sync_config
    const connWithConfig = crmConns.find((c: any) => c.sync_config != null);
    if (connWithConfig?.sync_config) {
      const cfg = connWithConfig.sync_config as { include_leads: boolean; deal_category_ids: number[] };
      if (!cfg.include_leads && cfg.deal_category_ids.length > 0) {
        recordTypeFilter = 'deal';
      } else if (cfg.include_leads && cfg.deal_category_ids.length === 0) {
        recordTypeFilter = 'lead';
      }
      // else: both selected → no filter, is_duplicate handles dedup
    } else {
      // Legacy sync_type fallback
      const syncType = crmConns[0].sync_type as string | null;
      if (syncType === 'leads') recordTypeFilter = 'lead';
      else if (syncType === 'deals') recordTypeFilter = 'deal';
      // 'both' → no filter
    }
  }

  console.log(`[CrossBuilder] record_type filter: ${recordTypeFilter ?? 'none (both)'}`);

  const leads = await paginatedSelect(
    'crm_leads',
    clientId,
    'id, matched_campaign_id, matched_adset_id, matched_ad_id, created_at_crm, price, status, is_duplicate',
    (q) => {
      let q2 = q.not('matched_campaign_id', 'is', null).eq('is_duplicate', false);
      if (recordTypeFilter) q2 = q2.eq('record_type', recordTypeFilter);
      return q2;
    },
  );

  console.log(`[CrossBuilder] Loaded ${leads.length} matched non-duplicate CRM records`);

  let leadsAttributed = 0;
  let leadsUnattributed = 0;

  for (const lead of leads) {
    const campaignName = lead.matched_campaign_id as string;
    const adsetName = lead.matched_adset_id as string;
    const adName = lead.matched_ad_id as string;

    // Extract date from created_at_crm in the client's local timezone (UTC+5, Kazakhstan/KZT).
    // Bitrix24 portal is configured for UTC+5; DATE_CREATE is returned with that offset
    // (e.g. "2026-03-09T01:00:00+05:00") and we store it as UTC ("2026-03-08T20:00:00Z").
    // We shift +5h before taking the date so the day matches what Bitrix shows locally,
    // and also matches the FB ad account dates (also set to Almaty/UTC+5).
    const createdDate = lead.created_at_crm
      ? new Date(new Date(lead.created_at_crm).getTime() + 5 * 60 * 60 * 1000)
          .toISOString()
          .substring(0, 10)
      : null;

    if (!createdDate || !campaignName) {
      leadsUnattributed++;
      continue;
    }

    // Try exact match by name + date
    const key = makeKey(campaignName, adsetName || '', adName || '', createdDate);
    let target = rowMap.get(key);

    // If no exact date match, create a zero-spend attribution row —
    // but only if the lead date falls within the current build range.
    if (!target && adsetName && adName && createdDate >= dateFrom && createdDate <= dateTo) {
      // Find any existing row for this ad triple to use as template
      let templateRow: CrossRow | undefined;
      for (const [, r] of rowMap) {
        if (
          r.campaign_name === campaignName &&
          r.adset_name === adsetName &&
          r.ad_name === adName
        ) {
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
      // TODO: qualified_leads and sales_count based on client stage config
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
  console.log(
    `[CrossBuilder] Done: ${rowsUpserted} rows upserted, ${upsertErrors} errors, ${leadsAttributed} leads attributed`
  );

  return { rowsUpserted, leadsAttributed };
}
