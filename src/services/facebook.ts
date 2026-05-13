import axios from 'axios';
import { supabase } from '../lib/supabase';
import { AdAccount, CampaignStat, AdsetStat, CreativeStat } from '../types/database';

const FB_API_VERSION = 'v19.0';
const FB_BASE_URL = `https://graph.facebook.com/${FB_API_VERSION}`;

interface FbCampaign {
  id: string;
  name: string;
  status: string;
  effective_status: string;
  insights?: { data: FbInsight[] };
}

interface FbAdset {
  id: string;
  name: string;
  campaign_id: string;
  campaign_name: string;
  status: string;
  effective_status: string;
  insights?: { data: FbInsight[] };
}

interface FbAd {
  id: string;
  name: string;
  adset_id: string;
  campaign_id: string;
  status: string;
  effective_status: string;
  creative?: { id: string; thumbnail_url?: string; image_url?: string; video_url?: string };
  insights?: { data: FbInsight[] };
}

interface FbInsight {
  date_start: string;
  date_stop: string;
  spend: string;
  impressions: string;
  clicks: string;
  reach: string;
  ctr: string;
  cpc: string;
  actions?: Array<{ action_type: string; value: string }>;
}

function extractLeads(actions?: FbInsight['actions']): number {
  if (!actions) return 0;
  const leadAction = actions.find(a =>
    a.action_type === 'lead' || a.action_type === 'onsite_conversion.lead_grouped'
  );
  return leadAction ? parseInt(leadAction.value, 10) : 0;
}

async function fetchWithToken(url: string, params: Record<string, string>) {
  const response = await axios.get(url, { params });
  return response.data;
}

/** Fetch all pages from a Graph API list endpoint via paging.next cursor. */
async function fetchAllPages(url: string, params: Record<string, string>): Promise<any[]> {
  const all: any[] = [];
  let nextUrl: string | null = url;
  let nextParams: Record<string, string> | null = params;

  while (nextUrl) {
    const resp: any = await axios.get(nextUrl, nextParams ? { params: nextParams } : undefined);
    const data = resp.data;
    if (Array.isArray(data?.data)) all.push(...data.data);
    nextUrl = data?.paging?.next || null;
    nextParams = null; // paging.next URL already contains all params
  }

  return all;
}

export async function syncFacebookAccount(
  account: AdAccount,
  dateRange: { since: string; until: string },
  onProgress?: (step: string, progress: number) => void,
) {
  const progress = onProgress || (() => {});
  console.log(`[FB] Syncing account ${account.account_id} (${account.account_name})`);

  const insightFields = 'spend,impressions,clicks,reach,ctr,cpc,actions';
  const timeRange = JSON.stringify({ since: dateRange.since, until: dateRange.until });
  const actId = `act_${account.account_id}`;

  // time_increment=1 → daily breakdown (one row per day per ad/adset/campaign).
  // Without this FB returns a single aggregated row for the entire period, which
  // breaks cross_analytics date filtering and makes all spend appear as 0.
  const timeRangeJson = JSON.stringify(dateRange);

  progress('Подключение к Facebook Ads...', 5);

  try {
    // ── 1. Campaigns ──────────────────────────────────────────────────────────
    progress('Загрузка кампаний...', 15);
    // Each entity in the Ads hierarchy has its own valid effective_status values.
    // We must enumerate the non-DELETED ones explicitly per entity type — FB
    // defaults to ACTIVE+PAUSED only when no filter is passed, and rejects
    // DELETED queries on list endpoints (400 "deleted objects not supported").
    //
    // Without these explicit lists we silently drop:
    //   • adsets in CAMPAIGN_PAUSED (campaign paused after run)
    //   • ads in ADSET_PAUSED / CAMPAIGN_PAUSED (adset or campaign paused)
    //   • anything stuck in IN_PROCESS / WITH_ISSUES / review-pipeline states.
    // Campaigns can only be ACTIVE/PAUSED/ARCHIVED — review/billing statuses
    // are only valid for ads, not campaigns (FB returns 400 if passed here).
    const campaignStatuses = JSON.stringify(['ACTIVE', 'PAUSED', 'ARCHIVED']);
    // Adsets also inherit CAMPAIGN_PAUSED when their parent campaign is paused.
    // Without it we silently drop adsets that ran while campaign was paused.
    const adsetStatuses = JSON.stringify(['ACTIVE', 'PAUSED', 'ARCHIVED', 'CAMPAIGN_PAUSED']);
    const adStatuses = JSON.stringify([
      'ACTIVE', 'PAUSED', 'ARCHIVED',
      'ADSET_PAUSED', 'CAMPAIGN_PAUSED',
      'IN_PROCESS', 'WITH_ISSUES',
      'PENDING_REVIEW', 'DISAPPROVED', 'PREAPPROVED', 'PENDING_BILLING_INFO',
    ]);

    const campaigns: FbCampaign[] = (await fetchAllPages(`${FB_BASE_URL}/${actId}/campaigns`, {
      access_token: account.access_token,
      fields: `id,name,status,effective_status,insights.time_range(${timeRangeJson}).time_increment(1){${insightFields},date_start}`,
      effective_status: campaignStatuses,
      limit: '200',
    })) as FbCampaign[];

    const campaignStats: CampaignStat[] = [];

    for (const campaign of campaigns) {
      const insights: FbInsight[] = campaign.insights?.data || [];
      // If no insights in range, store a single zero-row at dateRange.until so
      // UTM matcher can still build the (campaign, adset, ad) triple.
      const rows = insights.length > 0 ? insights : [{ date_start: dateRange.until, spend: '0', impressions: '0', clicks: '0', reach: '0', ctr: '0', cpc: '0', actions: [] }];
      for (const insight of rows) {
        const leads = extractLeads(insight.actions);
        const spend = parseFloat(insight.spend);
        campaignStats.push({
          id: '',
          ad_account_id: account.id,
          client_id: account.client_id,
          platform: 'facebook',
          date: insight.date_start,
          campaign_id: campaign.id,
          campaign_name: campaign.name,
          status: campaign.effective_status,
          spend,
          impressions: parseInt(insight.impressions, 10),
          clicks: parseInt(insight.clicks, 10),
          reach: parseInt(insight.reach, 10),
          leads,
          ctr: parseFloat(insight.ctr) || 0,
          cpl: leads > 0 ? spend / leads : 0,
          cpc: parseFloat(insight.cpc) || 0,
          currency: 'USD',
          created_at: '',
        });
      }
    }

    // Upsert campaign stats
    if (campaignStats.length > 0) {
      const { error } = await supabase
        .from('campaign_stats')
        .upsert(
          campaignStats.map(({ id, created_at, ...rest }) => rest),
          { onConflict: 'ad_account_id,campaign_id,date' }
        );
      if (error) console.error('[FB] Campaign upsert error:', error.message);
      else console.log(`[FB] Upserted ${campaignStats.length} campaign stats`);
    }
    progress(`Сохранено ${campaignStats.length} записей кампаний`, 35);

    // ── 2. Ad Sets ────────────────────────────────────────────────────────────
    progress('Загрузка групп объявлений...', 45);
    const adsets: FbAdset[] = ((await fetchAllPages(`${FB_BASE_URL}/${actId}/adsets`, {
      access_token: account.access_token,
      fields: `id,name,campaign_id,campaign{name},status,effective_status,insights.time_range(${timeRangeJson}).time_increment(1){${insightFields},date_start}`,
      effective_status: adsetStatuses,
      limit: '500',
    })) as any[]).map((a) => ({ ...a, campaign_name: a.campaign?.name || '' }));

    const adsetStats: AdsetStat[] = [];
    for (const adset of adsets) {
      const insights: FbInsight[] = adset.insights?.data || [];
      const rows = insights.length > 0 ? insights : [{ date_start: dateRange.until, spend: '0', impressions: '0', clicks: '0', reach: '0', ctr: '0', cpc: '0', actions: [] }];
      for (const insight of rows) {
        const leads = extractLeads(insight.actions);
        const spend = parseFloat(insight.spend);
        adsetStats.push({
          id: '',
          ad_account_id: account.id,
          client_id: account.client_id,
          platform: 'facebook',
          date: insight.date_start,
          campaign_id: adset.campaign_id,
          campaign_name: adset.campaign_name,
          adset_id: adset.id,
          adset_name: adset.name,
          status: adset.effective_status,
          spend,
          impressions: parseInt(insight.impressions, 10),
          clicks: parseInt(insight.clicks, 10),
          reach: parseInt(insight.reach, 10),
          leads,
          ctr: parseFloat(insight.ctr) || 0,
          cpl: leads > 0 ? spend / leads : 0,
          cpc: parseFloat(insight.cpc) || 0,
          currency: 'USD',
          created_at: '',
        });
      }
    }

    if (adsetStats.length > 0) {
      const { error } = await supabase
        .from('adset_stats')
        .upsert(
          adsetStats.map(({ id, created_at, ...rest }) => rest),
          { onConflict: 'ad_account_id,adset_id,date' }
        );
      if (error) console.error('[FB] Adset upsert error:', error.message);
      else console.log(`[FB] Upserted ${adsetStats.length} adset stats`);
    }
    progress(`Сохранено ${adsetStats.length} групп объявлений`, 65);

    // ── 3. Ads (Creatives) ────────────────────────────────────────────────────
    // Account-level /ads is unreliable on Standard Access apps — large lists
    // get truncated and ads can return with adset_ids that aren't in /adsets.
    // Iterate per-adset: /{adset_id}/ads returns a small focused list that
    // Facebook serves reliably even under tight rate limits.
    progress('Загрузка объявлений...', 72);
    const ads: any[] = [];
    let adsetIndex = 0;
    for (const adset of adsets) {
      adsetIndex++;
      if (adsetIndex % 10 === 0) {
        progress(`Загрузка объявлений ${adsetIndex}/${adsets.length}...`, Math.min(72 + Math.round((adsetIndex / adsets.length) * 16), 88));
      }
      try {
        const adsForAdset = await fetchAllPages(`${FB_BASE_URL}/${adset.id}/ads`, {
          access_token: account.access_token,
          fields: `id,name,adset_id,campaign_id,status,effective_status,creative{thumbnail_url,image_url},insights.time_range(${timeRangeJson}).time_increment(1){${insightFields},date_start}`,
          effective_status: adStatuses,
          limit: '100',
        });
        ads.push(...adsForAdset);
      } catch (err: any) {
        // 17 = User request limit reached; 4 = App throttling. Pause briefly and retry once.
        const fbCode = err?.response?.data?.error?.code;
        if (fbCode === 17 || fbCode === 4) {
          await new Promise(r => setTimeout(r, 2000));
          try {
            const retry = await fetchAllPages(`${FB_BASE_URL}/${adset.id}/ads`, {
              access_token: account.access_token,
              fields: `id,name,adset_id,campaign_id,status,effective_status,creative{thumbnail_url,image_url},insights.time_range(${timeRangeJson}).time_increment(1){${insightFields},date_start}`,
              effective_status: adStatuses,
              limit: '100',
            });
            ads.push(...retry);
            continue;
          } catch {}
        }
        console.warn(`[FB] Failed to load ads for adset ${adset.id} (${adset.name}):`, err?.response?.data?.error?.message || err.message);
      }
    }
    console.log(`[FB] Loaded ${ads.length} ads across ${adsets.length} adsets`);

    const creativeStats: CreativeStat[] = [];

    for (const ad of ads) {
      const insights: FbInsight[] = ad.insights?.data || [];
      const rows = insights.length > 0 ? insights : [{ date_start: dateRange.until, spend: '0', impressions: '0', clicks: '0', reach: '0', ctr: '0', cpc: '0', actions: [] }];
      for (const insight of rows) {
        const leads = extractLeads(insight.actions);
        const spend = parseFloat(insight.spend);
        creativeStats.push({
          id: '',
          ad_account_id: account.id,
          client_id: account.client_id,
          platform: 'facebook',
          date: insight.date_start,
          ad_id: ad.id,
          ad_name: ad.name,
          adset_id: ad.adset_id,
          campaign_id: ad.campaign_id,
          status: ad.effective_status,
          spend,
          impressions: parseInt(insight.impressions, 10),
          clicks: parseInt(insight.clicks, 10),
          leads,
          ctr: parseFloat(insight.ctr) || 0,
          cpl: leads > 0 ? spend / leads : 0,
          image_url: ad.creative?.image_url,
          thumbnail_url: ad.creative?.thumbnail_url,
          video_url: ad.creative?.video_url,
          currency: 'USD',
          created_at: '',
        });
      }
    }

    if (creativeStats.length > 0) {
      const { error } = await supabase
        .from('creative_stats')
        .upsert(
          creativeStats.map(({ id, created_at, ...rest }) => rest),
          { onConflict: 'ad_account_id,ad_id,date' }
        );
      if (error) console.error('[FB] Creative upsert error:', error.message);
      else console.log(`[FB] Upserted ${creativeStats.length} creative stats`);
    }
    progress(`Сохранено ${creativeStats.length} объявлений`, 90);

    // Update last_synced_at
    progress('Завершение...', 98);
    await supabase
      .from('ad_accounts')
      .update({ last_synced_at: new Date().toISOString() })
      .eq('id', account.id);

    return {
      campaigns: campaignStats.length,
      adsets: adsetStats.length,
      creatives: creativeStats.length,
    };
  } catch (err: any) {
    console.error('[FB] Sync error:', err.response?.data || err.message);
    throw err;
  }
}
