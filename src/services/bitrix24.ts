import axios from 'axios';
import he from 'he';
import { supabase } from '../lib/supabase';
import { CrmConnection, CrmLead, CrmSyncType } from '../types/database';
import { normalizePhone } from '../utils/phone';

/** Decode HTML entities from Bitrix24 response (e.g. "&mdash;" → "—") */
function decodeHtml(s: string): string;
function decodeHtml(s: string | undefined | null): string | undefined;
function decodeHtml(s: string | undefined | null): string | undefined {
  if (!s) return undefined;
  return he.decode(s);
}

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

/** Validate and normalize a Bitrix24 webhook URL */
function normalizeWebhookUrl(domain: string): string {
  let url = domain.trim();

  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }

  url = url.replace(/\/$/, '');

  try {
    const parsed = new URL(url);
    if (!parsed.hostname.includes('bitrix24') && !parsed.hostname.includes('b24')) {
      throw new Error('URL должен содержать bitrix24');
    }
    return url;
  } catch (e: any) {
    if (e.message.includes('bitrix24')) throw e;
    throw new Error('Некорректный формат webhook URL');
  }
}

/** Paginate through a Bitrix24 list method and return all items */
async function fetchAllPages<T>(
  baseUrl: string,
  method: string,
  authParams: Record<string, string>,
  selectFields: string[],
  filterParams: Record<string, string>,
  onPageProgress?: (message: string) => void,
): Promise<T[]> {
  const all: T[] = [];
  let start = 0;
  let retries = 0;
  const MAX_RETRIES = 3;

  while (true) {
    try {
      const res = await axios.get(`${baseUrl}/${method}`, {
        params: {
          ...authParams,
          SELECT: selectFields,
          FILTER: filterParams,
          start,
        },
        timeout: 30000,
      });

      const items: T[] = res.data.result || [];
      if (items.length === 0) break;
      all.push(...items);

      const total: number = res.data.total || 0;
      start += items.length;

      if (onPageProgress) {
        onPageProgress(`Загружено ${all.length} из ${total}`);
      }

      if (start >= total) break;
      retries = 0;
    } catch (error: any) {
      const status = error.response?.status;
      const bxError = error.response?.data?.error;
      const isRateLimit =
        status === 429 ||
        (status === 503 && bxError === 'QUERY_LIMIT_EXCEEDED');

      if (isRateLimit) {
        const waitTime = Math.min(1000 * Math.pow(2, retries), 16000);
        console.warn(`[Bitrix24] Rate limited on ${method} (${status}), waiting ${waitTime}ms`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        retries++;
        if (retries >= MAX_RETRIES) {
          throw new Error('Превышен лимит запросов к Bitrix24 API');
        }
        continue;
      }

      if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
        console.error(`[Bitrix24] Timeout on ${method}, retrying... (attempt ${retries + 1})`);
        retries++;
        if (retries >= MAX_RETRIES) {
          throw new Error('Превышено время ожидания ответа от Bitrix24');
        }
        continue;
      }

      console.error(`[Bitrix24] Error fetching ${method}:`, error.message);
      throw new Error(`Ошибка при запросе к Bitrix24: ${error.message}`);
    }
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

  // Bitrix24 rate-limit: 2 req/s per user → batch by 50, delay between batches
  const BATCH_SIZE = 50;
  const BATCH_DELAY_MS = 600; // ~1.6 req/s — safe margin under the 2 req/s limit
  const MAX_RETRIES = 5;

  for (let i = 0; i < contactIds.length; i += BATCH_SIZE) {
    const batch = contactIds.slice(i, i + BATCH_SIZE);
    let retries = 0;

    while (true) {
      try {
        const res = await axios.get(`${baseUrl}/crm.contact.list`, {
          params: {
            ...authParams,
            SELECT: ['ID', 'PHONE'],
            FILTER: { ID: batch },
          },
          timeout: 30000,
        });

        for (const contact of res.data.result || []) {
          const phoneValue = contact.PHONE?.[0]?.VALUE;
          if (phoneValue) {
            phoneMap[contact.ID] = normalizePhone(phoneValue) as string;
          }
        }
        break; // success — exit retry loop
      } catch (err: any) {
        const status = err.response?.status;
        const bxError = err.response?.data?.error;
        const isRateLimit =
          status === 429 ||
          (status === 503 && bxError === 'QUERY_LIMIT_EXCEEDED');

        if (isRateLimit && retries < MAX_RETRIES) {
          const waitMs = Math.min(1000 * Math.pow(2, retries), 16000);
          console.warn(`[Bitrix24] Rate limit on crm.contact.list (attempt ${retries + 1}), waiting ${waitMs}ms`);
          await new Promise(resolve => setTimeout(resolve, waitMs));
          retries++;
          continue;
        }

        // Non-retriable error — log and skip this batch, don't crash entire sync
        console.error(`[Bitrix24] fetchContactPhones error (batch ${i}–${i + batch.length}):`, err.message);
        break;
      }
    }

    // Throttle between batches to avoid hitting Bitrix24 rate limits
    if (i + BATCH_SIZE < contactIds.length) {
      await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
    }
  }

  return phoneMap;
}

// ── Main sync function ─────────────────────────────────────────────────────────

export async function syncBitrix24(
  connection: CrmConnection,
  since?: Date,
  onProgress?: (step: string, progress: number) => void,
) {
  const progress = onProgress || (() => {});
  console.log(`[Bitrix24] Syncing ${connection.domain}`);

  const syncType: CrmSyncType = connection.sync_type || 'leads';

  // Webhook mode: access_token is empty, domain is the full webhook path
  // e.g. "b24-xxx.bitrix24.ru/rest/1/xxxxxx/"
  // OAuth mode: access_token is set, domain is just the hostname
  const isWebhook = !connection.access_token;

  progress('Подключение к Bitrix24...', 5);

  let accessToken = connection.access_token;
  if (!isWebhook && connection.token_expires_at && new Date(connection.token_expires_at) < new Date(Date.now() + 5 * 60 * 1000)) {
    accessToken = await refreshBitrixToken(connection);
  }

  // Webhook: baseUrl = full webhook URL (already contains auth path)
  // OAuth:   baseUrl = https://domain/rest  (auth via query param)
  const rawBaseUrl = isWebhook
    ? connection.domain
    : `${connection.domain}/rest`;

  let baseUrl: string;
  try {
    baseUrl = normalizeWebhookUrl(rawBaseUrl);
  } catch {
    baseUrl = isWebhook
      ? `https://${connection.domain.replace(/\/$/, '')}`
      : `https://${connection.domain}/rest`;
  }

  const authParams: Record<string, string> = isWebhook ? {} : { auth: accessToken as string };

  const filterParams: Record<string, string> = {};
  if (since) {
    filterParams['>=DATE_CREATE'] = since.toISOString();
  }

  const records: CrmLead[] = [];

  // ── Sync Leads ──────────────────────────────────────────────────────────────
  if (syncType === 'leads' || syncType === 'both') {
    console.log(`[Bitrix24] Fetching leads...`);
    progress('Выгрузка лидов...', 20);

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
      (msg) => progress(msg, 25),
    );

    for (const item of rawLeads) {
      const phone = item.PHONE?.[0]?.VALUE ? normalizePhone(item.PHONE[0].VALUE) : undefined;
      records.push({
        id: '',
        crm_connection_id: connection.id,
        client_id: connection.client_id,
        crm_type: 'bitrix24',
        lead_id: `L_${item.ID}`,          // prefix to avoid ID collision with deals
        lead_name: decodeHtml(item.TITLE),
        status: item.STATUS_ID,
        responsible_name: item.ASSIGNED_BY_NAME,
        created_at_crm: new Date(item.DATE_CREATE).toISOString(),
        closed_at: item.DATE_CLOSED ? new Date(item.DATE_CLOSED).toISOString() : undefined,
        price: item.OPPORTUNITY ? parseFloat(item.OPPORTUNITY) : undefined,
        currency: item.CURRENCY_ID,
        phone,
        record_type: 'lead',
        is_duplicate: false,
        utm_source: decodeHtml(item.UTM_SOURCE),
        utm_medium: decodeHtml(item.UTM_MEDIUM),
        utm_campaign: decodeHtml(item.UTM_CAMPAIGN),
        utm_content: decodeHtml(item.UTM_CONTENT),
        utm_term: decodeHtml(item.UTM_TERM),
        created_at: '',
      });
    }

    console.log(`[Bitrix24] Fetched ${rawLeads.length} leads`);
    progress(`Обработано ${rawLeads.length} лидов`, 40);
  }

  // ── Sync Deals ──────────────────────────────────────────────────────────────
  if (syncType === 'deals' || syncType === 'both') {
    console.log(`[Bitrix24] Fetching deals...`);
    progress('Выгрузка сделок...', 60);

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
      (msg) => progress(msg, 65),
    );

    progress(`Обработано ${rawDeals.length} сделок`, 70);

    // Batch-fetch contact phones for all deals
    const uniqueContactIds = [...new Set(rawDeals.map(d => d.CONTACT_ID).filter(Boolean) as string[])];
    const contactPhones = await fetchContactPhones(baseUrl, authParams, uniqueContactIds);

    console.log(`[Bitrix24] Fetched ${rawDeals.length} deals, resolved ${Object.keys(contactPhones).length} contact phones`);
    progress(`Загружено ${Object.keys(contactPhones).length} телефонов`, 75);

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
        lead_name: decodeHtml(item.TITLE),
        status: item.STAGE_ID,
        responsible_name: item.ASSIGNED_BY_NAME,
        created_at_crm: new Date(item.DATE_CREATE).toISOString(),
        closed_at: item.CLOSEDATE ? new Date(item.CLOSEDATE).toISOString() : undefined,
        price: item.OPPORTUNITY ? parseFloat(item.OPPORTUNITY) : undefined,
        currency: item.CURRENCY_ID,
        phone,
        record_type: 'deal',
        is_duplicate: false,
        utm_source: decodeHtml(item.UTM_SOURCE),
        utm_medium: decodeHtml(item.UTM_MEDIUM),
        utm_campaign: decodeHtml(item.UTM_CAMPAIGN),
        utm_content: decodeHtml(item.UTM_CONTENT),
        utm_term: decodeHtml(item.UTM_TERM),
        created_at: '',
      });
    }
  }

  // ── Upsert records ──────────────────────────────────────────────────────────
  progress('Сохранение в базу данных...', 85);
  if (records.length > 0) {
    const { error } = await supabase
      .from('crm_leads')
      .upsert(
        records.map(({ id, created_at, ...rest }) => rest),
        { onConflict: 'crm_connection_id,lead_id' },
      );
    if (error) {
      console.error('[Bitrix24] Upsert error:', error.message);
    } else {
      console.log(`[Bitrix24] Upserted ${records.length} records`);
      progress(`Сохранено ${records.length} записей`, 90);
    }
  }

  // ── Deduplicate by phone (only when syncing both leads and deals) ─────────
  let duplicatesMarked = 0;
  if (syncType === 'both') {
    console.log(`[Bitrix24] Deduplicating by phone...`);
    progress('Очищение дублей...', 95);

    // Get all phones that exist in deals for this connection
    const { data: dealRows } = await supabase
      .from('crm_leads')
      .select('phone')
      .eq('crm_connection_id', connection.id)
      .eq('record_type', 'deal')
      .not('phone', 'is', null);

    const dealPhones = [...new Set(
      ((dealRows || []) as Array<{ phone: string }>)
        .map(r => r.phone)
        .filter((p): p is string => Boolean(p)),
    )];

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
        progress(`Помечено ${duplicatesMarked} дублей`, 98);
      }
    }

    // Also reset is_duplicate on leads where phone is NOT in deals
    // (in case a deal was deleted since last sync)
    const { error: resetError } = await supabase
      .from('crm_leads')
      .update({ is_duplicate: false })
      .eq('crm_connection_id', connection.id)
      .eq('record_type', 'lead')
      .not('phone', 'in', `(${dealPhones.map((p: string) => `'${p}'`).join(',') || "'__none__'"})`);

    if (resetError) console.error('[Bitrix24] Dedup reset error:', resetError.message);
  }

  // ── Update last_synced_at ────────────────────────────────────────────────
  progress('Завершение...', 100);
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
