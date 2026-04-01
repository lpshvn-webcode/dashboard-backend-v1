/**
 * Diagnostic script: shows exactly which CRM leads are counted in the dashboard.
 *
 * Run:
 *   SUPABASE_URL=https://iecwxlhneczgxebbcpel.supabase.co \
 *   SUPABASE_SERVICE_KEY=<your_service_role_key_from_railway> \
 *   npx ts-node scripts/diagnose-leads.ts [dateFrom] [dateTo] [clientId]
 *
 * Example:
 *   SUPABASE_SERVICE_KEY=xxx npx ts-node scripts/diagnose-leads.ts 2026-03-09 2026-03-15
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://iecwxlhneczgxebbcpel.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

if (!SUPABASE_SERVICE_KEY) {
  console.error('❌ Set SUPABASE_SERVICE_KEY env var (get it from Railway → Variables)');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const DATE_FROM  = process.argv[2] || '2026-03-09';
const DATE_TO    = process.argv[3] || '2026-03-15';
const CLIENT_ARG = process.argv[4] || null;

function hr(char = '─', n = 70) { return char.repeat(n); }
function fmt(n: number, dec = 2) { return n.toFixed(dec); }

async function main() {
  console.log('\n' + hr('═'));
  console.log(`  LEADS DIAGNOSTIC   ${DATE_FROM} → ${DATE_TO}`);
  console.log(hr('═') + '\n');

  // ── 1. List clients ──────────────────────────────────────────────────────
  const { data: clients } = await supabase.from('clients').select('id, project_name');
  if (!clients?.length) { console.error('No clients found'); process.exit(1); }

  const client = CLIENT_ARG
    ? clients.find(c => c.id === CLIENT_ARG || c.project_name?.toLowerCase().includes(CLIENT_ARG.toLowerCase()))
    : clients[0];

  if (!client) {
    console.log('Available clients:');
    clients.forEach(c => console.log(`  ${c.id}  ${c.project_name}`));
    process.exit(1);
  }

  console.log(`Client: ${client.project_name} (${client.id})\n`);

  // ── 2. crm_leads breakdown for date range ────────────────────────────────
  const { data: leads } = await supabase
    .from('crm_leads')
    .select('id, lead_id, lead_name, record_type, is_duplicate, matched_campaign_id, matched_adset_id, matched_ad_id, created_at_crm, utm_source, utm_medium, utm_campaign, utm_content, utm_term')
    .eq('client_id', client.id)
    .gte('created_at_crm', DATE_FROM)
    .lte('created_at_crm', DATE_TO + 'T23:59:59');

  const all = leads || [];
  const byType:  Record<string, number> = {};
  const byDup:   Record<string, number> = { 'duplicate': 0, 'unique': 0 };
  let matched = 0, matchedNonDup = 0, matchedDeals = 0, matchedLeads = 0;

  for (const r of all) {
    byType[r.record_type || 'unknown'] = (byType[r.record_type || 'unknown'] || 0) + 1;
    if (r.is_duplicate) byDup.duplicate++; else byDup.unique++;
    if (r.matched_campaign_id) {
      matched++;
      if (!r.is_duplicate) {
        matchedNonDup++;
        if (r.record_type === 'deal') matchedDeals++;
        if (r.record_type === 'lead') matchedLeads++;
      }
    }
  }

  console.log(hr());
  console.log('CRM LEADS  (created_at_crm in range, all records)');
  console.log(hr());
  console.log(`  Total records     : ${all.length}`);
  Object.entries(byType).forEach(([t, n]) => console.log(`    ${t.padEnd(10)}: ${n}`));
  console.log(`  Duplicates        : ${byDup.duplicate}`);
  console.log(`  Unique (non-dup)  : ${byDup.unique}`);
  console.log(`  Has UTM match     : ${matched}`);
  console.log(`  Matched + non-dup : ${matchedNonDup}  ← what builder uses (ALL)`);
  console.log(`    of which deals  : ${matchedDeals}   ← what NEW builder uses (only deals)`);
  console.log(`    of which leads  : ${matchedLeads}`);

  // ── 3. Show unmatched leads (no matched_campaign_id) ────────────────────
  const unmatched = all.filter(r => !r.matched_campaign_id && !r.is_duplicate);
  if (unmatched.length > 0) {
    console.log(`\n${hr()}`);
    console.log(`UNMATCHED non-duplicate records (${unmatched.length}) — sample up to 10`);
    console.log(hr());
    unmatched.slice(0, 10).forEach(r => {
      const utms = [r.utm_source, r.utm_campaign, r.utm_content].filter(Boolean).join(' | ');
      console.log(`  [${r.record_type}] ${r.lead_name || r.lead_id}  UTMs: ${utms || '(none)'}`);
    });
  }

  // ── 4. Show matched non-dup records grouped by type ─────────────────────
  const countedDeals  = all.filter(r => r.matched_campaign_id && !r.is_duplicate && r.record_type === 'deal');
  const countedLeads  = all.filter(r => r.matched_campaign_id && !r.is_duplicate && r.record_type === 'lead');

  if (countedDeals.length > 0) {
    console.log(`\n${hr()}`);
    console.log(`MATCHED DEALS — will be counted in NEW builder (${countedDeals.length})`);
    console.log(hr());
    countedDeals.slice(0, 15).forEach(r => {
      const date = r.created_at_crm ? r.created_at_crm.substring(0, 10) : '?';
      console.log(`  ${date}  ${(r.lead_name || r.lead_id || '').substring(0, 35).padEnd(35)}  → ${(r.matched_campaign_id || '').substring(0, 30)}`);
    });
    if (countedDeals.length > 15) console.log(`  ... and ${countedDeals.length - 15} more`);
  }

  if (countedLeads.length > 0) {
    console.log(`\n${hr()}`);
    console.log(`MATCHED LEADS (record_type='lead') — EXCLUDED in new builder (${countedLeads.length})`);
    console.log(hr());
    countedLeads.slice(0, 15).forEach(r => {
      const date = r.created_at_crm ? r.created_at_crm.substring(0, 10) : '?';
      const dup  = r.is_duplicate ? ' [DUP]' : '';
      console.log(`  ${date}  ${(r.lead_name || r.lead_id || '').substring(0, 35).padEnd(35)}${dup}  → ${(r.matched_campaign_id || '').substring(0, 30)}`);
    });
    if (countedLeads.length > 15) console.log(`  ... and ${countedLeads.length - 15} more`);
  }

  // ── 5. cross_analytics for the same range ───────────────────────────────
  const { data: crossRows } = await supabase
    .from('cross_analytics')
    .select('spend, leads_crm, campaign_name')
    .eq('client_id', client.id)
    .gte('date', DATE_FROM)
    .lte('date', DATE_TO);

  const crossSpend = (crossRows || []).reduce((s, r) => s + (Number(r.spend) || 0), 0);
  const crossLeads = (crossRows || []).reduce((s, r) => s + (Number(r.leads_crm) || 0), 0);

  console.log(`\n${hr()}`);
  console.log('CROSS_ANALYTICS CURRENT STATE (before rebuild)');
  console.log(hr());
  console.log(`  Rows              : ${(crossRows || []).length}`);
  console.log(`  Spend             : $${fmt(crossSpend)}`);
  console.log(`  leads_crm         : ${crossLeads}  ← this is what the dashboard shows`);

  // ── 6. creative_stats coverage ──────────────────────────────────────────
  const { data: creativeStats } = await supabase
    .from('creative_stats')
    .select('date, spend')
    .eq('client_id', client.id)
    .gte('date', DATE_FROM)
    .lte('date', DATE_TO);

  const csByDate: Record<string, number> = {};
  for (const r of creativeStats || []) {
    csByDate[r.date] = (csByDate[r.date] || 0) + (Number(r.spend) || 0);
  }
  const csSpend = Object.values(csByDate).reduce((a, b) => a + b, 0);

  console.log(`\n${hr()}`);
  console.log('CREATIVE_STATS (raw FB data for the range)');
  console.log(hr());
  console.log(`  Rows              : ${(creativeStats || []).length}`);
  console.log(`  Days with data    : ${Object.keys(csByDate).length}`);
  console.log(`  Total spend       : $${fmt(csSpend)}`);
  if (Object.keys(csByDate).length > 0) {
    console.log('  Per day:');
    Object.entries(csByDate).sort(([a], [b]) => a.localeCompare(b)).forEach(([date, spend]) => {
      console.log(`    ${date}  $${fmt(spend)}`);
    });
  }

  // ── 7. Verdict ──────────────────────────────────────────────────────────
  console.log(`\n${hr('═')}`);
  console.log('VERDICT');
  console.log(hr('═'));

  if (byType['lead'] > 0 && byType['deal'] > 0) {
    console.log(`⚠️  LEADS discrepancy confirmed: ${byType['lead']} leads + ${byType['deal']} deals in CRM.`);
    console.log(`   Dashboard was showing: ${crossLeads} (old, both types counted)`);
    console.log(`   After rebuild will show: ~${matchedDeals} (deals only)`);
  } else {
    console.log(`✅ Single record type — no double-count risk. Dashboard shows ${crossLeads}.`);
  }

  if (csSpend < 10 && csSpend < crossSpend * 0.1) {
    console.log(`⚠️  SPEND discrepancy: creative_stats has $${fmt(csSpend)} but cross_analytics $${fmt(crossSpend)}.`);
    console.log(`   Likely stale data. Trigger FB resync (daysBack=90) then rebuild.`);
  } else if (csSpend > 0 && Math.abs(csSpend - crossSpend) / csSpend > 0.05) {
    console.log(`⚠️  SPEND mismatch: creative_stats=$${fmt(csSpend)} vs cross_analytics=$${fmt(crossSpend)}.`);
    console.log(`   Rebuild cross_analytics to sync.`);
  } else {
    console.log(`✅ Spend looks consistent: creative_stats=$${fmt(csSpend)}, cross_analytics=$${fmt(crossSpend)}.`);
  }

  if (Object.keys(csByDate).length === 0) {
    console.log(`⚠️  No creative_stats data at all for ${DATE_FROM}–${DATE_TO}. Need FB resync!`);
  }

  console.log('\n' + hr('═') + '\n');
}

main().catch(err => {
  console.error('Script error:', err.message);
  process.exit(1);
});
