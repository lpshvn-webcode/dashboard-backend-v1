const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function main() {
  // List all clients
  const { data: clients } = await sb.from('clients').select('id, name, user_id');
  console.log('=== ALL CLIENTS ===');
  (clients||[]).forEach(c => console.log(c.id, '|', c.name));

  // Check crm_connections
  const { data: crm } = await sb.from('crm_connections').select('id, client_id, type, domain, sync_type, is_active');
  console.log('\n=== CRM CONNECTIONS ===');
  (crm||[]).forEach(c => console.log(c.client_id, '|', c.type, '|', c.sync_type, '|', c.domain, '| active:', c.is_active));

  // Count crm_leads per client
  const { data: leads } = await sb.from('crm_leads').select('client_id, record_type, is_duplicate, matched_campaign_id');
  const counts = {};
  for (const l of (leads||[])) {
    const k = l.client_id;
    if (!counts[k]) counts[k] = { total: 0, leads: 0, deals: 0, dups: 0, matched: 0 };
    counts[k].total++;
    if (l.record_type === 'lead') counts[k].leads++;
    if (l.record_type === 'deal') counts[k].deals++;
    if (l.is_duplicate) counts[k].dups++;
    if (l.matched_campaign_id) counts[k].matched++;
  }
  console.log('\n=== crm_leads PER CLIENT ===');
  Object.entries(counts).forEach(([id, v]) => console.log(id, JSON.stringify(v)));
}

main().catch(console.error);
