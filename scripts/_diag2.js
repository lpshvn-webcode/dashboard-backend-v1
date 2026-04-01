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
  // ── 1. Total crm_leads count (with pagination)
  const allLeads = await paginate('crm_leads', 'id, record_type, is_duplicate, matched_campaign_id, created_at_crm', null);
  console.log('=== TOTAL crm_leads ===');
  console.log('Total rows:', allLeads.length);
  const byType = {};
  for (const l of allLeads) {
    byType[l.record_type||'?'] = (byType[l.record_type||'?']||0) + 1;
  }
  console.log('By type:', JSON.stringify(byType));
  console.log('Duplicates:', allLeads.filter(l=>l.is_duplicate).length);
  console.log('Matched:', allLeads.filter(l=>l.matched_campaign_id).length);
  console.log('Matched+nonDup:', allLeads.filter(l=>l.matched_campaign_id && !l.is_duplicate).length);

  // ── 2. crm_leads for March 9-15 specifically
  const periodLeads = allLeads.filter(l => {
    if (!l.created_at_crm) return false;
    // UTC+5 shift
    const d = new Date(new Date(l.created_at_crm).getTime() + 5*60*60*1000).toISOString().substring(0,10);
    return d >= DATE_FROM && d <= DATE_TO;
  });
  console.log('\n=== crm_leads for', DATE_FROM, '-', DATE_TO, '(UTC+5) ===');
  console.log('Total:', periodLeads.length);
  const pByType = {};
  for (const l of periodLeads) { pByType[l.record_type||'?'] = (pByType[l.record_type||'?']||0)+1; }
  console.log('By type:', JSON.stringify(pByType));
  console.log('Matched+nonDup:', periodLeads.filter(l=>l.matched_campaign_id && !l.is_duplicate).length);

  // ── 3. cross_analytics for March 9-15
  const crossRows = await paginate('cross_analytics', 'date, spend, leads_crm, leads_platform, campaign_name',
    q => q.gte('date', DATE_FROM).lte('date', DATE_TO));

  const crossSpend = crossRows.reduce((s,r) => s+(Number(r.spend)||0), 0);
  const crossLeadsCrm = crossRows.reduce((s,r) => s+(Number(r.leads_crm)||0), 0);
  const crossLeadsPlatform = crossRows.reduce((s,r) => s+(Number(r.leads_platform)||0), 0);

  console.log('\n=== cross_analytics for', DATE_FROM, '-', DATE_TO, '===');
  console.log('Rows:', crossRows.length);
  console.log('Spend:', crossSpend.toFixed(2));
  console.log('leads_crm:', crossLeadsCrm, '← what dashboard shows as "Leads"');
  console.log('leads_platform:', crossLeadsPlatform, '← Facebook-reported leads');

  // ── 4. creative_stats for March 9-15
  const csRows = await paginate('creative_stats', 'date, spend, leads',
    q => q.gte('date', DATE_FROM).lte('date', DATE_TO));
  const csByDate = {};
  for (const r of csRows) {
    if (!csByDate[r.date]) csByDate[r.date] = { spend: 0, leads: 0, rows: 0 };
    csByDate[r.date].spend += Number(r.spend)||0;
    csByDate[r.date].leads += Number(r.leads)||0;
    csByDate[r.date].rows++;
  }
  console.log('\n=== creative_stats for', DATE_FROM, '-', DATE_TO, '===');
  console.log('Total rows:', csRows.length);
  const csSpend = csRows.reduce((s,r)=>s+(Number(r.spend)||0),0);
  const csLeads = csRows.reduce((s,r)=>s+(Number(r.leads)||0),0);
  console.log('Total spend:', csSpend.toFixed(2));
  console.log('Total leads (FB platform):', csLeads);
  console.log('Per day:');
  Object.entries(csByDate).sort(([a],[b])=>a.localeCompare(b)).forEach(([d,v])=>{
    console.log(`  ${d}  spend=$${v.spend.toFixed(2)}  leads=${v.leads}  rows=${v.rows}`);
  });

  // ── 5. Also check March 2-8 (the $25 vs $969 issue)
  const cs28 = await paginate('creative_stats', 'date, spend',
    q => q.gte('date', '2026-03-02').lte('date', '2026-03-08'));
  const spend28 = cs28.reduce((s,r)=>s+(Number(r.spend)||0),0);
  const byDate28 = {};
  for (const r of cs28) { byDate28[r.date] = (byDate28[r.date]||0) + (Number(r.spend)||0); }
  console.log('\n=== creative_stats for 2026-03-02 - 2026-03-08 ===');
  console.log('Total rows:', cs28.length);
  console.log('Total spend:', spend28.toFixed(2));
  Object.entries(byDate28).sort(([a],[b])=>a.localeCompare(b)).forEach(([d,s])=>{
    console.log(`  ${d}  $${s.toFixed(2)}`);
  });

  const cross28 = await paginate('cross_analytics', 'date, spend, leads_crm',
    q => q.gte('date', '2026-03-02').lte('date', '2026-03-08'));
  const crossSpend28 = cross28.reduce((s,r)=>s+(Number(r.spend)||0),0);
  console.log('cross_analytics spend for Mar 2-8:', crossSpend28.toFixed(2));
}

main().catch(console.error);
