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
  if (!leads || leads.length === 0) {
    console.log(`[UTM Matcher] clientId=${clientId}: No leads with UTM tags found (forceRematching=${forceRematching})`);
    return { matched: 0, skipped: 0 };
  }

  console.log(`[UTM Matcher] clientId=${clientId}: Found ${leads.length} leads with UTM tags`);
  // Debug: показываем первые 3 лида и их UTM-значения
  leads.slice(0, 3).forEach((lead, i) => {
    console.log(`[UTM Matcher] Lead[${i}] utm_campaign="${lead.utm_campaign}" utm_content="${lead.utm_content}" utm_source="${lead.utm_source}" utm_medium="${lead.utm_medium}" utm_term="${lead.utm_term}"`);
  });

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

  console.log(`[UTM Matcher] Found ${campaignMap.size} unique campaigns`);
  // Debug: показываем первые 5 нормализованных имён кампаний
  Array.from(campaignMap.keys()).slice(0, 5).forEach(k => {
    console.log(`[UTM Matcher] Campaign norm="${k}" → "${campaignMap.get(k)?.name}"`);
  });

  // ── 3. Загрузить уникальные адсеты ────────────────────────────────────────
  const { data: adsets } = await supabase
    .from('adset_stats')
    .select('adset_id, adset_name, campaign_id')
    .eq('client_id', clientId);

  // Ключ: "campaign_id|norm(adset_name)" → { id, name }
  const adsetMap = new Map<string, { id: string; name: string }>();
  for (const row of adsets || []) {
    const key = `${row.campaign_id}|${normalize(row.adset_name)}`;
    if (!adsetMap.has(key)) {
      adsetMap.set(key, { id: row.adset_id, name: row.adset_name });
    }
  }

  // ── 4. Загрузить уникальные объявления ───────────────────────────────────
  const { data: creatives } = await supabase
    .from('creative_stats')
    .select('ad_id, ad_name, adset_id, campaign_id')
    .eq('client_id', clientId);

  // Ключ: "adset_id|norm(ad_name)" → { id, name }
  const adMap = new Map<string, { id: string; name: string }>();
  for (const row of creatives || []) {
    const key = `${row.adset_id}|${normalize(row.ad_name)}`;
    if (!adMap.has(key)) {
      adMap.set(key, { id: row.ad_id, name: row.ad_name });
    }
  }

  // ── 5. Матчинг ────────────────────────────────────────────────────────────
  let matched = 0;
  let skipped = 0;
  let noUtmCount = 0;
  let noCampaignMatchCount = 0;

  // IDs лидов → объекты для обновления (используем UPDATE, не upsert)
  const matchedLeads: Array<{
    id: string;
    matched_campaign_id: string;
    matched_adset_id: string | null;
    matched_ad_id: string | null;
  }> = [];

  for (const lead of leads) {
    const utms = utmSet(lead);
    if (utms.size === 0) { noUtmCount++; skipped++; continue; }

    // Найти кампанию
    let matchedCampaign: { id: string; name: string } | null = null;
    for (const [normName, camp] of campaignMap) {
      if (utms.has(normName)) { matchedCampaign = camp; break; }
    }

    if (!matchedCampaign) {
      noCampaignMatchCount++;
      skipped++;
      // Debug первых 2 несматченных лидов
      if (noCampaignMatchCount <= 2) {
        console.log(`[UTM Matcher] No campaign match for UTMs: [${Array.from(utms).join(', ')}]`);
        console.log(`[UTM Matcher] Available campaigns (norm): [${Array.from(campaignMap.keys()).slice(0, 5).join(', ')}]`);
      }
      continue;
    }

    // Найти адсет внутри кампании (ключ по campaign_id для уникальности)
    let matchedAdset: { id: string; name: string } | null = null;
    for (const utm of utms) {
      const key = `${matchedCampaign.id}|${utm}`;
      if (adsetMap.has(key)) { matchedAdset = adsetMap.get(key)!; break; }
    }

    // Найти объявление внутри адсета (ключ по adset_id для уникальности)
    let matchedAd: { id: string; name: string } | null = null;
    if (matchedAdset) {
      for (const utm of utms) {
        const key = `${matchedAdset.id}|${utm}`;
        if (adMap.has(key)) { matchedAd = adMap.get(key)!; break; }
      }
    }

    // Сохраняем имена (campaign_name, adset_name, ad_name) для удобной связки с фронтом
    matchedLeads.push({
      id: lead.id,
      matched_campaign_id: matchedCampaign.name,
      matched_adset_id: matchedAdset?.name || null,
      matched_ad_id: matchedAd?.name || null,
    });
    matched++;
  }

  console.log(`[UTM Matcher] Match results: matched=${matched}, skipped=${skipped} (noUtm=${noUtmCount}, noCampaignMatch=${noCampaignMatchCount})`);

  // ── 6. Обновить результаты через UPDATE (не upsert, чтобы не нарушать NOT NULL constraints) ──
  if (matchedLeads.length > 0) {
    // Обновляем пакетами по 50 через Promise.all для параллельности
    const BATCH = 50;
    let updateErrors = 0;

    for (let i = 0; i < matchedLeads.length; i += BATCH) {
      const batch = matchedLeads.slice(i, i + BATCH);

      // Параллельно обновляем все строки в batch
      const results = await Promise.all(
        batch.map(lead =>
          supabase
            .from('crm_leads')
            .update({
              matched_campaign_id: lead.matched_campaign_id,
              matched_adset_id: lead.matched_adset_id,
              matched_ad_id: lead.matched_ad_id,
            })
            .eq('id', lead.id)
        )
      );

      for (const { error } of results) {
        if (error) {
          updateErrors++;
          console.error('[UTM Matcher] Update error:', error.message);
        }
      }
    }

    if (updateErrors === 0) {
      console.log(`[UTM Matcher] Successfully updated ${matchedLeads.length} leads`);
    } else {
      console.warn(`[UTM Matcher] ${updateErrors} update errors out of ${matchedLeads.length} leads`);
    }
  }

  return { matched, skipped };
}
