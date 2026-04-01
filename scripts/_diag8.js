const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const CLIENT_ID = 'ae76d154-18b5-413f-a83b-3a1d9b09a3d5';
const ACCT_1 = '7f88ab87-4d9e-47f3-84fe-1d55b72895df'; // act_1042955424178074 (quiz)
const ACCT_2 = '8f3bf11d-6d08-4830-a872-26a04ff55276'; // act_4030694587199998 (quiz v2)

async function main() {
  // 1. Та единственная строка для acct_1 в Mar 2-8
  const { data: oneRow } = await sb
    .from('creative_stats')
    .select('date, spend, ad_id, ad_name, campaign_id')
    .eq('client_id', CLIENT_ID)
    .eq('ad_account_id', ACCT_1)
    .gte('date', '2026-03-02')
    .lte('date', '2026-03-08');

  console.log('=== creative_stats Mar 2-8 для act_1042955424178074 ===');
  (oneRow||[]).forEach(r => {
    console.log(`  date:${r.date} spend:${r.spend} ad_id:${r.ad_id} ad_name:${r.ad_name?.substring(0,50)}`);
  });

  // 2. Последние 5 строк для acct_1 по дате (чтобы понять какие даты вообще есть)
  const { data: latestRows } = await sb
    .from('creative_stats')
    .select('date, spend, ad_id, ad_name')
    .eq('client_id', CLIENT_ID)
    .eq('ad_account_id', ACCT_1)
    .order('date', { ascending: false })
    .limit(5);

  console.log('\n=== creative_stats ПОСЛЕДНИЕ строки act_1042955424178074 ===');
  (latestRows||[]).forEach(r => {
    console.log(`  date:${r.date} spend:${r.spend} ad_id:${r.ad_id} ad_name:${r.ad_name?.substring(0,50)}`);
  });

  // 3. creative_stats acct_1 — сколько строк по датам (Feb-Mar)
  const { data: febMar } = await sb
    .from('creative_stats')
    .select('date, spend')
    .eq('client_id', CLIENT_ID)
    .eq('ad_account_id', ACCT_1)
    .gte('date', '2026-02-01')
    .lte('date', '2026-03-16')
    .order('date', { ascending: true });

  const byDate = {};
  for (const r of (febMar||[])) {
    byDate[r.date] = (byDate[r.date]||0) + (Number(r.spend)||0);
  }
  console.log('\n=== creative_stats act_1042955424178074 по дням (Feb-Mar) ===');
  Object.entries(byDate).sort(([a],[b])=>a.localeCompare(b)).forEach(([d,s]) => {
    console.log(`  ${d}: $${s.toFixed(2)}`);
  });

  // 4. Полные sync_logs (включая manual triggers) для этого клиента
  const { data: logs } = await sb
    .from('sync_logs')
    .select('type, status, records_synced, started_at, error_message')
    .eq('client_id', CLIENT_ID)
    .order('started_at', { ascending: false })
    .limit(30);

  console.log('\n=== ВСЕ SYNC LOGS (последние 30) ===');
  (logs||[]).forEach(l => {
    const ts = l.started_at?.substring(0,19);
    const err = l.error_message ? ` ERR:${l.error_message.substring(0,80)}` : '';
    console.log(`  [${ts}] ${l.type} ${l.status} records:${l.records_synced}${err}`);
  });
}

main().catch(console.error);
