const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const CLIENT_ID = 'ae76d154-18b5-413f-a83b-3a1d9b09a3d5';

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
  // ── 1. creative_stats: date coverage + spend per account ──────────────
  const cs = await paginate('creative_stats',
    'date, spend, ad_account_id, platform, ad_name, campaign_id',
    null);
  console.log('=== creative_stats: total rows', cs.length, '===');

  // Dates coverage
  const csDates = {};
  const csByAccount = {};
  for (const r of cs) {
    csDates[r.date] = (csDates[r.date]||0) + (Number(r.spend)||0);
    const k = r.ad_account_id;
    if (!csByAccount[k]) csByAccount[k] = { spend:0, rows:0, minDate:'9999', maxDate:'0000' };
    csByAccount[k].spend += Number(r.spend)||0;
    csByAccount[k].rows++;
    if (r.date < csByAccount[k].minDate) csByAccount[k].minDate = r.date;
    if (r.date > csByAccount[k].maxDate) csByAccount[k].maxDate = r.date;
  }
  console.log('By ad_account:');
  Object.entries(csByAccount).forEach(([id, v]) => {
    console.log(`  ${id}: $${v.spend.toFixed(2)}, ${v.rows} rows, dates:${v.minDate}→${v.maxDate}`);
  });

  // ── 2. creative_stats Mar 2-8 ──────────────────────────────────────────
  const cs28 = cs.filter(r => r.date >= '2026-03-02' && r.date <= '2026-03-08');
  console.log('\n=== creative_stats Mar 2-8 ===');
  console.log('Rows:', cs28.length);
  console.log('Spend:', cs28.reduce((s,r)=>s+(Number(r.spend)||0),0).toFixed(2));
  // By date
  const byDate28 = {};
  for (const r of cs28) {
    byDate28[r.date] = (byDate28[r.date]||0) + (Number(r.spend)||0);
  }
  Object.entries(byDate28).sort(([a],[b])=>a.localeCompare(b))
    .forEach(([d,s])=>console.log(`  ${d}: $${s.toFixed(2)}`));

  // ── 3. creative_stats Mar 9-15 (should be correct) ────────────────────
  const cs915 = cs.filter(r => r.date >= '2026-03-09' && r.date <= '2026-03-15');
  console.log('\n=== creative_stats Mar 9-15 ===');
  console.log('Rows:', cs915.length);
  console.log('Spend:', cs915.reduce((s,r)=>s+(Number(r.spend)||0),0).toFixed(2));
  const byDate915 = {};
  for (const r of cs915) {
    byDate915[r.date] = (byDate915[r.date]||0) + (Number(r.spend)||0);
  }
  Object.entries(byDate915).sort(([a],[b])=>a.localeCompare(b))
    .forEach(([d,s])=>console.log(`  ${d}: $${s.toFixed(2)}`));

  // ── 4. campaign_stats: same comparison ─────────────────────────────────
  const camps28 = await paginate('campaign_stats',
    'date, spend, campaign_name, ad_account_id',
    q => q.gte('date','2026-03-02').lte('date','2026-03-08'));
  console.log('\n=== campaign_stats Mar 2-8 ===');
  console.log('Rows:', camps28.length, 'Spend:', camps28.reduce((s,r)=>s+(Number(r.spend)||0),0).toFixed(2));
  const campByDate = {};
  for (const r of camps28) {
    campByDate[r.date] = (campByDate[r.date]||0) + (Number(r.spend)||0);
  }
  Object.entries(campByDate).sort(([a],[b])=>a.localeCompare(b))
    .forEach(([d,s])=>console.log(`  ${d}: $${s.toFixed(2)}`));

  const camps915 = await paginate('campaign_stats',
    'date, spend, campaign_name, ad_account_id',
    q => q.gte('date','2026-03-09').lte('date','2026-03-15'));
  console.log('\n=== campaign_stats Mar 9-15 ===');
  console.log('Rows:', camps915.length, 'Spend:', camps915.reduce((s,r)=>s+(Number(r.spend)||0),0).toFixed(2));
  const campByDate915 = {};
  for (const r of camps915) {
    campByDate915[r.date] = (campByDate915[r.date]||0) + (Number(r.spend)||0);
  }
  Object.entries(campByDate915).sort(([a],[b])=>a.localeCompare(b))
    .forEach(([d,s])=>console.log(`  ${d}: $${s.toFixed(2)}`));

  // ── 5. All unique campaign names in campaign_stats ─────────────────────
  const allCamps = await paginate('campaign_stats', 'campaign_name, ad_account_id', null);
  const uniqueCamps = {};
  for (const r of allCamps) {
    const k = r.campaign_name;
    if (!uniqueCamps[k]) uniqueCamps[k] = { account: r.ad_account_id, count: 0 };
    uniqueCamps[k].count++;
  }
  console.log('\n=== UNIQUE CAMPAIGNS IN campaign_stats ===');
  Object.keys(uniqueCamps).sort().forEach(name => {
    console.log(`  [${uniqueCamps[name].account?.substring(0,12)}] ${name.substring(0,70)}`);
  });

  // ── 6. Earliest data in campaign_stats / creative_stats ────────────────
  const earliestCamp = await paginate('campaign_stats', 'date',
    q => q.order('date', {ascending:true}).limit(5));
  console.log('\nEarliest campaign_stats dates:', earliestCamp.slice(0,5).map(r=>r.date));

  const earliestCS = await paginate('creative_stats', 'date',
    q => q.order('date', {ascending:true}).limit(5));
  console.log('Earliest creative_stats dates:', earliestCS.slice(0,5).map(r=>r.date));
}

main().catch(console.error);
