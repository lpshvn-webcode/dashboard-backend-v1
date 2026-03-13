import { supabase } from '../lib/supabase';
import { syncFacebookAccount } from './facebook';
import { syncGoogleAdsAccount } from './google-ads';
import { syncAmoCRM } from './amocrm';
import { syncBitrix24 } from './bitrix24';
import { matchUtmForClient } from './utm-matcher';
import { buildCrossAnalytics } from './cross-analytics-builder';
import { AdAccount, CrmConnection } from '../types/database';

// Default: sync last 90 days on first sync, last 5 days on incremental.
// Pass daysBack to override (e.g. 5 for nightly cron, 90 for manual button).
function getDateRange(lastSynced?: string | null, daysBack?: number): { since: string; until: string } {
  const until = new Date();
  const since = new Date();

  if (daysBack !== undefined) {
    // Explicit override
    since.setDate(since.getDate() - daysBack);
  } else if (lastSynced) {
    // Incremental: go back 5 days to catch delayed/corrected data
    since.setDate(since.getDate() - 5);
  } else {
    // Initial sync (account never synced before): last 90 days
    since.setDate(since.getDate() - 90);
  }

  return {
    since: since.toISOString().split('T')[0],
    until: until.toISOString().split('T')[0],
  };
}

async function logSync(
  clientId: string,
  type: string,
  status: 'success' | 'error',
  recordsSynced: number,
  startedAt: Date,
  errorMessage?: string
) {
  await supabase.from('sync_logs').insert({
    client_id: clientId,
    type,
    status,
    records_synced: recordsSynced,
    error_message: errorMessage,
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
  });
}

/**
 * Sync all (or a single client's) ad accounts.
 * @param clientId   – if provided, only sync accounts for this client
 * @param daysBack   – override how many days back to sync (default: 5 incremental / 90 initial)
 */
export async function syncAllAdsAccounts(clientId?: string, daysBack?: number) {
  const query = supabase
    .from('ad_accounts')
    .select('*')
    .eq('is_active', true);

  if (clientId) query.eq('client_id', clientId);

  const { data: accounts, error } = await query;
  if (error || !accounts) {
    console.error('[Sync] Failed to load ad accounts:', error?.message);
    return;
  }

  console.log(`[Sync] Processing ${accounts.length} ad accounts (daysBack=${daysBack ?? 'auto'})`);

  for (const account of accounts as AdAccount[]) {
    const startedAt = new Date();
    const dateRange = getDateRange(account.last_synced_at, daysBack);
    let totalRecords = 0;

    try {
      if (account.platform === 'facebook') {
        const result = await syncFacebookAccount(account, dateRange);
        totalRecords = result.campaigns + result.adsets + result.creatives;
      } else if (account.platform === 'google') {
        const result = await syncGoogleAdsAccount(account, dateRange);
        totalRecords = result.campaigns + result.adsets + result.creatives;
      }
      // TikTok: future

      await logSync(account.client_id, account.platform, 'success', totalRecords, startedAt);

      // Rebuild cross-analytics after ad data sync
      try {
        await buildCrossAnalytics(account.client_id, { dateFrom: dateRange.since, dateTo: dateRange.until });
      } catch (err: any) {
        console.error(`[Sync] Cross-analytics build failed for ${account.client_id}:`, err.message);
      }
    } catch (err: any) {
      console.error(`[Sync] Failed for account ${account.id}:`, err.message);
      await logSync(account.client_id, account.platform, 'error', 0, startedAt, err.message);
    }
  }
}

/** Sync a single CRM connection and log the result. Called by manual sync endpoint. */
export async function syncSingleCrmConnection(connection: CrmConnection) {
  const startedAt = new Date();
  const since = connection.last_synced_at
    ? new Date(new Date(connection.last_synced_at).getTime() - 2 * 24 * 60 * 60 * 1000) // 2 days back
    : undefined;

  let totalRecords = 0;
  let result: any = {};

  if (connection.type === 'amocrm') {
    result = await syncAmoCRM(connection, since);
    totalRecords = result.leads;
  } else if (connection.type === 'bitrix24') {
    result = await syncBitrix24(connection, since);
    totalRecords = (result.leads || 0) + (result.deals || 0);
  }

  await logSync(connection.client_id, connection.type, 'success', totalRecords, startedAt);

  // UTM-матчинг после синхронизации CRM
  try {
    await matchUtmForClient(connection.client_id);
  } catch (err: any) {
    console.error('[Sync] UTM matching failed:', err.message);
  }

  // Rebuild cross-analytics after CRM sync + UTM matching
  try {
    await buildCrossAnalytics(connection.client_id);
  } catch (err: any) {
    console.error('[Sync] Cross-analytics build failed:', err.message);
  }

  return result;
}

export async function syncAllCrmConnections(clientId?: string) {
  const query = supabase
    .from('crm_connections')
    .select('*')
    .eq('is_active', true);

  if (clientId) query.eq('client_id', clientId);

  const { data: connections, error } = await query;
  if (error || !connections) {
    console.error('[Sync] Failed to load CRM connections:', error?.message);
    return;
  }

  console.log(`[Sync] Processing ${connections.length} CRM connections`);

  for (const connection of connections as CrmConnection[]) {
    const startedAt = new Date();
    try {
      const result = await syncSingleCrmConnection(connection);
      const totalRecords = (result.leads || 0) + (result.deals || 0);
      console.log(`[Sync] CRM ${connection.type} done: ${totalRecords} records`);
    } catch (err: any) {
      const since = connection.last_synced_at
        ? new Date(new Date(connection.last_synced_at).getTime() - 2 * 24 * 60 * 60 * 1000)
        : undefined;
      console.error(`[Sync] CRM sync failed for ${connection.id}:`, err.message);
      await logSync(connection.client_id, connection.type, 'error', 0, startedAt, err.message);
    }
  }
}
