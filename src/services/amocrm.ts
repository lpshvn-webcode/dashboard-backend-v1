import axios from 'axios';
import { supabase } from '../lib/supabase';
import { CrmConnection, CrmLead } from '../types/database';

async function refreshAmoToken(connection: CrmConnection): Promise<string> {
  const response = await axios.post(`https://${connection.domain}/oauth2/access_token`, {
    client_id: process.env.AMOCRM_CLIENT_ID,
    client_secret: process.env.AMOCRM_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: connection.refresh_token,
    redirect_uri: process.env.AMOCRM_REDIRECT_URI,
  });

  const { access_token, refresh_token, expires_in } = response.data;
  const expiresAt = new Date(Date.now() + expires_in * 1000).toISOString();

  await supabase
    .from('crm_connections')
    .update({ access_token, refresh_token, token_expires_at: expiresAt })
    .eq('id', connection.id);

  return access_token;
}

interface AmoLead {
  id: number;
  name: string;
  status_id: number;
  pipeline_id: number;
  price: number;
  created_at: number;
  closed_at: number | null;
  responsible_user_id: number;
  custom_fields_values?: Array<{
    field_code: string;
    values: Array<{ value: string }>;
  }>;
  _embedded?: {
    contacts?: Array<{ id: number; name: string }>;
  };
}

function extractUtm(lead: AmoLead) {
  const utm: Record<string, string> = {};
  if (!lead.custom_fields_values) return utm;

  const utmMap: Record<string, string> = {
    'UTM_SOURCE': 'utm_source',
    'UTM_MEDIUM': 'utm_medium',
    'UTM_CAMPAIGN': 'utm_campaign',
    'UTM_CONTENT': 'utm_content',
    'UTM_TERM': 'utm_term',
  };

  for (const field of lead.custom_fields_values) {
    const key = utmMap[field.field_code];
    if (key && field.values?.[0]?.value) {
      utm[key] = field.values[0].value;
    }
  }
  return utm;
}

export async function syncAmoCRM(connection: CrmConnection, since?: Date) {
  console.log(`[AmoCRM] Syncing ${connection.domain}`);

  let accessToken = connection.access_token;
  if (connection.token_expires_at && new Date(connection.token_expires_at) < new Date(Date.now() + 5 * 60 * 1000)) {
    accessToken = await refreshAmoToken(connection);
  }

  const headers = { Authorization: `Bearer ${accessToken}` };
  const baseUrl = `https://${connection.domain}/api/v4`;

  // Load pipelines for name resolution
  const pipelinesRes = await axios.get(`${baseUrl}/leads/pipelines`, { headers });
  const pipelines: Record<number, { name: string; statuses: Record<number, string> }> = {};
  for (const pipeline of pipelinesRes.data._embedded?.pipelines || []) {
    pipelines[pipeline.id] = {
      name: pipeline.name,
      statuses: {},
    };
    for (const status of pipeline._embedded?.statuses || []) {
      pipelines[pipeline.id].statuses[status.id] = status.name;
    }
  }

  // Load users for responsible name
  const usersRes = await axios.get(`${baseUrl}/users`, { headers });
  const users: Record<number, string> = {};
  for (const user of usersRes.data._embedded?.users || []) {
    users[user.id] = user.name;
  }

  const leads: CrmLead[] = [];
  let page = 1;
  const sinceTs = since ? Math.floor(since.getTime() / 1000) : undefined;

  while (true) {
    const params: Record<string, string | number> = {
      page,
      limit: 250,
      with: 'contacts,custom_fields',
    };
    if (sinceTs) {
      params['filter[created_at][from]'] = sinceTs;
    }

    const res = await axios.get(`${baseUrl}/leads`, { headers, params });
    const amoLeads: AmoLead[] = res.data._embedded?.leads || [];
    if (amoLeads.length === 0) break;

    for (const lead of amoLeads) {
      const utm = extractUtm(lead);
      const pipeline = pipelines[lead.pipeline_id];
      leads.push({
        id: '',
        crm_connection_id: connection.id,
        client_id: connection.client_id,
        crm_type: 'amocrm',
        lead_id: lead.id.toString(),
        lead_name: lead.name,
        status: pipeline?.statuses[lead.status_id] || lead.status_id.toString(),
        pipeline_id: lead.pipeline_id.toString(),
        pipeline_name: pipeline?.name,
        responsible_name: users[lead.responsible_user_id],
        created_at_crm: new Date(lead.created_at * 1000).toISOString(),
        closed_at: lead.closed_at ? new Date(lead.closed_at * 1000).toISOString() : undefined,
        price: lead.price || undefined,
        currency: 'KZT',
        utm_source: utm.utm_source,
        utm_medium: utm.utm_medium,
        utm_campaign: utm.utm_campaign,
        utm_content: utm.utm_content,
        utm_term: utm.utm_term,
        created_at: '',
      });
    }

    if (!res.data._links?.next) break;
    page++;
  }

  if (leads.length > 0) {
    const { error } = await supabase
      .from('crm_leads')
      .upsert(
        leads.map(({ id, created_at, ...rest }) => rest),
        { onConflict: 'crm_connection_id,lead_id' }
      );
    if (error) console.error('[AmoCRM] Upsert error:', error.message);
    else console.log(`[AmoCRM] Upserted ${leads.length} leads`);
  }

  await supabase
    .from('crm_connections')
    .update({ last_synced_at: new Date().toISOString() })
    .eq('id', connection.id);

  return { leads: leads.length };
}

// Handle incoming webhook from AmoCRM (real-time updates)
export function parseAmoWebhook(body: any): Partial<CrmLead> | null {
  const lead = body.leads?.update?.[0] || body.leads?.add?.[0];
  if (!lead) return null;

  return {
    lead_id: lead.id?.toString(),
    lead_name: lead.name,
    status: lead.status_id?.toString(),
    pipeline_id: lead.pipeline_id?.toString(),
    price: lead.price || undefined,
    closed_at: lead.closed_at ? new Date(lead.closed_at * 1000).toISOString() : undefined,
  };
}
