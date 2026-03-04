import axios from 'axios';
import { supabase } from '../lib/supabase';
import { CrmConnection, CrmLead } from '../types/database';

async function refreshBitrixToken(connection: CrmConnection): Promise<string> {
  const response = await axios.get('https://oauth.bitrix.info/oauth/token/', {
    params: {
      grant_type: 'refresh_token',
      client_id: process.env.BITRIX24_CLIENT_ID,
      client_secret: process.env.BITRIX24_CLIENT_SECRET,
      refresh_token: connection.refresh_token,
    },
  });

  const { access_token, refresh_token, expires_in } = response.data;
  const expiresAt = new Date(Date.now() + expires_in * 1000).toISOString();

  await supabase
    .from('crm_connections')
    .update({ access_token, refresh_token, token_expires_at: expiresAt })
    .eq('id', connection.id);

  return access_token;
}

interface BitrixLead {
  ID: string;
  TITLE: string;
  STATUS_ID: string;
  SOURCE_ID?: string;
  ASSIGNED_BY_NAME?: string;
  DATE_CREATE: string;
  DATE_CLOSED?: string;
  OPPORTUNITY?: string;
  CURRENCY_ID?: string;
  UTM_SOURCE?: string;
  UTM_MEDIUM?: string;
  UTM_CAMPAIGN?: string;
  UTM_CONTENT?: string;
  UTM_TERM?: string;
}

export async function syncBitrix24(connection: CrmConnection, since?: Date) {
  console.log(`[Bitrix24] Syncing ${connection.domain}`);

  // Webhook mode: access_token is empty, domain is the full webhook path
  // e.g. "b24-xxx.bitrix24.ru/rest/1/xxxxxx/"
  // OAuth mode: access_token is set, domain is just the hostname
  const isWebhook = !connection.access_token;

  let accessToken = connection.access_token;
  if (!isWebhook && connection.token_expires_at && new Date(connection.token_expires_at) < new Date(Date.now() + 5 * 60 * 1000)) {
    accessToken = await refreshBitrixToken(connection);
  }

  // Webhook: baseUrl = full webhook URL (already contains auth path)
  // OAuth:   baseUrl = https://domain/rest  (auth via query param)
  const baseUrl = isWebhook
    ? `https://${connection.domain.replace(/\/$/, '')}`
    : `https://${connection.domain}/rest`;
  const authParams = isWebhook ? {} : { auth: accessToken };

  const leads: CrmLead[] = [];
  let start = 0;

  const filterParams: Record<string, string> = {};
  if (since) {
    filterParams['>=DATE_CREATE'] = since.toISOString();
  }

  while (true) {
    const res = await axios.get(`${baseUrl}/crm.lead.list`, {
      params: {
        ...authParams,
        SELECT: [
          'ID', 'TITLE', 'STATUS_ID', 'SOURCE_ID',
          'ASSIGNED_BY_NAME', 'DATE_CREATE', 'DATE_CLOSED',
          'OPPORTUNITY', 'CURRENCY_ID',
          'UTM_SOURCE', 'UTM_MEDIUM', 'UTM_CAMPAIGN', 'UTM_CONTENT', 'UTM_TERM',
        ],
        FILTER: filterParams,
        start,
      },
    });

    const items: BitrixLead[] = res.data.result || [];
    if (items.length === 0) break;

    for (const item of items) {
      leads.push({
        id: '',
        crm_connection_id: connection.id,
        client_id: connection.client_id,
        crm_type: 'bitrix24',
        lead_id: item.ID,
        lead_name: item.TITLE,
        status: item.STATUS_ID,
        responsible_name: item.ASSIGNED_BY_NAME,
        created_at_crm: new Date(item.DATE_CREATE).toISOString(),
        closed_at: item.DATE_CLOSED ? new Date(item.DATE_CLOSED).toISOString() : undefined,
        price: item.OPPORTUNITY ? parseFloat(item.OPPORTUNITY) : undefined,
        currency: item.CURRENCY_ID,
        utm_source: item.UTM_SOURCE,
        utm_medium: item.UTM_MEDIUM,
        utm_campaign: item.UTM_CAMPAIGN,
        utm_content: item.UTM_CONTENT,
        utm_term: item.UTM_TERM,
        created_at: '',
      });
    }

    const total = res.data.total;
    start += items.length;
    if (start >= total) break;
  }

  if (leads.length > 0) {
    const { error } = await supabase
      .from('crm_leads')
      .upsert(
        leads.map(({ id, created_at, ...rest }) => rest),
        { onConflict: 'crm_connection_id,lead_id' }
      );
    if (error) console.error('[Bitrix24] Upsert error:', error.message);
    else console.log(`[Bitrix24] Upserted ${leads.length} leads`);
  }

  await supabase
    .from('crm_connections')
    .update({ last_synced_at: new Date().toISOString() })
    .eq('id', connection.id);

  return { leads: leads.length };
}

// Handle incoming webhook from Bitrix24
export function parseBitrixWebhook(body: any, connectionId: string, clientId: string): Partial<CrmLead> | null {
  // Bitrix24 sends event name in 'event' field
  const data = body.data?.FIELDS || body.FIELDS;
  if (!data?.ID) return null;

  return {
    crm_connection_id: connectionId,
    client_id: clientId,
    crm_type: 'bitrix24',
    lead_id: data.ID.toString(),
  };
}
