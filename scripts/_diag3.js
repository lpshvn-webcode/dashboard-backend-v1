const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const CLIENT_ID = 'ae76d154-18b5-413f-a83b-3a1d9b09a3d5';
const DATE_FROM = '2026-03-09';
const DATE_TO   = '2026-03-15';

async function paginate(table, select, filters) {
  const PAGE = 1000;
  let all = [], page = 0;
  while (true) {
    let q = sb.from(table).select(select).eq('client_id', CLIENT_ID).range(page*PAGE, (page+1)*PAGE-1);
    if (filters) q = filters(q);
    const { data, error } = await q;
    if (error) { console.error(table, 'error:', error.message); break; }
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    page++;
  }
  return all;
}

async function main() {
  // Load all leads with full fields for the period (UTC filter ±5h margin)
  // Use wider margin to catch timezone edge cases
  const { data: rawPeriod } = await sb
    .from('crm_leads')
    .select('id, record_type, is_duplicate, matched_campaign_id, created_at_crm, utm_campaign, utm_content, utm_source, phone, lead_name')
    .eq('client_id', CLIENT_ID)
    .gte('created_at_crm', '2026-03-08T19:00:00')   // UTC = Mar 9 00:00 KZT (UTC+5)
    .lte('created_at_crm', '2026-03-15T23:59:59')
    .order('created_at_crm', { ascending: true });

  const period = rawPeriod || [];
  console.log('=== crm_leads Mar 9-15 (wide UTC window) ===');
  console.log('Total:', period.length);

  // Group by type and date (KZT)
  const dealsByDate = {};
  const leadsByDate = {};
  for (const r of period) {
    const kztDate = new Date(new Date(r.created_at_crm).getTime() + 5*60*60*1000).toISOString().substring(0,10);
    if (r.record_type === 'deal') {
      dealsByDate[kztDate] = (dealsByDate[kztDate]||0) + 1;
    } else {
      leadsByDate[kztDate] = (leadsByDate[kztDate]||0) + 1;
    }
  }
  console.log('\nDeals by KZT date:');
  Object.entries(dealsByDate).sort(([a],[b])=>a.localeCompare(b)).forEach(([d,n])=>console.log(`  ${d}: ${n}`));
  console.log('Leads by KZT date:');
  Object.entries(leadsByDate).sort(([a],[b])=>a.localeCompare(b)).forEach(([d,n])=>console.log(`  ${d}: ${n}`));

  // ── Phone overlap analysis ─────────────────────────────────────────────
  const deals  = period.filter(r => r.record_type === 'deal');
  const leads  = period.filter(r => r.record_type === 'lead');
  const dealPhones = new Set(deals.map(d=>d.phone).filter(Boolean));
  const leadsWithDealPhone = leads.filter(l => l.phone && dealPhones.has(l.phone));
  console.log(`\nDeals: ${deals.length}, Leads: ${leads.length}`);
  console.log(`Deal phones: ${dealPhones.size}`);
  console.log(`Leads with matching deal phone: ${leadsWithDealPhone.length}`);

  // ── UTM overlap analysis ───────────────────────────────────────────────
  const dealUtmSigs = new Set(deals.map(d => {
    const c = (d.utm_campaign||'').trim().toLowerCase();
    const t = (d.utm_content||'').trim().toLowerCase();
    return (c||t) ? `${c}|${t}` : null;
  }).filter(Boolean));
  const leadsWithDealUtm = leads.filter(l => {
    const sig = `${(l.utm_campaign||'').trim().toLowerCase()}|${(l.utm_content||'').trim().toLowerCase()}`;
    return dealUtmSigs.has(sig);
  });
  console.log(`UTM signatures in deals: ${dealUtmSigs.size}`);
  console.log(`Leads with matching UTM: ${leadsWithDealUtm.length}`);

  // ── Sample deals to understand the data ───────────────────────────────
  console.log('\n=== SAMPLE DEALS (first 10) ===');
  deals.slice(0,10).forEach(d => {
    const kzt = new Date(new Date(d.created_at_crm).getTime()+5*60*60*1000).toISOString().substring(0,16);
    console.log(`  [${kzt}] ${(d.lead_name||'').substring(0,30).padEnd(30)} ph:${d.phone||'-'} utm_camp:${d.utm_campaign||'-'} dup:${d.is_duplicate} matched:${d.matched_campaign_id ? 'YES' : 'NO'}`);
  });

  console.log('\n=== SAMPLE LEADS (first 10) ===');
  leads.slice(0,10).forEach(l => {
    const kzt = new Date(new Date(l.created_at_crm).getTime()+5*60*60*1000).toISOString().substring(0,16);
    console.log(`  [${kzt}] ${(l.lead_name||'').substring(0,30).padEnd(30)} ph:${l.phone||'-'} utm_camp:${l.utm_campaign||'-'} dup:${l.is_duplicate} matched:${l.matched_campaign_id ? 'YES' : 'NO'}`);
  });

  // ── How many deals are matched to FB campaigns? ─────────────────────
  const matchedDeals = deals.filter(d => d.matched_campaign_id && !d.is_duplicate);
  const matchedLeads = leads.filter(l => l.matched_campaign_id && !l.is_duplicate);
  console.log(`\nMatched deals (non-dup): ${matchedDeals.length}`);
  console.log(`Matched leads (non-dup): ${matchedLeads.length}`);

  // ── Campaign breakdown of matched deals ───────────────────────────────
  if (matchedDeals.length > 0) {
    const byCamp = {};
    for (const d of matchedDeals) {
      byCamp[d.matched_campaign_id] = (byCamp[d.matched_campaign_id]||0) + 1;
    }
    console.log('\nMatched deals by campaign:');
    Object.entries(byCamp).sort(([,a],[,b])=>b-a).forEach(([c,n])=>console.log(`  ${n}  ${c}`));
  }
}

main().catch(console.error);
