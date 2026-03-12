import he from 'he';
import { supabase } from '../lib/supabase';

/**
 * Нормализация строки для сравнения:
 * 1. Декодирует HTML-сущности (Bitrix24 возвращает "&mdash;" вместо "—")
 * 2. lowercase
 * 3. пробелы/дефисы/тире/подчёркивания → один пробел + trim
 */
function normalize(s: string | null | undefined): string {
  if (!s) return '';
  const decoded = he.decode(s);
  return decoded.toLowerCase().replace(/[\s\-\u2013\u2014_]+/g, ' ').trim();
}

/**
 * Bitrix24 записывает буквальные названия UTM-полей как значения
 * (например utm_source="utm_source"), когда реальные UTM не заполнены.
 * Фильтруем эти placeholder-ы.
 */
const UTM_PLACEHOLDER_VALUES = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
  'utm source', 'utm medium', 'utm campaign', 'utm content', 'utm term',
]);

function isPlaceholderUtm(value: string | null | undefined): boolean {
  if (!value) return true;
  const trimmed = value.trim();
  if (trimmed === '') return true;
  return UTM_PLACEHOLDER_VALUES.has(trimmed.toLowerCase());
}

/**
 * UTM-матчинг для клиента — POOL-BASED (гибкий) подход.
 *
 * Алгоритм:
 *   1. Из FB-данных строим «тройки»: {campaign_name, adset_name, ad_name}
 *   2. Для каждого лида берём пул из всех 5 UTM-значений
 *   3. Матч = все 3 нормализованных FB-названия присутствуют в UTM-пуле лида
 *      (неважно, в каком именно utm_* поле находится каждое название)
 *
 * Преимущество: не зависит от того, в какое UTM-поле рекламодатель записал
 * campaign_name / adset_name / ad_name — достаточно чтобы все три нашлись
 * хоть где-то среди 5 UTM-полей.
 *
 * Обновляет только лиды без matched_campaign_id (или все при forceRematching=true).
 */
export async function matchUtmForClient(
  clientId: string,
  forceRematching = false
): Promise<{ matched: number; skipped: number }> {

  // ── 1. Загрузить ВСЕ лиды клиента ────────────────────────────────────────────
  // Supabase по умолчанию возвращает 1000 строк — используем пагинацию.
  const PAGE_SIZE = 1000;
  let allLeads: any[] = [];
  let page = 0;

  while (true) {
    let q = supabase
      .from('crm_leads')
      .select('id, utm_source, utm_medium, utm_campaign, utm_content, utm_term')
      .eq('client_id', clientId)
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

    if (!forceRematching) {
      q = q.is('matched_campaign_id', null);
    }

    const { data: batch, error: batchError } = await q;
    if (batchError) {
      console.error('[UTM Matcher] Failed to fetch leads page:', batchError.message);
      return { matched: 0, skipped: 0 };
    }
    if (!batch || batch.length === 0) break;

    allLeads.push(...batch);
    if (batch.length < PAGE_SIZE) break; // последняя страница
    page++;
  }

  // Фильтруем: оставляем лиды с хотя бы одним РЕАЛЬНЫМ (не placeholder) UTM
  const leads = allLeads.filter((lead: any) => {
    const values = [lead.utm_source, lead.utm_medium, lead.utm_campaign, lead.utm_content, lead.utm_term];
    return values.some(v => !isPlaceholderUtm(v));
  });

  const placeholderCount = allLeads.length - leads.length;
  console.log(`[UTM Matcher] clientId=${clientId}: Loaded ${allLeads.length} total rows, ${leads.length} with real UTM, ${placeholderCount} placeholder-only (forceRematching=${forceRematching})`);

  if (leads.length === 0) {
    console.log(`[UTM Matcher] clientId=${clientId}: No leads with real UTM values found`);
    return { matched: 0, skipped: 0 };
  }

  leads.slice(0, 3).forEach((lead: any, i: number) => {
    console.log(`[UTM Matcher] Lead[${i}] utm_campaign="${lead.utm_campaign}" utm_content="${lead.utm_content}" utm_term="${lead.utm_term}" utm_source="${lead.utm_source}" utm_medium="${lead.utm_medium}"`);
  });

  // ── 2. Загрузить campaign_name по campaign_id ────────────────────────────────
  const { data: campaigns } = await supabase
    .from('campaign_stats')
    .select('campaign_id, campaign_name')
    .eq('client_id', clientId);

  const campaignNameMap = new Map<string, string>(); // campaign_id → campaign_name (первое вхождение)
  for (const row of campaigns || []) {
    if (row.campaign_id && row.campaign_name && !campaignNameMap.has(row.campaign_id)) {
      campaignNameMap.set(row.campaign_id, row.campaign_name);
    }
  }
  console.log(`[UTM Matcher] Loaded ${campaignNameMap.size} unique campaigns`);

  // ── 3. Загрузить adset_name + campaign_id по adset_id ───────────────────────
  const { data: adsets } = await supabase
    .from('adset_stats')
    .select('adset_id, adset_name, campaign_id')
    .eq('client_id', clientId);

  const adsetMap = new Map<string, { adsetName: string; campaignId: string }>();
  for (const row of adsets || []) {
    if (row.adset_id && !adsetMap.has(row.adset_id)) {
      adsetMap.set(row.adset_id, { adsetName: row.adset_name, campaignId: row.campaign_id });
    }
  }
  console.log(`[UTM Matcher] Loaded ${adsetMap.size} unique adsets`);

  // ── 4. Загрузить креативы и построить тройки ─────────────────────────────────
  const { data: creatives } = await supabase
    .from('creative_stats')
    .select('ad_id, ad_name, adset_id')
    .eq('client_id', clientId);

  interface FbTriple {
    campaignName: string;
    adsetName: string;
    adName: string;
    /** Нормализованные FB-названия (массив, для точного сравнения 3-х элементов) */
    normNames: string[];
    /** Set для быстрого lookup */
    normNamesSet: Set<string>;
  }

  const triples: FbTriple[] = [];
  const tripleKeysSeen = new Set<string>();
  let skippedPromo = 0;

  for (const creative of creatives || []) {
    if (!creative.ad_id || !creative.ad_name) continue;

    const adset = adsetMap.get(creative.adset_id);
    if (!adset) continue;

    const campaignName = campaignNameMap.get(adset.campaignId);
    if (!campaignName) continue;

    const tripleKey = `${adset.campaignId}|${creative.adset_id}|${creative.ad_id}`;
    if (tripleKeysSeen.has(tripleKey)) continue;
    tripleKeysSeen.add(tripleKey);

    const normCampaign = normalize(campaignName);
    const normAdset   = normalize(adset.adsetName);
    const normAd      = normalize(creative.ad_name);

    // Нельзя матчить по пустым названиям
    if (!normCampaign || !normAdset || !normAd) continue;

    const normNamesSet = new Set([normCampaign, normAdset, normAd]);

    // Пропускаем тройки, где все 3 названия совпадают (promo/boost посты).
    // Set дедуплицирует их в 1 элемент, что даёт ложные матчи.
    // Требуем минимум 2 уникальных названия для надёжного матчинга.
    if (normNamesSet.size < 2) {
      skippedPromo++;
      continue;
    }

    triples.push({
      campaignName,
      adsetName: adset.adsetName,
      adName: creative.ad_name,
      normNames: [normCampaign, normAdset, normAd],
      normNamesSet,
    });
  }

  console.log(`[UTM Matcher] Built ${triples.length} FB triples (campaign+adset+ad), skipped ${skippedPromo} promo/boost triples`);
  triples.forEach((t: FbTriple, i: number) => {
    console.log(`[UTM Matcher] Triple[${i}]: campaign="${t.campaignName}" | adset="${t.adsetName}" | ad="${t.adName}" | uniqueNames=${t.normNamesSet.size} | normalized=[${t.normNames.join(' | ')}]`);
  });

  if (triples.length === 0) {
    console.warn('[UTM Matcher] No FB triples found — check that campaign/adset/creative stats are synced for this client');
    return { matched: 0, skipped: leads.length };
  }

  // ── 5. Матчинг: пул FB-названий vs пул UTM-значений лида ────────────────────
  let matched = 0;
  let skipped = 0;
  let noUtmValues = 0;

  // При forceRematching — сначала очищаем старые матчи, чтобы не было остатков
  if (forceRematching) {
    console.log(`[UTM Matcher] Force rematching: clearing old matched_* fields...`);
    const { error: clearError } = await supabase
      .from('crm_leads')
      .update({
        matched_campaign_id: null,
        matched_adset_id: null,
        matched_ad_id: null,
      })
      .eq('client_id', clientId)
      .not('matched_campaign_id', 'is', null);

    if (clearError) {
      console.error('[UTM Matcher] Failed to clear old matches:', clearError.message);
    } else {
      console.log('[UTM Matcher] Old matches cleared');
    }
  }

  const matchedLeads: Array<{
    id: string;
    matched_campaign_id: string;
    matched_adset_id: string;
    matched_ad_id: string;
  }> = [];

  for (const lead of leads) {
    // Строим пул из всех 5 UTM-полей (нормализованные, без placeholder-ов)
    const utmValues = [lead.utm_source, lead.utm_medium, lead.utm_campaign, lead.utm_content, lead.utm_term];
    const utmPool = new Set(
      utmValues
        .filter(v => !isPlaceholderUtm(v))
        .map(v => normalize(v))
        .filter(v => v !== '')
    );

    if (utmPool.size === 0) {
      noUtmValues++;
      skipped++;
      continue;
    }

    // Ищем первую тройку, все уникальные нормализованные названия которой есть в UTM-пуле
    let foundTriple: FbTriple | null = null;
    for (const triple of triples) {
      let allFound = true;
      for (const name of triple.normNamesSet) {
        if (!utmPool.has(name)) {
          allFound = false;
          break;
        }
      }
      if (allFound) {
        foundTriple = triple;
        break;
      }
    }

    if (!foundTriple) {
      skipped++;
      if (skipped <= 10) {
        console.log(`[UTM Matcher] ❌ NO MATCH lead_id=${lead.id}: UTM pool=[${Array.from(utmPool).join(' | ')}]`);
        console.log(`[UTM Matcher]   UTM fields: source="${lead.utm_source || ''}" | medium="${lead.utm_medium || ''}" | campaign="${lead.utm_campaign || ''}" | content="${lead.utm_content || ''}" | term="${lead.utm_term || ''}"`);
      }
      continue;
    }

    // ── Детальный лог каждого матча для диагностики ложных срабатываний ──
    console.log(`[UTM Matcher] ✅ MATCH #${matched + 1} lead_id=${lead.id}`);
    console.log(`[UTM Matcher]   UTM fields: source="${lead.utm_source || ''}" | medium="${lead.utm_medium || ''}" | campaign="${lead.utm_campaign || ''}" | content="${lead.utm_content || ''}" | term="${lead.utm_term || ''}"`);
    console.log(`[UTM Matcher]   UTM pool (normalized): [${Array.from(utmPool).join(' | ')}]`);
    console.log(`[UTM Matcher]   FB triple: campaign="${foundTriple.campaignName}" | adset="${foundTriple.adsetName}" | ad="${foundTriple.adName}"`);
    console.log(`[UTM Matcher]   FB pool (normalized): [${foundTriple.normNames.join(' | ')}] (unique=${foundTriple.normNamesSet.size})`);

    matchedLeads.push({
      id: lead.id,
      matched_campaign_id: foundTriple.campaignName,
      matched_adset_id: foundTriple.adsetName,
      matched_ad_id: foundTriple.adName,
    });
    matched++;
  }

  console.log(`[UTM Matcher] Results: matched=${matched}, skipped=${skipped} (noUtmValues=${noUtmValues})`);

  // ── 6. Обновляем через UPDATE батчами по 50 ──────────────────────────────────
  if (matchedLeads.length > 0) {
    const BATCH = 50;
    let updateErrors = 0;

    for (let i = 0; i < matchedLeads.length; i += BATCH) {
      const batch = matchedLeads.slice(i, i + BATCH);

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
          if (updateErrors <= 3) console.error('[UTM Matcher] Update error:', error.message);
        }
      }
    }

    if (updateErrors === 0) {
      console.log(`[UTM Matcher] Successfully updated ${matchedLeads.length} leads in Supabase`);
    } else {
      console.warn(`[UTM Matcher] ${updateErrors} update errors out of ${matchedLeads.length} leads`);
    }
  }

  return { matched, skipped };
}
