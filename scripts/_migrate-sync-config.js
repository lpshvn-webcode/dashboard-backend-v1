const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function main() {
  // Add sync_config column to crm_connections
  const { error } = await sb.rpc('exec_sql', {
    sql: `ALTER TABLE crm_connections ADD COLUMN IF NOT EXISTS sync_config JSONB DEFAULT NULL;`
  });
  if (error) {
    // Try direct approach
    console.log('rpc failed, trying direct REST...', error.message);
  } else {
    console.log('Migration done');
  }
}
main().catch(console.error);
