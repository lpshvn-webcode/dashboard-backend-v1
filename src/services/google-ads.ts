import axios from 'axios';
import { supabase } from '../lib/supabase';
import { AdAccount, CampaignStat, AdsetStat, CreativeStat } from '../types/database';

const GOOGLE_ADS_API_VERSION = 'v17';
const GOOGLE_ADS_BASE_URL = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}`;

// Google Ads uses OAuth2 - refresh token before sync
async function refreshGoogleToken(account: AdAccount): Promise<string> {
  if (!account.refresh_token) throw new Error('No refresh token for Google account');

  const response = await axios.post('https://oauth2.googleapis.com/token', {
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: account.refresh_token,
    grant_type: 'refresh_token',
  });

  const { access_token, expires_in } = response.data;
  const expiresAt = new Date(Date.now() + expires_in * 1000).toISOString();

  await supabase
    .from('ad_accounts')
    .update({ access_token, token_expires_at: expiresAt })
    .eq('id', account.id);

  return access_token;
}

function buildGAQLQuery(resource: string, fields: string[], dateRange: { since: string; until: string }) {
  return `SELECT ${fields.join(', ')} FROM ${resource} WHERE segments.date BETWEEN '${dateRange.since}' AND '${dateRange.until}' AND campaign.status != 'REMOVED'`;
}

export async function syncGoogleAdsAccount(account: AdAccount, dateRange: { since: string; until: string }) {
  console.log(`[Google] Syncing account ${account.account_id} (${account.account_name})`);

  let accessToken = account.access_token;
  // Refresh if token is expired or close to expiry
  if (account.token_expires_at && new Date(account.token_expires_at) < new Date(Date.now() + 5 * 60 * 1000)) {
    accessToken = await refreshGoogleToken(account);
  }

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'developer-token': process.env.GOOGLE_ADS_DEVELOPER_TOKEN!,
    'login-customer-id': process.env.GOOGLE_ADS_MANAGER_ID || '',
  };

  const customerId = account.account_id.replace(/-/g, '');

  try {
    // ── 1. Campaigns ──────────────────────────────────────────────────────────
    const campaignQuery = buildGAQLQuery('campaign', [
      'campaign.id',
      'campaign.name',
      'campaign.status',
      'segments.date',
      'metrics.cost_micros',
      'metrics.impressions',
      'metrics.clicks',
      'metrics.conversions',
      'metrics.ctr',
      'metrics.cost_per_conversion',
      'metrics.average_cpc',
    ], dateRange);

    const campaignRes = await axios.post(
      `${GOOGLE_ADS_BASE_URL}/customers/${customerId}/googleAds:searchStream`,
      { query: campaignQuery },
      { headers }
    );

    const campaignStats: CampaignStat[] = [];
    for (const batch of campaignRes.data) {
      for (const row of batch.results || []) {
        const spend = (row.metrics.cost_micros || 0) / 1_000_000;
        const leads = Math.round(row.metrics.conversions || 0);
        campaignStats.push({
          id: '',
          ad_account_id: account.id,
          client_id: account.client_id,
          platform: 'google',
          date: row.segments.date,
          campaign_id: row.campaign.id.toString(),
          campaign_name: row.campaign.name,
          status: row.campaign.status,
          spend,
          impressions: row.metrics.impressions || 0,
          clicks: row.metrics.clicks || 0,
          reach: 0, // Google Ads doesn't expose reach at campaign level easily
          leads,
          ctr: (row.metrics.ctr || 0) * 100,
          cpl: leads > 0 ? spend / leads : 0,
          cpc: (row.metrics.average_cpc || 0) / 1_000_000,
          currency: 'KZT', // Will be fetched from account currency
          created_at: '',
        });
      }
    }

    if (campaignStats.length > 0) {
      const { error } = await supabase
        .from('campaign_stats')
        .upsert(
          campaignStats.map(({ id, created_at, ...rest }) => rest),
          { onConflict: 'ad_account_id,campaign_id,date' }
        );
      if (error) console.error('[Google] Campaign upsert error:', error.message);
      else console.log(`[Google] Upserted ${campaignStats.length} campaign stats`);
    }

    // ── 2. Ad Groups (AdSets equivalent) ──────────────────────────────────────
    const adGroupQuery = buildGAQLQuery('ad_group', [
      'ad_group.id',
      'ad_group.name',
      'ad_group.campaign_id',
      'ad_group.status',
      'campaign.name',
      'segments.date',
      'metrics.cost_micros',
      'metrics.impressions',
      'metrics.clicks',
      'metrics.conversions',
      'metrics.ctr',
      'metrics.average_cpc',
    ], dateRange);

    const adGroupRes = await axios.post(
      `${GOOGLE_ADS_BASE_URL}/customers/${customerId}/googleAds:searchStream`,
      { query: adGroupQuery },
      { headers }
    );

    const adsetStats: AdsetStat[] = [];
    for (const batch of adGroupRes.data) {
      for (const row of batch.results || []) {
        const spend = (row.metrics.cost_micros || 0) / 1_000_000;
        const leads = Math.round(row.metrics.conversions || 0);
        adsetStats.push({
          id: '',
          ad_account_id: account.id,
          client_id: account.client_id,
          platform: 'google',
          date: row.segments.date,
          campaign_id: row.ad_group.campaign_id.toString(),
          campaign_name: row.campaign.name,
          adset_id: row.ad_group.id.toString(),
          adset_name: row.ad_group.name,
          status: row.ad_group.status,
          spend,
          impressions: row.metrics.impressions || 0,
          clicks: row.metrics.clicks || 0,
          reach: 0,
          leads,
          ctr: (row.metrics.ctr || 0) * 100,
          cpl: leads > 0 ? spend / leads : 0,
          cpc: (row.metrics.average_cpc || 0) / 1_000_000,
          currency: 'KZT',
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
      if (error) console.error('[Google] AdGroup upsert error:', error.message);
      else console.log(`[Google] Upserted ${adsetStats.length} adgroup stats`);
    }

    // ── 3. Ads ─────────────────────────────────────────────────────────────────
    const adQuery = buildGAQLQuery('ad_group_ad', [
      'ad_group_ad.ad.id',
      'ad_group_ad.ad.name',
      'ad_group_ad.ad_group',
      'ad_group_ad.campaign',
      'ad_group_ad.status',
      'ad_group_ad.ad.responsive_display_ad.marketing_images',
      'segments.date',
      'metrics.cost_micros',
      'metrics.impressions',
      'metrics.clicks',
      'metrics.conversions',
      'metrics.ctr',
    ], dateRange);

    const adRes = await axios.post(
      `${GOOGLE_ADS_BASE_URL}/customers/${customerId}/googleAds:searchStream`,
      { query: adQuery },
      { headers }
    );

    const creativeStats: CreativeStat[] = [];
    for (const batch of adRes.data) {
      for (const row of batch.results || []) {
        const spend = (row.metrics.cost_micros || 0) / 1_000_000;
        const leads = Math.round(row.metrics.conversions || 0);
        creativeStats.push({
          id: '',
          ad_account_id: account.id,
          client_id: account.client_id,
          platform: 'google',
          date: row.segments.date,
          ad_id: row.ad_group_ad.ad.id.toString(),
          ad_name: row.ad_group_ad.ad.name || '',
          adset_id: row.ad_group_ad.ad_group.split('/').pop() || '',
          campaign_id: row.ad_group_ad.campaign.split('/').pop() || '',
          status: row.ad_group_ad.status,
          spend,
          impressions: row.metrics.impressions || 0,
          clicks: row.metrics.clicks || 0,
          leads,
          ctr: (row.metrics.ctr || 0) * 100,
          cpl: leads > 0 ? spend / leads : 0,
          currency: 'KZT',
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
      if (error) console.error('[Google] Creative upsert error:', error.message);
      else console.log(`[Google] Upserted ${creativeStats.length} ad stats`);
    }

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
    console.error('[Google] Sync error:', err.response?.data || err.message);
    throw err;
  }
}
