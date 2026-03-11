import { supabase } from '../lib/supabase';

/**
 * Нормализация строки для сравнения:
 * lowercase + пробелы/дефисы/подчёркивания → один пробел + trim
 */
function normalize(s: string | null | undefined): string {
  if (!s) return '';
  return s.toLowerCase().replace(/[\s\-_]+/g, ' ').trim();
}

/**
 * Возвращает нормализованное множество из всех UTM-значений лида
 */
function utmSet(lead: {
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;
  utm_content?: string | null;
  utm_term?: string | null;
}): Set<string> {
  return new Set(
    [lead.utm_source, lead.utm_medium, lead.utm_campaign, lead.utm_content, lead.utm_term]
      .map(normalize)
      .filter(Boolean)
  );
}

/**
 * UTM-матчинг для клиента.
 *
 * Алгоритм (exact):
 *  1. Берём все нормализованные UTM-значения лида (до 5 штук).
 *  2. Ищем кампанию: normalize(campaign_name) ∈ utmSet → matched_campaign_id
 *  3. Ищем адсет: normalize(adset_name) ∈ utmSet
 *     AND adset принадлежит найденной кампании → matched_adset_id
 *  4. Ищем объявление: normalize(ad_name) ∈ utmSet
 *     AND объявление принадлежит найденному адсету → matched_ad_id
 *
 * Обновляет только лиды, у которых ещё нет matched_campaign_id
 * (или forceRematching=true).
 */
export async function matchUtmForClient(
  clientId: string,
  forceRematching = false
): Promise<{ matched: number; skipped: number }> {
  // ── 1. Загрузить лиды с UTM ────────────────────────────────────────────────
  let leadsQuery = supabase
    .from('crm_leads')
    .select('id, utm_source, utm_medium, utm_campaign, utm_content, utm_term')
    .eq('client_id', clientId)
    .or('utm_source.not.is.null,utm_medium.not.is.null,utm_campaign.not.is.null,utm_content.not.is.null,utm_term.not.is.null');

  if (!forceRematching) {
    leadsQuery = leadsQuery.is('matched_campaign_id', null);
  }

  const { data: leads, error: leadsError } = await leadsQuery;
  if (leadsError) {
    console.error('[UTM Matcher] Failed to fetch leads:', leadsError.message);
    return { matched: 0, skipped: 0 };
  }
  if (!leads || leads.length === 0) return { matched: 0, skipped: 0 };

  // ── 2. Загрузить уникальные кампании ─────────────────────────────────────
  const { data: campaigns } = await supabase
    .from('campaign_stats')
    .select('campaign_id, campaign_name')
    .eq('client_id', clientId);

  const campaignMap = new Map<string, { id: string; name: string }>();
  for (const row of campaigns || []) {
    const key = normalize(row.campaign_name);
    if (key && !campaignMap.has(key)) {
      campaignMap.set(key, { id: row.campaign_id, name: row.campaign_name });
    }
  }

  // ── 3. Загрузить уникальные адсеты ────────────────────────────────────────
  const { data: adsets } = await supabase
    .from('adset_stats')
    .select('adset_id, adset_name, campaign_id')
    .eq('client_id', clientId);

  // Ключ: "campaign_id|norm(adset_name)" → adset_id
  const adsetMap = new Map<string, string>();
  for (const row of adsets || []) {
    const key = `${row.campaign_id}|${normalize(row.adset_name)}`;
    if (!adsetMap.has(key)) {
      adsetMap.set(key, row.adset_id);
    }
  }

  // ── 4. Загрузить уникальные объявления ───────────────────────────────────
  const { data: creatives } = await supabase
    .from('creative_stats')
    .select('ad_id, ad_name, adset_id, campaign_id')
    .eq('client_id', clientId);

  // Ключ: "adset_id|norm(ad_name)" → ad_id
  const adMap = new Map<string, string>();
  for (const row of creatives || []) {
    const key = `${row.adset_id}|${normalize(row.ad_name)}`;
    if (!adMap.has(key)) {
      adMap.set(key, row.ad_id);
    }
  }

  // ── 5. Матчинг ────────────────────────────────────────────────────────────
  let matched = 0;
  let skipped = 0;

  const updates: Array<{
    id: string;
    matched_campaign_id: string | null;
    matched_adset_id: string | null;
    matched_ad_id: string | null;
  }> = [];

  for (const lead of leads) {
    const utms = utmSet(lead);
    if (utms.size === 0) { skipped++; continue; }

    // Найти кампанию
    let matchedCampaignId: string | null = null;
    for (const [normName, camp] of campaignMap) {
      if (utms.has(normName)) { matchedCampaignId = camp.id; break; }
    }

    if (!matchedCampaignId) { skipped++; continue; }

    // Найти адсет внутри кампании
    let matchedAdsetId: string | null = null;
    for (const utm of utms) {
      const key = `${matchedCampaignId}|${utm}`;
      if (adsetMap.has(key)) { matchedAdsetId = adsetMap.get(key)!; break; }
    }

    // Найти объявление внутри адсета
    let matchedAdId: string | null = null;
    if (matchedAdsetId) {
      for (const utm of utms) {
        const key = `${matchedAdsetId}|${utm}`;
        if (adMap.has(key)) { matchedAdId = adMap.get(key)!; break; }
      }
    }

    updates.push({
      id: lead.id,
      matched_campaign_id: matchedCampaignId,
      matched_adset_id: matchedAdsetId,
      matched_ad_id: matchedAdId,
    });
    matched++;
  }

  // ── 6. Сохранить результаты пакетом ───────────────────────────────────────
  if (updates.length > 0) {
    // Upsert пакетами по 500
    const BATCH = 500;
    for (let i = 0; i < updates.length; i += BATCH) {
      const batch = updates.slice(i, i + BATCH);
      const { error } = await supabase
        .from('crm_leads')
        .upsert(batch, { onConflict: 'id' });
      if (error) {
        console.error('[UTM Matcher] Upsert error:', error.message);
      }
    }
  }

  console.log(`[UTM Matcher] clientId=${clientId}: matched=${matched}, skipped=${skipped}`);
  return { matched, skipped };
}
