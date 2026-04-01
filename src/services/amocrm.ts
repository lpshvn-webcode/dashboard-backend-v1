import axios from 'axios';
import { supabase } from '../lib/supabase';
import { CrmConnection, CrmLead } from '../types/database';
import { normalizePhone } from '../utils/phone';

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

export async function syncAmoCRM(
  connection: CrmConnection,
  since?: Date,
  onProgress?: (step: string, progress: number) => void,
) {
  const progress = onProgress || (() => {});
  console.log(`[AmoCRM] Syncing ${connection.domain}`);
  progress('Подключение к AmoCRM...', 5);

  let accessToken = connection.access_token;
  if (connection.token_expires_at && new Date(connection.token_expires_at) < new Date(Date.now() + 5 * 60 * 1000)) {
    accessToken = await refreshAmoToken(connection);
  }

  const headers = { Authorization: `Bearer ${accessToken}` };
  const baseUrl = `https://${connection.domain}/api/v4`;

  // Load pipelines for name resolution
  progress('Загрузка воронок...', 15);
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
  progress('Выгрузка лидов...', 30);

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
        phone: normalizePhone(lead.custom_fields_values?.find(f => f.field_code === 'PHONE')?.values?.[0]?.value),
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
    progress(`Загружено ${leads.length} лидов...`, Math.min(30 + page * 5, 75));
  }

  progress('Сохранение в базу данных...', 85);
  if (leads.length > 0) {
    const { error } = await supabase
      .from('crm_leads')
      .upsert(
        leads.map(({ id, created_at, ...rest }) => rest),
        { onConflict: 'crm_connection_id,lead_id' }
      );
    if (error) {
      console.error('[AmoCRM] Upsert error:', error.message);
    } else {
      console.log(`[AmoCRM] Upserted ${leads.length} leads`);
      progress(`Сохранено ${leads.length} лидов`, 90);
    }
  }

  progress('Завершение...', 100);
  await supabase
    .from('crm_connections')
    .update({ last_synced_at: new Date().toISOString() })
    .eq('id', connection.id);

  return { leads: leads.length };
}

// ── Fetch pipeline stages from AmoCRM ──────────────────────────────────────────

export async function fetchAmoCrmStages(connection: CrmConnection): Promise<{
  pipelines: Array<{ id: string; name: string; type: 'deal' | 'lead'; stages: Array<{ id: string; name: string; semantics: string }> }>
}> {
  let accessToken = connection.access_token;
  if (connection.token_expires_at && new Date(connection.token_expires_at) < new Date(Date.now() + 5 * 60 * 1000)) {
    accessToken = await refreshAmoToken(connection);
  }

  const headers = { Authorization: `Bearer ${accessToken}` };
  const baseUrl = `https://${connection.domain}/api/v4`;

  const res = await axios.get(`${baseUrl}/leads/pipelines`, {
    headers,
    params: { with: 'statuses', limit: 250 },
    timeout: 15000,
  });

  const amoPipelines: any[] = res.data?._embedded?.pipelines || [];

  const pipelines = amoPipelines.map((pipeline: any) => {
    const statuses: Array<{ id: string; name: string; semantics: string }> =
      (pipeline._embedded?.statuses || []).map((s: any) => ({
        id: String(s.id),
        name: String(s.name),
        // AmoCRM type: 0=normal, 1=won, 2=lost
        semantics: s.type === 1 ? 'S' : s.type === 2 ? 'F' : '',
      }));

    return {
      id: `pipeline_${pipeline.id}`,
      name: String(pipeline.name),
      type: 'deal' as const,
      stages: statuses,
    };
  });

  return { pipelines };
}

/**
 * Fetch enum options for a custom field by its name (case-insensitive substring search).
 * Calls GET /api/v4/leads/custom_fields to list all fields, finds the matching one by name,
 * then returns its enum values.
 */
export async function fetchAmoCrmFieldOptions(
  connection: CrmConnection,
  fieldName: string,
): Promise<{ options: Array<{ id: string; value: string }> }> {
  let accessToken = connection.access_token;
  if (connection.token_expires_at && new Date(connection.token_expires_at) < new Date(Date.now() + 5 * 60 * 1000)) {
    accessToken = await refreshAmoToken(connection);
  }

  const searchLower = fieldName.toLowerCase().trim();

  // Fetch all custom fields for leads
  const res = await axios.get(`https://${connection.domain}/api/v4/leads/custom_fields`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    params: { limit: 250 },
    timeout: 15000,
  });

  const fields: any[] = res.data?._embedded?.custom_fields || [];
  const field = fields.find(f => String(f.name || '').toLowerCase().includes(searchLower));

  if (!field) {
    console.warn(`[AmoCRM] No custom field with name containing "${fieldName}"`);
    return { options: [] };
  }

  console.log(`[AmoCRM] Found field "${field.name}" (id=${field.id})`);
  const values: any[] = field.values || [];
  return {
    options: values.map((v: any) => ({
      id: String(v.id ?? v.enum_id ?? v.value),
      value: String(v.value),
    })),
  };
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
