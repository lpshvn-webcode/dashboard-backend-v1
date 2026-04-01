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
  // 1. Список аккаунтов с их Supabase UUID
  const { data: accounts } = await sb
    .from('ad_accounts')
    .select('id, account_id, account_name, platform, is_active, last_synced_at')
    .eq('client_id', CLIENT_ID);

  console.log('=== AD ACCOUNTS ===');
  (accounts||[]).forEach(a => {
    console.log(`  UUID:${a.id}`);
    console.log(`    FB account_id: act_${a.account_id}, name: ${a.account_name}`);
    console.log(`    last_synced_at: ${a.last_synced_at?.substring(0,19)}`);
  });

  // 2. campaign_stats по аккаунтам за разные периоды
  const periods = [
    { label: 'Jan 1 – Mar 1', from: '2026-01-01', to: '2026-03-01' },
    { label: 'Mar 2 – Mar 8', from: '2026-03-02', to: '2026-03-08' },
    { label: 'Mar 9 – Mar 15', from: '2026-03-09', to: '2026-03-15' },
  ];

  for (const p of periods) {
    const rows = await paginate('campaign_stats', 'date, spend, campaign_name, ad_account_id',
      q => q.gte('date', p.from).lte('date', p.to));
    
    const byAccount = {};
    for (const r of rows) {
      const k = r.ad_account_id;
      if (!byAccount[k]) byAccount[k] = { spend: 0, rows: 0, campaigns: new Set() };
      byAccount[k].spend += Number(r.spend)||0;
      byAccount[k].rows++;
      byAccount[k].campaigns.add(r.campaign_name);
    }
    
    console.log(`\n=== campaign_stats ${p.label} ===`);
    console.log(`Total: $${rows.reduce((s,r)=>s+(Number(r.spend)||0),0).toFixed(2)}, ${rows.length} rows`);
    for (const [id, v] of Object.entries(byAccount)) {
      const acct = (accounts||[]).find(a => a.id === id);
      const acctName = acct ? `${acct.account_name} (act_${acct.account_id})` : id.substring(0,12);
      console.log(`  [${acctName}]`);
      console.log(`    Spend: $${v.spend.toFixed(2)}, Rows: ${v.rows}`);
      console.log(`    Campaigns: ${[...v.campaigns].join(' | ')}`);
    }
  }

  // 3. creative_stats по аккаунтам
  for (const p of periods) {
    const rows = await paginate('creative_stats', 'date, spend, ad_name, ad_account_id',
      q => q.gte('date', p.from).lte('date', p.to));
    
    const byAccount = {};
    for (const r of rows) {
      const k = r.ad_account_id;
      if (!byAccount[k]) byAccount[k] = { spend: 0, rows: 0 };
      byAccount[k].spend += Number(r.spend)||0;
      byAccount[k].rows++;
    }
    
    console.log(`\n=== creative_stats ${p.label} ===`);
    console.log(`Total: $${rows.reduce((s,r)=>s+(Number(r.spend)||0),0).toFixed(2)}, ${rows.length} rows`);
    for (const [id, v] of Object.entries(byAccount)) {
      const acct = (accounts||[]).find(a => a.id === id);
      const acctName = acct ? `${acct.account_name} (act_${acct.account_id})` : id.substring(0,12);
      console.log(`  [${acctName}]: $${v.spend.toFixed(2)}, ${v.rows} rows`);
    }
  }

  // 4. Последние sync_logs
  const { data: logs } = await sb
    .from('sync_logs')
    .select('type, status, records_synced, started_at, error_message')
    .eq('client_id', CLIENT_ID)
    .eq('type', 'facebook')
    .order('started_at', { ascending: false })
    .limit(10);

  console.log('\n=== ПОСЛЕДНИЕ FB SYNC LOGS ===');
  (logs||[]).forEach(l => {
    const ts = l.started_at?.substring(0,19);
    const err = l.error_message ? ` ERR:${l.error_message.substring(0,80)}` : '';
    console.log(`  [${ts}] ${l.status} records:${l.records_synced}${err}`);
  });
}

main().catch(console.error);
