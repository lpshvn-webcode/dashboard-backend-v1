import { queryCrossAnalytics } from './cross-analytics-query';

export interface CrmAnalyticsFilters {
  clientId: string;
  dateFrom: string;
  dateTo: string;
  campaignIds: string[];
  adsetIds: string[];
  creativeIds: string[];
}

export interface CrmAnalyticsSummary {
  leads: number;
  qualifiedLeads: number;
  conversionLeadToQual: number;
  spend: number;
  cpl: number;
  cplq: number;
}

export interface CrmBoardCard {
  campaignId: string;
  campaignName: string;
  count: number;
}

export interface CrmBoardColumn {
  stageKey: string;
  stageName: string;
  pipelineId?: string;
  pipelineName?: string;
  count: number;
  cards: CrmBoardCard[];
}

export interface CrmManagerStat {
  managerName: string;
  leads: number;
  qualifiedLeads: number;
  conversionLeadToQual: number;
  spend: number;
  cpl: number;
  cplq: number;
}

export interface CrmAnalyticsResult {
  summary: CrmAnalyticsSummary;
  boardColumns: CrmBoardColumn[];
  managerStats: CrmManagerStat[];
  filterOptions: {
    campaigns: Array<{ id: string; name: string }>;
    adsets: Array<{ id: string; name: string }>;
    creatives: Array<{ id: string; name: string }>;
  };
}

type StageConfig = {
  id: string;
  name?: string;
  pipelineId?: string;
  pipelineName?: string;
  isQualified?: boolean;
};

type ClientWithSettings = {
  id: string;
  settings?: {
    dealStages?: StageConfig[];
    leadStages?: StageConfig[];
  } | null;
};

type CrmLeadRow = {
  status: string | null;
  pipeline_id: string | null;
  pipeline_name: string | null;
  responsible_name: string | null;
  matched_campaign_id: string | null;
  matched_adset_id: string | null;
  matched_ad_id: string | null;
};

type MediaRow = {
  campaign_id?: string | null;
  campaign_name?: string | null;
  adset_id?: string | null;
  adset_name?: string | null;
  ad_id?: string | null;
  ad_name?: string | null;
  spend?: number | null;
};

const PAGE_SIZE = 1000;

function roundMetric(value: number): number {
  return Number.isFinite(value) ? Number(value.toFixed(2)) : 0;
}

function buildStageConfig(settings: ClientWithSettings['settings']) {
  const stageList = [
    ...(Array.isArray(settings?.dealStages) ? settings!.dealStages : []),
    ...(Array.isArray(settings?.leadStages) ? settings!.leadStages : []),
  ];

  const stageById = new Map<string, StageConfig>();
  const qualifiedStageIds = new Set<string>();
  const stageOrder = new Map<string, number>();

  stageList.forEach((stage, index) => {
    if (!stage?.id) return;
    if (!stageById.has(stage.id)) {
      stageById.set(stage.id, stage);
      stageOrder.set(stage.id, index);
    }
    if (stage.isQualified) qualifiedStageIds.add(stage.id);
  });

  return { stageById, qualifiedStageIds, stageOrder };
}

function isQualifiedLead(row: CrmLeadRow, qualifiedStageIds: Set<string>) {
  return !!(row.status && qualifiedStageIds.has(String(row.status)));
}

async function loadCrmRows(supabase: any, filters: CrmAnalyticsFilters): Promise<CrmLeadRow[]> {
  const rows: CrmLeadRow[] = [];
  let page = 0;

  while (true) {
    let query = supabase
      .from('crm_leads')
      .select(
        'status,pipeline_id,pipeline_name,responsible_name,matched_campaign_id,matched_adset_id,matched_ad_id',
      )
      .eq('client_id', filters.clientId)
      .eq('is_duplicate', false)
      .gte('created_at_crm', filters.dateFrom)
      .lte('created_at_crm', `${filters.dateTo}T23:59:59.999`)
      .order('created_at_crm', { ascending: false })
      .order('id', { ascending: false })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

    if (filters.campaignIds.length > 0) query = query.in('matched_campaign_id', filters.campaignIds);
    if (filters.adsetIds.length > 0) query = query.in('matched_adset_id', filters.adsetIds);
    if (filters.creativeIds.length > 0) query = query.in('matched_ad_id', filters.creativeIds);

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;

    rows.push(...(data as CrmLeadRow[]));
    if (data.length < PAGE_SIZE) break;
    page += 1;
  }

  return rows;
}

function filterMediaRows(rows: MediaRow[], filters: CrmAnalyticsFilters): MediaRow[] {
  return rows.filter((row) => {
    if (filters.campaignIds.length > 0 && (!row.campaign_id || !filters.campaignIds.includes(String(row.campaign_id)))) return false;
    if (filters.adsetIds.length > 0 && (!row.adset_id || !filters.adsetIds.includes(String(row.adset_id)))) return false;
    if (filters.creativeIds.length > 0 && (!row.ad_id || !filters.creativeIds.includes(String(row.ad_id)))) return false;
    return true;
  });
}

function buildMediaLookups(rows: MediaRow[]) {
  const campaigns = new Map<string, string>();
  const adsets = new Map<string, string>();
  const creatives = new Map<string, string>();

  rows.forEach((row) => {
    if (row.campaign_id && row.campaign_name && !campaigns.has(String(row.campaign_id))) {
      campaigns.set(String(row.campaign_id), row.campaign_name);
    }
    if (row.adset_id && row.adset_name && !adsets.has(String(row.adset_id))) {
      adsets.set(String(row.adset_id), row.adset_name);
    }
    if (row.ad_id && row.ad_name && !creatives.has(String(row.ad_id))) {
      creatives.set(String(row.ad_id), row.ad_name);
    }
  });

  return { campaigns, adsets, creatives };
}

function buildFilterOptions(rows: MediaRow[]) {
  const campaignMap = new Map<string, { id: string; name: string }>();
  const adsetMap = new Map<string, { id: string; name: string }>();
  const creativeMap = new Map<string, { id: string; name: string }>();

  rows.forEach((row) => {
    if (row.campaign_id && row.campaign_name) {
      campaignMap.set(String(row.campaign_id), { id: String(row.campaign_id), name: row.campaign_name });
    }
    if (row.adset_id && row.adset_name) {
      adsetMap.set(String(row.adset_id), { id: String(row.adset_id), name: row.adset_name });
    }
    if (row.ad_id && row.ad_name) {
      creativeMap.set(String(row.ad_id), { id: String(row.ad_id), name: row.ad_name });
    }
  });

  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, 'ru');

  return {
    campaigns: Array.from(campaignMap.values()).sort(byName),
    adsets: Array.from(adsetMap.values()).sort(byName),
    creatives: Array.from(creativeMap.values()).sort(byName),
  };
}

export async function getCrmAnalytics(
  supabase: any,
  client: ClientWithSettings,
  filters: CrmAnalyticsFilters,
): Promise<CrmAnalyticsResult> {
  const crmRows = await loadCrmRows(supabase, filters);
  const { qualifiedStageIds, stageById, stageOrder } = buildStageConfig(client.settings || null);

  const crossAnalytics = await queryCrossAnalytics(supabase, {
    clientId: filters.clientId,
    dateFrom: filters.dateFrom,
    dateTo: filters.dateTo,
    level: 'creative',
  });

  const filteredMediaRows = filterMediaRows((crossAnalytics.data || []) as MediaRow[], filters);
  const mediaLookups = buildMediaLookups(filteredMediaRows);

  const totalLeads = crmRows.length;
  const qualifiedLeads = crmRows.filter((row) => isQualifiedLead(row, qualifiedStageIds)).length;
  const spend = filteredMediaRows.reduce((sum, row) => sum + (Number(row.spend) || 0), 0);

  const summary: CrmAnalyticsSummary = {
    leads: totalLeads,
    qualifiedLeads,
    conversionLeadToQual: roundMetric(totalLeads > 0 ? (qualifiedLeads / totalLeads) * 100 : 0),
    spend: roundMetric(spend),
    cpl: roundMetric(totalLeads > 0 ? spend / totalLeads : 0),
    cplq: roundMetric(qualifiedLeads > 0 ? spend / qualifiedLeads : 0),
  };

  const stageMap = new Map<string, CrmBoardColumn>();

  crmRows.forEach((row) => {
    const pipelineId = row.pipeline_id || undefined;
    const pipelineName = row.pipeline_name || undefined;
    const stageId = row.status || '';
    const stageConfig = stageId ? stageById.get(stageId) : undefined;
    const stageName = stageConfig?.name || row.status || 'Без этапа';
    const stageKey = `${pipelineId || 'none'}|${stageId || 'none'}`;
    const campaignId = row.matched_campaign_id || 'unmatched';
    const campaignName = row.matched_campaign_id
      ? mediaLookups.campaigns.get(row.matched_campaign_id) || 'Кампания без названия'
      : 'Без кампании';

    let column = stageMap.get(stageKey);
    if (!column) {
      column = {
        stageKey,
        stageName,
        pipelineId,
        pipelineName: pipelineName || stageConfig?.pipelineName,
        count: 0,
        cards: [],
      };
      stageMap.set(stageKey, column);
    }

    column.count += 1;

    const existingCard = column.cards.find((card) => card.campaignId === campaignId);
    if (existingCard) {
      existingCard.count += 1;
    } else {
      column.cards.push({ campaignId, campaignName, count: 1 });
    }
  });

  const boardColumns = Array.from(stageMap.values())
    .map((column) => ({
      ...column,
      cards: [...column.cards].sort((a, b) => b.count - a.count || a.campaignName.localeCompare(b.campaignName, 'ru')),
    }))
    .sort((a, b) => {
      const aStatus = a.stageKey.split('|')[1] || '';
      const bStatus = b.stageKey.split('|')[1] || '';
      const aOrder = stageOrder.get(aStatus) ?? Number.MAX_SAFE_INTEGER;
      const bOrder = stageOrder.get(bStatus) ?? Number.MAX_SAFE_INTEGER;
      if (aOrder !== bOrder) return aOrder - bOrder;
      if ((a.pipelineName || '') !== (b.pipelineName || '')) return (a.pipelineName || '').localeCompare(b.pipelineName || '', 'ru');
      return a.stageName.localeCompare(b.stageName, 'ru');
    });

  const managerMap = new Map<string, { leads: number; qualifiedLeads: number }>();
  crmRows.forEach((row) => {
    const managerName = row.responsible_name || 'Без менеджера';
    const entry = managerMap.get(managerName) || { leads: 0, qualifiedLeads: 0 };
    entry.leads += 1;
    if (isQualifiedLead(row, qualifiedStageIds)) entry.qualifiedLeads += 1;
    managerMap.set(managerName, entry);
  });

  const managerStats = Array.from(managerMap.entries())
    .map(([managerName, stat]) => {
      const spendShare = totalLeads > 0 ? spend * (stat.leads / totalLeads) : 0;
      return {
        managerName,
        leads: stat.leads,
        qualifiedLeads: stat.qualifiedLeads,
        conversionLeadToQual: roundMetric(stat.leads > 0 ? (stat.qualifiedLeads / stat.leads) * 100 : 0),
        spend: roundMetric(spendShare),
        cpl: roundMetric(stat.leads > 0 ? spendShare / stat.leads : 0),
        cplq: roundMetric(stat.qualifiedLeads > 0 ? spendShare / stat.qualifiedLeads : 0),
      };
    })
    .sort((a, b) => b.leads - a.leads || a.managerName.localeCompare(b.managerName, 'ru'));

  return {
    summary,
    boardColumns,
    managerStats,
    filterOptions: buildFilterOptions(filteredMediaRows),
  };
}
