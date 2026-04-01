const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const CLIENT_ID = 'ae76d154-18b5-413f-a83b-3a1d9b09a3d5';

async function paginateLeads(filters) {
  const PAGE = 1000;
  let all = [], page = 0;
  while (true) {
    let q = sb.from('crm_leads')
      .select('id, record_type, is_duplicate, matched_campaign_id, created_at_crm, phone, utm_campaign, utm_content')
      .eq('client_id', CLIENT_ID)
      .range(page*PAGE, (page+1)*PAGE-1);
    if (filters) q = filters(q);
    const { data, error } = await q;
    if (error) { console.error('error:', error.message); break; }
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    page++;
  }
  return all;
}

function kztDate(isoStr) {
  return new Date(new Date(isoStr).getTime() + 5*60*60*1000).toISOString().substring(0,10);
}

async function main() {
  console.log('Loading ALL crm_leads (paginated)...');
  const all = await paginateLeads(null);
  console.log('Total crm_leads:', all.length);

  const leads = all.filter(r => r.record_type === 'lead');
  const deals  = all.filter(r => r.record_type === 'deal');
  console.log(`Leads: ${leads.length}, Deals: ${deals.length}`);
  console.log(`Dups: ${all.filter(r=>r.is_duplicate).length}`);
  console.log(`Matched total: ${all.filter(r=>r.matched_campaign_id).length}`);
  console.log(`Matched leads: ${leads.filter(r=>r.matched_campaign_id).length}`);
  console.log(`Matched deals: ${deals.filter(r=>r.matched_campaign_id).length}`);

  // ── Matched leads by KZT date ─────────────────────────────────────────
  const matchedLeads = leads.filter(r => r.matched_campaign_id && !r.is_duplicate);
  const matchedDeals = deals.filter(r => r.matched_campaign_id && !r.is_duplicate);

  const leadsByDate = {};
  for (const l of matchedLeads) {
    const d = kztDate(l.created_at_crm);
    leadsByDate[d] = (leadsByDate[d]||0) + 1;
  }
  const dealsByDate = {};
  for (const d of matchedDeals) {
    const date = kztDate(d.created_at_crm);
    dealsByDate[date] = (dealsByDate[date]||0) + 1;
  }

  console.log('\n=== Matched LEADS by KZT date (all time) ===');
  Object.entries(leadsByDate).sort(([a],[b])=>a.localeCompare(b)).forEach(([d,n])=>console.log(`  ${d}: ${n}`));

  console.log('\n=== Matched DEALS by KZT date (all time) ===');
  if (Object.keys(dealsByDate).length === 0) {
    console.log('  (none)');
  } else {
    Object.entries(dealsByDate).sort(([a],[b])=>a.localeCompare(b)).forEach(([d,n])=>console.log(`  ${d}: ${n}`));
  }

  // ── Focus on March 9-15 ───────────────────────────────────────────────
  const march9to15Leads = matchedLeads.filter(r => {
    const d = kztDate(r.created_at_crm);
    return d >= '2026-03-09' && d <= '2026-03-15';
  });
  const march9to15Deals = matchedDeals.filter(r => {
    const d = kztDate(r.created_at_crm);
    return d >= '2026-03-09' && d <= '2026-03-15';
  });

  console.log('\n=== Mar 9-15 MATCHED LEADS:', march9to15Leads.length, '===');
  const byDay = {};
  for (const l of march9to15Leads) {
    const d = kztDate(l.created_at_crm);
    byDay[d] = (byDay[d]||0)+1;
  }
  Object.entries(byDay).sort(([a],[b])=>a.localeCompare(b)).forEach(([d,n])=>console.log(`  ${d}: ${n}`));

  console.log('\n=== Mar 9-15 MATCHED DEALS:', march9to15Deals.length, '===');

  // ── Phone overlap: how many leads have a matching deal phone? ─────────
  const dealPhones = new Set(deals.map(d=>d.phone).filter(Boolean));
  const leadsMatchingDealPhone = leads.filter(l => l.phone && dealPhones.has(l.phone));
  console.log('\n=== Phone overlap (all time) ===');
  console.log('Deal phones total:', dealPhones.size);
  console.log('Leads with matching deal phone:', leadsMatchingDealPhone.length);
  console.log('  → These are TRUE duplicates (same contact, lead+deal)');

  // ── UTM overlap ─────────────────────────────────────────────────────
  const dealUtmSigs = new Set(deals.map(d=>{
    const c=(d.utm_campaign||'').trim().toLowerCase();
    const t=(d.utm_content||'').trim().toLowerCase();
    return (c||t) ? `${c}|${t}` : null;
  }).filter(Boolean));
  const leadsWithDealUtm = leads.filter(l=>{
    const sig=`${(l.utm_campaign||'').trim().toLowerCase()}|${(l.utm_content||'').trim().toLowerCase()}`;
    return dealUtmSigs.has(sig);
  });
  console.log('\n=== UTM overlap ===');
  console.log('Unique UTM sigs in deals:', dealUtmSigs.size, [...dealUtmSigs].slice(0,5).join(' | '));
  console.log('Leads with deal UTM sig:', leadsWithDealUtm.length);

  // ── Deals distribution by date (to see the March 10 spike) ──────────
  const dealDateCounts = {};
  for (const d of deals) {
    const date = kztDate(d.created_at_crm);
    dealDateCounts[date] = (dealDateCounts[date]||0)+1;
  }
  const topDates = Object.entries(dealDateCounts).sort(([,a],[,b])=>b-a).slice(0,10);
  console.log('\n=== Top 10 deal dates (by count) ===');
  topDates.forEach(([d,n])=>console.log(`  ${d}: ${n} deals`));
}

main().catch(console.error);
