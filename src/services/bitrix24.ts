import axios from 'axios';
import he from 'he';
import { supabase } from '../lib/supabase';
import { CrmConnection, CrmLead, CrmSyncType, BitrixSyncConfig } from '../types/database';
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

// ── Fetch available CRM entities (leads entity + deal categories) ───────────────

export interface BitrixEntityList {
  leads: { id: 'leads'; name: string };
  deal_categories: Array<{ id: number; name: string }>;
}

export interface BitrixPipelineStage {
  id: string;      // Bitrix stage ID, e.g. "C9:WON", "NEW"
  name: string;
  semantics: string; // '' = normal, 'S' = won, 'F' = lost
}

export interface BitrixPipeline {
  id: string;        // 'deal_0', 'deal_9', 'leads'
  name: string;
  type: 'deal' | 'lead';
  stages: BitrixPipelineStage[];
}

export async function fetchBitrixEntities(connection: CrmConnection): Promise<BitrixEntityList> {
  const isWebhook = !connection.access_token;

  let accessToken = connection.access_token;
  if (!isWebhook && connection.token_expires_at && new Date(connection.token_expires_at) < new Date(Date.now() + 5 * 60 * 1000)) {
    accessToken = await refreshBitrixToken(connection);
  }

  const rawBaseUrl = isWebhook ? connection.domain : `${connection.domain}/rest`;
  let baseUrl: string;
  try {
    baseUrl = normalizeWebhookUrl(rawBaseUrl);
  } catch {
    baseUrl = isWebhook
      ? `https://${connection.domain.replace(/\/$/, '')}`
      : `https://${connection.domain}/rest`;
  }

  const authParams: Record<string, string> = isWebhook ? {} : { auth: accessToken as string };

  // Fetch default deal category (ID=0) — may return 404 in some Bitrix24 editions
  let defaultCategoryName = 'Основная воронка';
  try {
    const defaultCatRes = await axios.get(`${baseUrl}/crm.dealcategory.default.get`, {
      params: authParams,
      timeout: 10000,
    });
    const name = defaultCatRes.data?.result?.NAME;
    if (name) defaultCategoryName = decodeHtml(name) as string;
  } catch {
    // Method not available — use default name
  }
  const defaultCategory = { id: 0, name: defaultCategoryName };

  // Fetch all named deal categories
  let namedCats: Array<{ id: number; name: string }> = [];
  try {
    const namedCatsRes = await axios.get(`${baseUrl}/crm.dealcategory.list`, {
      params: authParams,
      timeout: 10000,
    });
    namedCats = (namedCatsRes.data?.result || []).map((c: any) => ({
      id: Number(c.ID),
      name: decodeHtml(c.NAME) as string || `Воронка ${c.ID}`,
    }));
  } catch {
    // Method not available — no additional pipelines
  }

  return {
    leads: { id: 'leads', name: 'Лиды' },
    deal_categories: [defaultCategory, ...namedCats],
  };
}

// ── Fetch stages for selected pipelines ────────────────────────────────────────

export async function fetchBitrixStages(connection: CrmConnection): Promise<{ pipelines: BitrixPipeline[] }> {
  const isWebhook = !connection.access_token;
  let accessToken = connection.access_token;
  if (!isWebhook && connection.token_expires_at && new Date(connection.token_expires_at) < new Date(Date.now() + 5 * 60 * 1000)) {
    accessToken = await refreshBitrixToken(connection);
  }
  const rawBaseUrl = isWebhook ? connection.domain : `${connection.domain}/rest`;
  let baseUrl: string;
  try { baseUrl = normalizeWebhookUrl(rawBaseUrl); } catch {
    baseUrl = isWebhook ? `https://${connection.domain.replace(/\/$/, '')}` : `https://${connection.domain}/rest`;
  }
  const authParams: Record<string, string> = isWebhook ? {} : { auth: accessToken as string };

  const cfg = connection.sync_config as BitrixSyncConfig | null;
  let categoryIds: number[] = cfg?.deal_category_ids ?? [];
  let includeLeads: boolean = cfg?.include_leads ?? false;

  // If no sync_config configured yet — fetch ALL available pipelines
  if (!cfg) {
    try {
      const entities = await fetchBitrixEntities(connection);
      categoryIds = entities.deal_categories.map(c => c.id);
      includeLeads = true;
    } catch (e) {
      console.warn('[Bitrix stages] Could not fetch entities for fallback:', (e as any)?.message);
      // Last resort: just fetch default pipeline
      categoryIds = [0];
      includeLeads = true;
    }
  }

  const pipelines: BitrixPipeline[] = [];

  for (const catId of categoryIds) {
    let stages: BitrixPipelineStage[] = [];
    let pipelineName = `Воронка ${catId}`;

    if (catId === 0) {
      const stagesRes = await axios.get(`${baseUrl}/crm.status.list`, {
        params: { ...authParams, filter: { ENTITY_ID: 'DEAL_STAGE' } }, timeout: 15000,
      });
      // crm.dealcategory.default.get may return 404 on some Bitrix24 editions
      try {
        const defCatRes = await axios.get(`${baseUrl}/crm.dealcategory.default.get`, { params: authParams, timeout: 15000 });
        pipelineName = decodeHtml(defCatRes.data?.result?.NAME) || 'Основная воронка';
      } catch {
        pipelineName = 'Основная воронка';
      }
      stages = (stagesRes.data?.result || []).map((s: any) => ({
        id: s.STATUS_ID as string,
        name: (decodeHtml(s.NAME) || s.STATUS_ID) as string,
        semantics: (s.SEMANTICS || '') as string,
      }));
    } else {
      const [stagesRes, catRes] = await Promise.all([
        axios.get(`${baseUrl}/crm.dealcategory.stages`, {
          params: { ...authParams, id: catId }, timeout: 15000,
        }),
        axios.get(`${baseUrl}/crm.dealcategory.get`, {
          params: { ...authParams, id: catId }, timeout: 15000,
        }),
      ]);
      pipelineName = decodeHtml(catRes.data?.result?.NAME) || `Воронка ${catId}`;
      stages = (stagesRes.data?.result || []).map((s: any) => ({
        id: s.STATUS_ID as string,
        name: (decodeHtml(s.NAME) || s.STATUS_ID) as string,
        semantics: (s.SEMANTICS || '') as string,
      }));
    }

    pipelines.push({ id: `deal_${catId}`, name: pipelineName, type: 'deal', stages });
  }

  if (includeLeads) {
    const res = await axios.get(`${baseUrl}/crm.status.list`, {
      params: { ...authParams, filter: { ENTITY_ID: 'STATUS' } }, timeout: 15000,
    });
    const stages: BitrixPipelineStage[] = (res.data?.result || []).map((s: any) => ({
      id: s.STATUS_ID as string,
      name: (decodeHtml(s.NAME) || s.STATUS_ID) as string,
      semantics: (s.SEMANTICS || '') as string,
    }));
    pipelines.push({ id: 'leads', name: 'Лиды', type: 'lead', stages });
  }

  return { pipelines };
}

// ── Fetch enum options for a custom field ──────────────────────────────────────

export async function fetchBitrixFieldOptions(
  connection: CrmConnection,
  fieldCode: string,
): Promise<{ options: Array<{ id: string; value: string }> }> {
  const isWebhook = !connection.access_token;
  let accessToken = connection.access_token;
  if (!isWebhook && connection.token_expires_at && new Date(connection.token_expires_at) < new Date(Date.now() + 5 * 60 * 1000)) {
    accessToken = await refreshBitrixToken(connection);
  }
  const rawBaseUrl = isWebhook ? connection.domain : `${connection.domain}/rest`;
  let baseUrl: string;
  try { baseUrl = normalizeWebhookUrl(rawBaseUrl); } catch {
    baseUrl = isWebhook ? `https://${connection.domain.replace(/\/$/, '')}` : `https://${connection.domain}/rest`;
  }
  const authParams: Record<string, string> = isWebhook ? {} : { auth: accessToken as string };

  // User field (UF_*): fetch via crm.deal.userfield.list or crm.lead.userfield.list
  const entityMethod = fieldCode.toUpperCase().startsWith('UF_') ? 'crm.deal.userfield.list' : null;

  if (entityMethod) {
    try {
      const res = await axios.get(`${baseUrl}/${entityMethod}`, {
        params: { ...authParams, filter: { FIELD_NAME: fieldCode } }, timeout: 15000,
      });
      const field = (res.data?.result || [])[0];
      if (field?.LIST) {
        return {
          options: (field.LIST as any[]).map(item => ({
            id: String(item.ID),
            value: (decodeHtml(item.VALUE) || String(item.ID)) as string,
          })),
        };
      }
    } catch (e) {
      console.warn(`[Bitrix] crm.deal.userfield.list failed for ${fieldCode}, trying crm.lead.userfield.list`);
    }

    // Fallback: lead userfield
    try {
      const res = await axios.get(`${baseUrl}/crm.lead.userfield.list`, {
        params: { ...authParams, filter: { FIELD_NAME: fieldCode } }, timeout: 15000,
      });
      const field = (res.data?.result || [])[0];
      if (field?.LIST) {
        return {
          options: (field.LIST as any[]).map(item => ({
            id: String(item.ID),
            value: (decodeHtml(item.VALUE) || String(item.ID)) as string,
          })),
        };
      }
    } catch { /* ignore */ }
  }

  // Standard field: try crm.deal.fields
  try {
    const res = await axios.get(`${baseUrl}/crm.deal.fields`, { params: authParams, timeout: 15000 });
    const field = res.data?.result?.[fieldCode];
    if (field?.items) {
      return {
        options: (field.items as any[]).map(item => ({
          id: String(item.ID),
          value: (decodeHtml(item.VALUE) || String(item.ID)) as string,
        })),
      };
    }
  } catch { /* ignore */ }

  return { options: [] };
}

// ── Main sync function ─────────────────────────────────────────────────────────

export async function syncBitrix24(
  connection: CrmConnection,
  since?: Date,
  onProgress?: (step: string, progress: number) => void,
) {
  const progress = onProgress || (() => {});
  console.log(`[Bitrix24] Syncing ${connection.domain}`);

  // Use granular sync_config if present; otherwise fall back to legacy sync_type
  const cfg: BitrixSyncConfig | null = connection.sync_config || null;
  const syncType: CrmSyncType = connection.sync_type || 'leads';
  const syncLeads  = cfg ? cfg.include_leads : (syncType === 'leads' || syncType === 'both');
  const syncDeals  = cfg ? cfg.deal_category_ids.length > 0 : (syncType === 'deals' || syncType === 'both');
  const dealCatIds: number[] | null = cfg ? (cfg.deal_category_ids.length > 0 ? cfg.deal_category_ids : null) : null;

  // Load client's MQL field code (for qualified lead attribution)
  const { data: clientSettings } = await supabase
    .from('clients').select('settings').eq('id', connection.client_id).single();
  const mqlFieldCode: string | null = (clientSettings?.settings as any)?.mqlFieldCode || null;

  // If mqlFieldCode is set, pre-fetch the field options to build id→value map
  // Bitrix24 stores enumeration value as ITEM ID in deal fields, not the text label
  let mqlValueMap: Map<string, string> = new Map(); // id → text
  if (mqlFieldCode && syncDeals) {
    try {
      const { options } = await fetchBitrixFieldOptions(connection, mqlFieldCode);
      for (const opt of options) mqlValueMap.set(opt.id, opt.value);
    } catch (e) {
      console.warn('[Bitrix24] Failed to fetch MQL field options:', e);
    }
  }

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
  if (syncLeads) {
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
  if (syncDeals) {
    console.log(`[Bitrix24] Fetching deals... categories: ${dealCatIds ? dealCatIds.join(',') : 'all'}`);
    progress('Выгрузка сделок...', 60);

    // If specific categories selected, fetch each separately and merge
    const dealFilterParams: Record<string, any> = { ...filterParams };
    if (dealCatIds && dealCatIds.length > 0) {
      dealFilterParams['CATEGORY_ID'] = dealCatIds;
    }

    const dealSelectFields = [
      'ID', 'TITLE', 'STAGE_ID', 'CATEGORY_ID', 'SOURCE_ID',
      'ASSIGNED_BY_NAME', 'DATE_CREATE', 'CLOSEDATE',
      'OPPORTUNITY', 'CURRENCY_ID', 'CONTACT_ID',
      'UTM_SOURCE', 'UTM_MEDIUM', 'UTM_CAMPAIGN', 'UTM_CONTENT', 'UTM_TERM',
    ];
    if (mqlFieldCode) dealSelectFields.push(mqlFieldCode);

    const rawDeals = await fetchAllPages<BitrixDeal>(
      baseUrl,
      'crm.deal.list',
      authParams,
      dealSelectFields,
      dealFilterParams,
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
        mql_reason: mqlFieldCode ? (() => {
          const rawVal = (item as any)[mqlFieldCode];
          if (!rawVal) return undefined;
          const valStr = String(rawVal);
          // Map Bitrix enumeration item ID → human-readable text
          return mqlValueMap.get(valStr) ?? valStr;
        })() : undefined,
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

  // ── Deduplicate by phone + UTM (only when syncing both leads and deals) ────
  // Problem: when sync_type='both', the same contact exists as both a Lead
  // (L_xxx) and a Deal (D_xxx). We must mark Leads as is_duplicate=true to
  // avoid double-counting in analytics.
  //
  // Strategy:
  //   1. Phone match: if a Lead's phone appears in any Deal → duplicate.
  //   2. UTM match (fallback): if a Lead's UTM combination matches a Deal's
  //      UTM combination → duplicate. Handles form leads that have no phone.
  let duplicatesMarked = 0;
  if (syncLeads && syncDeals) {
    console.log(`[Bitrix24] Deduplicating by phone + UTM...`);
    progress('Очищение дублей...', 95);

    // Fetch all records for this connection (both leads and deals)
    const { data: allRecords } = await supabase
      .from('crm_leads')
      .select('id, record_type, phone, utm_campaign, utm_content, utm_term, utm_source, utm_medium')
      .eq('crm_connection_id', connection.id);

    const deals    = (allRecords || []).filter((r: any) => r.record_type === 'deal');
    const rawLeads = (allRecords || []).filter((r: any) => r.record_type === 'lead');

    // Build sets of deal signatures for fast lookup
    const dealPhones = new Set<string>(
      deals.map((d: any) => d.phone as string | null).filter((p: string | null): p is string => Boolean(p)),
    );

    // UTM signature: non-empty utm_campaign + utm_content (most specific combo)
    const utmSig = (r: { utm_campaign?: string | null; utm_content?: string | null }): string | null => {
      const camp = (r.utm_campaign || '').trim().toLowerCase();
      const cont = (r.utm_content || '').trim().toLowerCase();
      if (!camp && !cont) return null;
      return `${camp}|${cont}`;
    };
    const dealUtmSigs = new Set<string>(
      deals.map((d: any) => utmSig(d)).filter((s: string | null): s is string => s !== null),
    );

    const dupIds: string[] = [];
    const notDupIds: string[] = [];

    for (const lead of rawLeads) {
      const phoneMatch = lead.phone && dealPhones.has(lead.phone);
      const sig = utmSig(lead);
      const utmMatch = sig !== null && dealUtmSigs.has(sig);

      if (phoneMatch || utmMatch) {
        dupIds.push(lead.id);
      } else {
        notDupIds.push(lead.id);
      }
    }

    console.log(`[Bitrix24] Dedup: ${dupIds.length} duplicates (phone=${[...dealPhones].length > 0 ? 'yes' : 'no'}, utmSigs=${dealUtmSigs.size}), ${notDupIds.length} unique leads`);

    // Batch mark duplicates
    const DEDUP_BATCH = 100;
    for (let i = 0; i < dupIds.length; i += DEDUP_BATCH) {
      const batch = dupIds.slice(i, i + DEDUP_BATCH);
      const { error } = await supabase
        .from('crm_leads')
        .update({ is_duplicate: true })
        .in('id', batch);
      if (error) console.error('[Bitrix24] Dedup mark error:', error.message);
      else duplicatesMarked += batch.length;
    }

    // Reset is_duplicate on leads NOT in dupIds (in case a deal was deleted)
    for (let i = 0; i < notDupIds.length; i += DEDUP_BATCH) {
      const batch = notDupIds.slice(i, i + DEDUP_BATCH);
      const { error } = await supabase
        .from('crm_leads')
        .update({ is_duplicate: false })
        .in('id', batch);
      if (error) console.error('[Bitrix24] Dedup reset error:', error.message);
    }

    progress(`Помечено ${duplicatesMarked} дублей`, 98);
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
