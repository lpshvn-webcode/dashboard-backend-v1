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

  // ── 1. Загрузить лиды, у которых есть хоть одно UTM-значение ────────────────
  let leadsQuery = supabase
    .from('crm_leads')
    .select('id, utm_source, utm_medium, utm_campaign, utm_content, utm_term')
    .eq('client_id', clientId)
    .or('utm_campaign.not.is.null,utm_content.not.is.null,utm_term.not.is.null,utm_source.not.is.null,utm_medium.not.is.null');

  if (!forceRematching) {
    leadsQuery = leadsQuery.is('matched_campaign_id', null);
  }

  const { data: leads, error: leadsError } = await leadsQuery;
  if (leadsError) {
    console.error('[UTM Matcher] Failed to fetch leads:', leadsError.message);
    return { matched: 0, skipped: 0 };
  }
  if (!leads || leads.length === 0) {
    console.log(`[UTM Matcher] clientId=${clientId}: No unmatched leads with UTM found (forceRematching=${forceRematching})`);
    return { matched: 0, skipped: 0 };
  }

  console.log(`[UTM Matcher] clientId=${clientId}: Processing ${leads.length} leads`);
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
    /** Нормализованный пул из трёх FB-названий */
    normNames: Set<string>;
  }

  const triples: FbTriple[] = [];
  const tripleKeysSeen = new Set<string>();

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

    triples.push({
      campaignName,
      adsetName: adset.adsetName,
      adName: creative.ad_name,
      normNames: new Set([normCampaign, normAdset, normAd]),
    });
  }

  console.log(`[UTM Matcher] Built ${triples.length} FB triples (campaign+adset+ad)`);
  triples.slice(0, 3).forEach((t, i) => {
    console.log(`[UTM Matcher] Triple[${i}]: campaign="${t.campaignName}" | adset="${t.adsetName}" | ad="${t.adName}"`);
  });

  if (triples.length === 0) {
    console.warn('[UTM Matcher] No FB triples found — check that campaign/adset/creative stats are synced for this client');
    return { matched: 0, skipped: leads.length };
  }

  // ── 5. Матчинг: пул FB-названий vs пул UTM-значений лида ────────────────────
  let matched = 0;
  let skipped = 0;
  let noUtmValues = 0;

  const matchedLeads: Array<{
    id: string;
    matched_campaign_id: string;
    matched_adset_id: string;
    matched_ad_id: string;
  }> = [];

  for (const lead of leads) {
    // Строим пул из всех 5 UTM-полей (нормализованные непустые значения)
    const utmPool = new Set(
      [lead.utm_source, lead.utm_medium, lead.utm_campaign, lead.utm_content, lead.utm_term]
        .map(v => normalize(v))
        .filter(v => v !== '')
    );

    if (utmPool.size === 0) {
      noUtmValues++;
      skipped++;
      continue;
    }

    // Ищем первую тройку, все 3 нормализованных названия которой есть в UTM-пуле
    let foundTriple: FbTriple | null = null;
    for (const triple of triples) {
      let allFound = true;
      for (const name of triple.normNames) {
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
      if (skipped <= 3) {
        console.log(`[UTM Matcher] NO MATCH for lead ${lead.id}: UTM pool=[${Array.from(utmPool).join(' | ')}]`);
        // Показываем ближайшие тройки для диагностики
        triples.slice(0, 2).forEach(t => {
          console.log(`[UTM Matcher]   Checked triple: [${Array.from(t.normNames).join(' | ')}]`);
        });
      }
      continue;
    }

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
