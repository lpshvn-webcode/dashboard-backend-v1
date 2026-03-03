import { Router } from 'express';
import { supabase } from '../lib/supabase';
import { parseAmoWebhook } from '../services/amocrm';
import { parseBitrixWebhook } from '../services/bitrix24';
import { syncAmoCRM } from '../services/amocrm';
import { syncBitrix24 } from '../services/bitrix24';

const router = Router();

// POST /api/webhooks/amocrm/:connectionId
router.post('/amocrm/:connectionId', async (req, res) => {
  const { connectionId } = req.params;

  const { data: connection, error } = await supabase
    .from('crm_connections')
    .select('*')
    .eq('id', connectionId)
    .eq('type', 'amocrm')
    .single();

  if (error || !connection) {
    return res.status(404).json({ error: 'Connection not found' });
  }

  // AmoCRM sends lead data in the body
  const partialLead = parseAmoWebhook(req.body);

  if (partialLead?.lead_id) {
    // Trigger a full re-sync for this CRM to get latest data
    // (AmoCRM webhooks don't include all UTM fields)
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000); // last 24h
    syncAmoCRM(connection as any, since).catch(console.error);
  }

  res.json({ ok: true });
});

// POST /api/webhooks/bitrix24/:connectionId
router.post('/bitrix24/:connectionId', async (req, res) => {
  const { connectionId } = req.params;

  const { data: connection, error } = await supabase
    .from('crm_connections')
    .select('*')
    .eq('id', connectionId)
    .eq('type', 'bitrix24')
    .single();

  if (error || !connection) {
    return res.status(404).json({ error: 'Connection not found' });
  }

  const partialLead = parseBitrixWebhook(req.body, connectionId, connection.client_id);

  if (partialLead?.lead_id) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    syncBitrix24(connection as any, since).catch(console.error);
  }

  res.json({ ok: true });
});

export default router;
