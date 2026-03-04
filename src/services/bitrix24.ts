import axios from 'axios';
import { supabase } from '../lib/supabase';
import { CrmConnection, CrmLead, CrmSyncType } from '../types/database';

async function refreshBitrixToken(connection: CrmConnection): Promise<string> {
  const response = await axios.get('https://oauth.bitrix.info/oauth/token/', {
    params: {
      grant_type: 'refresh_token',
      client_id: process.env.BITRIX24_CLIENT_ID,
      client_secret: process.env.BITRIX24_CLIENT_SECRET,
      refresh_token: connection.refresh_token,
    },
  });

  const { access_token, refresh_token, expires_in } = response.data;
  const expiresAt = new Date(Date.now() + expires_in * 1000).toISOString();

  await supabase
    .from('crm_connections')
    .update({ access_token, refresh_token, token_expires_at: expiresAt })
    .eq('id', connection.id);

  return access_token;
}

// ── Types ──────────────────────────────────────────────────────────────────────

interface BitrixLead {
  ID: string;
  TITLE: string;
  STATUS_ID: string;
  SOURCE_ID?: string;
  ASSIGNED_BY_NAME?: string;
  DATE_CREATE: string;
  DATE_CLOSED?: string;
  OPPORTUNITY?: string;
  CURRENCY_ID?: string;
  PHONE?: Array<{ VALUE: string; VALUE_TYPE: string }>;
  UTM_SOURCE?: string;
  UTM_MEDIUM?: string;
  UTM_CAMPAIGN?: string;
  UTM_CONTENT?: string;
  UTM_TERM?: string;
}

interface BitrixDeal {
  ID: string;
  TITLE: string;
  STAGE_ID: string;
  SOURCE_ID?: string;
  ASSIGNED_BY_NAME?: string;
  DATE_CREATE: string;
  CLOSEDATE?: string;
  OPPORTUNITY?: string;
  CURRENCY_ID?: string;
  CONTACT_ID?: string;
  UTM_SOURCE?: string;
  UTM_MEDIUM?: string;
  UTM_CAMPAIGN?: string;
  UTM_CONTENT?: string;
  UTM_TERM?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Paginate through a Bitrix24 list method and return all items */
async function fetchAllPages<T>(
  baseUrl: string,
  method: string,
  authParams: Record<string, string>,
  selectFields: string[],
  filterParams: Record<string, string>,
): Promise<T[]> {
  const all: T[] = [];
  let start = 0;

  while (true) {
    const res = await axios.get(`${baseUrl}/${method}`, {
      params: {
        ...authParams,
        SELECT: selectFields,
        FILTER: filterParams,
        start,
      },
    });

    const items: T[] = res.data.result || [];
    if (items.length === 0) break;
    all.push(...items);

    const total: number = res.data.total || 0;
    start += items.length;
    if (start >= total) break;
  }

  return all;
}

/** Batch-fetch contact phones from Bitrix24 by contact IDs */
async function fetchContactPhones(
  baseUrl: string,
  authParams: Record<string, string>,
  contactIds: string[],
): Promise<Record<string, string>> {
  const phoneMap: Record<string, string> = {};
  if (contactIds.length === 0) return phoneMap;

  // Bitrix24 list endpoints return max 50 per page; batch by 50
  for (let i = 0; i < contactIds.length; i += 50) {
    const batch = contactIds.slice(i, i + 50);
    const res = await axios.get(`${baseUrl}/crm.contact.list`, {
      params: {
        ...authParams,
        SELECT: ['ID', 'PHONE'],
        FILTER: { ID: batch },
      },
    });

    for (const contact of res.data.result || []) {
      const phone = contact.PHONE?.[0]?.VALUE;
      if (phone) phoneMap[contact.ID] = normalizePhone(phone);
    }
  }

  return phoneMap;
}

/** Strip everything except digits and leading '+' */
function normalizePhone(raw: string): string {
  return raw.replace(/[^\d+]/g, '');
}

// ── Main sync function ─────────────────────────────────────────────────────────

export async function syncBitrix24(connection: CrmConnection, since?: Date) {
  console.log(`[Bitrix24] Syncing ${connection.domain}`);

  const syncType: CrmSyncType = connection.sync_type || 'leads';

  // Webhook mode: access_token is empty, domain is the full webhook path
  // e.g. "b24-xxx.bitrix24.ru/rest/1/xxxxxx/"
  // OAuth mode: access_token is set, domain is just the hostname
  const isWebhook = !connection.access_token;

  let accessToken = connection.access_token;
  if (!isWebhook && connection.token_expires_at && new Date(connection.token_expires_at) < new Date(Date.now() + 5 * 60 * 1000)) {
    accessToken = await refreshBitrixToken(connection);
  }

  // Webhook: baseUrl = full webhook URL (already contains auth path)
  // OAuth:   baseUrl = https://domain/rest  (auth via query param)
  const baseUrl = isWebhook
    ? `https://${connection.domain.replace(/\/$/, '')}`
    : `https://${connection.domain}/rest`;
  const authParams = isWebhook ? {} : { auth: accessToken };

  const filterParams: Record<string, string> = {};
  if (since) {
    filterParams['>=DATE_CREATE'] = since.toISOString();
  }

  const records: CrmLead[] = [];

  // ── Sync Leads ──────────────────────────────────────────────────────────────
  if (syncType === 'leads' || syncType === 'both') {
    console.log(`[Bitrix24] Fetching leads...`);

    const rawLeads = await fetchAllPages<BitrixLead>(
      baseUrl,
      'crm.lead.list',
      authParams,
      [
        'ID', 'TITLE', 'STATUS_ID', 'SOURCE_ID',
        'ASSIGNED_BY_NAME', 'DATE_CREATE', 'DATE_CLOSED',
        'OPPORTUNITY', 'CURRENCY_ID', 'PHONE',
        'UTM_SOURCE', 'UTM_MEDIUM', 'UTM_CAMPAIGN', 'UTM_CONTENT', 'UTM_TERM',
      ],
      filterParams,
    );

    for (const item of rawLeads) {
      const phone = item.PHONE?.[0]?.VALUE ? normalizePhone(item.PHONE[0].VALUE) : undefined;
      records.push({
        id: '',
        crm_connection_id: connection.id,
        client_id: connection.client_id,
        crm_type: 'bitrix24',
        lead_id: `L_${item.ID}`,          // prefix to avoid ID collision with deals
        lead_name: item.TITLE,
        status: item.STATUS_ID,
        responsible_name: item.ASSIGNED_BY_NAME,
        created_at_crm: new Date(item.DATE_CREATE).toISOString(),
        closed_at: item.DATE_CLOSED ? new Date(item.DATE_CLOSED).toISOString() : undefined,
        price: item.OPPORTUNITY ? parseFloat(item.OPPORTUNITY) : undefined,
        currency: item.CURRENCY_ID,
        phone,
        record_type: 'lead',
        is_duplicate: false,
        utm_source: item.UTM_SOURCE,
        utm_medium: item.UTM_MEDIUM,
        utm_campaign: item.UTM_CAMPAIGN,
        utm_content: item.UTM_CONTENT,
        utm_term: item.UTM_TERM,
        created_at: '',
      });
    }

    console.log(`[Bitrix24] Fetched ${rawLeads.length} leads`);
  }

  // ── Sync Deals ──────────────────────────────────────────────────────────────
  if (syncType === 'deals' || syncType === 'both') {
    console.log(`[Bitrix24] Fetching deals...`);

    const rawDeals = await fetchAllPages<BitrixDeal>(
      baseUrl,
      'crm.deal.list',
      authParams,
      [
        'ID', 'TITLE', 'STAGE_ID', 'SOURCE_ID',
        'ASSIGNED_BY_NAME', 'DATE_CREATE', 'CLOSEDATE',
        'OPPORTUNITY', 'CURRENCY_ID', 'CONTACT_ID',
        'UTM_SOURCE', 'UTM_MEDIUM', 'UTM_CAMPAIGN', 'UTM_CONTENT', 'UTM_TERM',
      ],
      filterParams,
    );

    // Batch-fetch contact phones for all deals
    const uniqueContactIds = [...new Set(rawDeals.map(d => d.CONTACT_ID).filter(Boolean) as string[])];
    const contactPhones = await fetchContactPhones(baseUrl, authParams, uniqueContactIds);

    console.log(`[Bitrix24] Fetched ${rawDeals.length} deals, resolved ${Object.keys(contactPhones).length} contact phones`);

    for (const item of rawDeals) {
      const phone = item.CONTACT_ID && contactPhones[item.CONTACT_ID]
        ? contactPhones[item.CONTACT_ID]
        : undefined;

      records.push({
        id: '',
        crm_connection_id: connection.id,
        client_id: connection.client_id,
        crm_type: 'bitrix24',
        lead_id: `D_${item.ID}`,          // prefix to avoid ID collision with leads
        lead_name: item.TITLE,
        status: item.STAGE_ID,
        responsible_name: item.ASSIGNED_BY_NAME,
        created_at_crm: new Date(item.DATE_CREATE).toISOString(),
        closed_at: item.CLOSEDATE ? new Date(item.CLOSEDATE).toISOString() : undefined,
        price: item.OPPORTUNITY ? parseFloat(item.OPPORTUNITY) : undefined,
        currency: item.CURRENCY_ID,
        phone,
        record_type: 'deal',
        is_duplicate: false,
        utm_source: item.UTM_SOURCE,
        utm_medium: item.UTM_MEDIUM,
        utm_campaign: item.UTM_CAMPAIGN,
        utm_content: item.UTM_CONTENT,
        utm_term: item.UTM_TERM,
        created_at: '',
      });
    }
  }

  // ── Upsert records ──────────────────────────────────────────────────────────
  if (records.length > 0) {
    const { error } = await supabase
      .from('crm_leads')
      .upsert(
        records.map(({ id, created_at, ...rest }) => rest),
        { onConflict: 'crm_connection_id,lead_id' },
      );
    if (error) console.error('[Bitrix24] Upsert error:', error.message);
    else console.log(`[Bitrix24] Upserted ${records.length} records`);
  }

  // ── Deduplicate by phone (only when syncing both leads and deals) ─────────
  let duplicatesMarked = 0;
  if (syncType === 'both') {
    console.log(`[Bitrix24] Deduplicating by phone...`);

    // Get all phones that exist in deals for this connection
    const { data: dealRows } = await supabase
      .from('crm_leads')
      .select('phone')
      .eq('crm_connection_id', connection.id)
      .eq('record_type', 'deal')
      .not('phone', 'is', null);

    const dealPhones = [...new Set((dealRows || []).map(r => r.phone).filter(Boolean))];

    if (dealPhones.length > 0) {
      const { count, error } = await supabase
        .from('crm_leads')
        .update({ is_duplicate: true })
        .eq('crm_connection_id', connection.id)
        .eq('record_type', 'lead')
        .in('phone', dealPhones)
        .select('id', { count: 'exact', head: true });

      if (error) {
        console.error('[Bitrix24] Dedup error:', error.message);
      } else {
        duplicatesMarked = count || 0;
        console.log(`[Bitrix24] Marked ${duplicatesMarked} leads as duplicates`);
      }
    }

    // Also reset is_duplicate on leads where phone is NOT in deals
    // (in case a deal was deleted since last sync)
    const { error: resetError } = await supabase
      .from('crm_leads')
      .update({ is_duplicate: false })
      .eq('crm_connection_id', connection.id)
      .eq('record_type', 'lead')
      .not('phone', 'in', `(${dealPhones.map(p => `'${p}'`).join(',') || "'__none__'"})`);

    if (resetError) console.error('[Bitrix24] Dedup reset error:', resetError.message);
  }

  // ── Update last_synced_at ────────────────────────────────────────────────
  await supabase
    .from('crm_connections')
    .update({ last_synced_at: new Date().toISOString() })
    .eq('id', connection.id);

  const leadsCount = records.filter(r => r.record_type === 'lead').length;
  const dealsCount = records.filter(r => r.record_type === 'deal').length;

  return { leads: leadsCount, deals: dealsCount, duplicates: duplicatesMarked };
}

// ── Handle incoming webhook from Bitrix24 ─────────────────────────────────────
export function parseBitrixWebhook(body: any, connectionId: string, clientId: string): Partial<CrmLead> | null {
  // Bitrix24 sends event name in 'event' field
  const data = body.data?.FIELDS || body.FIELDS;
  if (!data?.ID) return null;

  return {
    crm_connection_id: connectionId,
    client_id: clientId,
    crm_type: 'bitrix24',
    lead_id: data.ID.toString(),
  };
}
