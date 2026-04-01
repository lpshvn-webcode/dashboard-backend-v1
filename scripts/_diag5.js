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
  // ── 1. Ad accounts for this client ─────────────────────────────────────
  const { data: accounts } = await sb
    .from('ad_accounts')
    .select('id, platform, account_id, account_name, last_synced_at, is_active')
    .eq('client_id', CLIENT_ID);

  console.log('=== AD ACCOUNTS ===');
  (accounts||[]).forEach(a => {
    console.log(`  [${a.platform}] ${a.account_name} (${a.account_id}) active:${a.is_active} last_synced:${a.last_synced_at?.substring(0,19)}`);
  });

  // ── 2. creative_stats coverage by account + date ────────────────────────
  const cs = await paginate('creative_stats', 'date, spend, ad_account_id, platform, campaign_name', null);
  console.log('\n=== creative_stats: total rows', cs.length, '===');

  // Group by account
  const byAccount = {};
  for (const r of cs) {
    const k = r.ad_account_id;
    if (!byAccount[k]) byAccount[k] = { spend: 0, rows: 0, dates: new Set(), campaigns: new Set() };
    byAccount[k].spend += Number(r.spend)||0;
    byAccount[k].rows++;
    byAccount[k].dates.add(r.date);
    byAccount[k].campaigns.add(r.campaign_name);
  }
  console.log('By ad_account_id:');
  Object.entries(byAccount).forEach(([id, v]) => {
    const dateArr = [...v.dates].sort();
    console.log(`  ${id}: $${v.spend.toFixed(2)}, ${v.rows} rows, ${dateArr.length} dates (${dateArr[0]} → ${dateArr[dateArr.length-1]}), ${v.campaigns.size} campaigns`);
  });

  // ── 3. creative_stats for March 2-8, all campaigns and their spend ─────
  const cs28 = cs.filter(r => r.date >= '2026-03-02' && r.date <= '2026-03-08');
  console.log('\n=== creative_stats Mar 2-8: total rows', cs28.length, '===');
  console.log('Total spend:', cs28.reduce((s,r)=>s+(Number(r.spend)||0),0).toFixed(2));

  const byCamp = {};
  for (const r of cs28) {
    const k = r.campaign_name || '(unknown)';
    if (!byCamp[k]) byCamp[k] = { spend: 0, rows: 0, dates: new Set(), account: r.ad_account_id };
    byCamp[k].spend += Number(r.spend)||0;
    byCamp[k].rows++;
    byCamp[k].dates.add(r.date);
  }
  console.log('By campaign:');
  Object.entries(byCamp).sort(([,a],[,b])=>b.spend-a.spend).forEach(([name, v]) => {
    const dates = [...v.dates].sort();
    console.log(`  $${v.spend.toFixed(2).padStart(8)}  ${name.substring(0,50)}  (${dates[0]}→${dates[dates.length-1]}, ${v.rows} rows, acct:${v.account?.substring(0,8)})`);
  });

  // ── 4. Compare with campaign_stats for the same period ─────────────────
  const campStats = await paginate('campaign_stats', 'date, spend, campaign_name, platform, campaign_id',
    q => q.gte('date', '2026-03-02').lte('date', '2026-03-08'));

  console.log('\n=== campaign_stats Mar 2-8: total rows', campStats.length, '===');
  console.log('Total spend:', campStats.reduce((s,r)=>s+(Number(r.spend)||0),0).toFixed(2));

  const byCampCS = {};
  for (const r of campStats) {
    const k = r.campaign_name || '(unknown)';
    if (!byCampCS[k]) byCampCS[k] = { spend: 0, rows: 0, dates: new Set() };
    byCampCS[k].spend += Number(r.spend)||0;
    byCampCS[k].rows++;
    byCampCS[k].dates.add(r.date);
  }
  console.log('By campaign:');
  Object.entries(byCampCS).sort(([,a],[,b])=>b.spend-a.spend).forEach(([name, v]) => {
    const dates = [...v.dates].sort();
    console.log(`  $${v.spend.toFixed(2).padStart(8)}  ${name.substring(0,50)}  (${dates[0]}→${dates[dates.length-1]}, ${v.rows} rows)`);
  });

  // ── 5. Adset_stats for Mar 2-8 ─────────────────────────────────────────
  const adsetStats = await paginate('adset_stats', 'date, spend, campaign_name',
    q => q.gte('date', '2026-03-02').lte('date', '2026-03-08'));
  console.log('\n=== adset_stats Mar 2-8: total rows', adsetStats.length, '===');
  console.log('Total spend:', adsetStats.reduce((s,r)=>s+(Number(r.spend)||0),0).toFixed(2));

  // ── 6. sync_logs to understand what syncs happened ─────────────────────
  const { data: logs } = await sb
    .from('sync_logs')
    .select('type, status, records_synced, started_at, error_message')
    .eq('client_id', CLIENT_ID)
    .order('started_at', { ascending: false })
    .limit(20);

  console.log('\n=== SYNC LOGS (last 20) ===');
  (logs||[]).forEach(l => {
    const ts = l.started_at?.substring(0,19);
    const err = l.error_message ? ` ERR:${l.error_message.substring(0,60)}` : '';
    console.log(`  [${ts}] ${l.type} ${l.status} records:${l.records_synced}${err}`);
  });
}

main().catch(console.error);
