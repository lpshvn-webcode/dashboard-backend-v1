import { supabase } from '../lib/supabase';
import { syncFacebookAccount } from './facebook';
import { syncGoogleAdsAccount } from './google-ads';
import { syncAmoCRM } from './amocrm';
import { syncBitrix24 } from './bitrix24';
import { AdAccount, CrmConnection } from '../types/database';

// Default: sync last 30 days on first sync, last 2 days on incremental
function getDateRange(lastSynced?: string | null): { since: string; until: string } {
  const until = new Date();
  const since = new Date();

  if (lastSynced) {
    // Incremental: go back 2 days to catch any delayed data
    since.setDate(since.getDate() - 2);
  } else {
    // Initial sync: last 30 days
    since.setDate(since.getDate() - 30);
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

export async function syncAllAdsAccounts(clientId?: string) {
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

  console.log(`[Sync] Processing ${accounts.length} ad accounts`);

  for (const account of accounts as AdAccount[]) {
    const startedAt = new Date();
    const dateRange = getDateRange(account.last_synced_at);
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
