# CRM Analytics Kanban Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a kanban-first CRM analytics block inside the existing `Analytics` page, with local media filters, filter-aware KPI metrics, manager effectiveness, and a separate mobile drilldown fix for `Campaigns`.

**Architecture:** Add one dedicated backend endpoint that aggregates CRM rows from `crm_leads` plus spend from media analytics under a shared filter scope, then render a self-contained frontend CRM section with local state inside `Analytics.tsx`. Keep the mobile `Campaigns` fix isolated from the CRM work so desktop drilldown behavior stays stable while mobile gets card-based navigation.

**Tech Stack:** Express, TypeScript, Supabase, React, Vite, React Router, existing analytics and CRM sync layers.

---

## File Structure

**Backend**

- Modify: `/Users/rabota/dashboard skvoz/back/dashboard-backend-v1/src/routes/stats.ts`
- Create: `/Users/rabota/dashboard skvoz/back/dashboard-backend-v1/src/services/crm-analytics.ts`
- Modify: `/Users/rabota/dashboard skvoz/back/dashboard-backend-v1/src/types/database.ts` only if helper types need to be exported
- Reuse: `/Users/rabota/dashboard skvoz/back/dashboard-backend-v1/src/services/cross-analytics-query.ts`

**Frontend**

- Modify: `/Users/rabota/dashboard skvoz/front/dashboard-v2/pages/Analytics.tsx`
- Create: `/Users/rabota/dashboard skvoz/front/dashboard-v2/components/CrmAnalyticsBlock.tsx`
- Create: `/Users/rabota/dashboard skvoz/front/dashboard-v2/components/CrmStageBoard.tsx`
- Create: `/Users/rabota/dashboard skvoz/front/dashboard-v2/components/CrmManagerTable.tsx`
- Create: `/Users/rabota/dashboard skvoz/front/dashboard-v2/components/CrmFilterBar.tsx`
- Modify: `/Users/rabota/dashboard skvoz/front/dashboard-v2/lib/api.ts`
- Modify: `/Users/rabota/dashboard skvoz/front/dashboard-v2/types.ts`

**Mobile drilldown**

- Modify: `/Users/rabota/dashboard skvoz/front/dashboard-v2/pages/Campaigns.tsx`
- Optional create: `/Users/rabota/dashboard skvoz/front/dashboard-v2/components/MobileDrilldownCard.tsx`

## Task 1: Define backend CRM analytics contract

**Files:**

- Create: `/Users/rabota/dashboard skvoz/back/dashboard-backend-v1/src/services/crm-analytics.ts`
- Modify: `/Users/rabota/dashboard skvoz/back/dashboard-backend-v1/src/routes/stats.ts`

- [ ] **Step 1: Add response and filter types in `crm-analytics.ts`**

```ts
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
```

- [ ] **Step 2: Add the new route shell in `stats.ts`**

```ts
router.get('/crm-analytics', requireAuth, async (req, res) => {
  const userId = (req as any).user.id;
  const { clientId, dateFrom, dateTo } = req.query as Record<string, string>;

  if (!clientId) return res.status(400).json({ error: 'clientId required' });
  if (!dateFrom || !dateTo) return res.status(400).json({ error: 'dateFrom and dateTo required' });

  const { data: client } = await supabase
    .from('clients')
    .select('id,user_id,settings')
    .eq('id', clientId)
    .single();

  if (!client || client.user_id !== userId) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const campaignIds = parseMultiValue(req.query.campaignIds);
  const adsetIds = parseMultiValue(req.query.adsetIds);
  const creativeIds = parseMultiValue(req.query.creativeIds);

  const payload = await getCrmAnalytics(supabase, client, {
    clientId,
    dateFrom,
    dateTo,
    campaignIds,
    adsetIds,
    creativeIds,
  });

  return res.json(payload);
});
```

- [ ] **Step 3: Add a tiny query parser helper in `stats.ts` and wire import**

```ts
function parseMultiValue(input: unknown): string[] {
  if (!input) return [];
  if (Array.isArray(input)) {
    return input.flatMap((value) => String(value).split(',')).map((value) => value.trim()).filter(Boolean);
  }
  return String(input).split(',').map((value) => value.trim()).filter(Boolean);
}
```

- [ ] **Step 4: Run backend build to verify contract scaffolding compiles**

Run: `npm run build`  
Expected: `tsc` exits with code `0`

## Task 2: Build CRM analytics aggregation service

**Files:**

- Create: `/Users/rabota/dashboard skvoz/back/dashboard-backend-v1/src/services/crm-analytics.ts`
- Reuse by import: `/Users/rabota/dashboard skvoz/back/dashboard-backend-v1/src/services/cross-analytics-query.ts`

- [ ] **Step 1: Implement CRM lead filtering by date and matched ids**

```ts
let crmQuery = supabase
  .from('crm_leads')
  .select('status,pipeline_id,pipeline_name,responsible_name,matched_campaign_id,matched_adset_id,matched_ad_id,lead_name,lead_id')
  .eq('client_id', filters.clientId)
  .eq('is_duplicate', false)
  .gte('created_at_crm', filters.dateFrom)
  .lte('created_at_crm', filters.dateTo + 'T23:59:59');

if (filters.campaignIds.length > 0) crmQuery = crmQuery.in('matched_campaign_id', filters.campaignIds);
if (filters.adsetIds.length > 0) crmQuery = crmQuery.in('matched_adset_id', filters.adsetIds);
if (filters.creativeIds.length > 0) crmQuery = crmQuery.in('matched_ad_id', filters.creativeIds);
```

- [ ] **Step 2: Resolve qualified stages from client settings instead of hardcoding**

```ts
function buildQualifiedStageSet(settings: any): Set<string> {
  const stages = Array.isArray(settings?.dealStages) ? settings.dealStages : [];
  return new Set(
    stages
      .filter((stage: any) => stage?.isQualified)
      .map((stage: any) => String(stage.id))
  );
}
```

- [ ] **Step 3: Compute spend under the same filter scope using `cross_analytics`**

```ts
const spendResult = await queryCrossAnalytics(supabase, {
  clientId: filters.clientId,
  dateFrom: filters.dateFrom,
  dateTo: filters.dateTo,
  level: 'creative',
  campaignId: filters.campaignIds.length === 1 ? filters.campaignIds[0] : undefined,
});

const spend = (spendResult.data || [])
  .filter((row) => {
    if (filters.campaignIds.length > 0 && !filters.campaignIds.includes(row.campaign_id)) return false;
    if (filters.adsetIds.length > 0 && !filters.adsetIds.includes(row.adset_id)) return false;
    if (filters.creativeIds.length > 0 && !filters.creativeIds.includes(row.ad_id)) return false;
    return true;
  })
  .reduce((total, row) => total + (Number(row.spend) || 0), 0);
```

- [ ] **Step 4: Aggregate board columns by `pipeline + status`, cards by campaign**

```ts
const stageMap = new Map<string, CrmBoardColumn>();

for (const row of crmRows) {
  const stageKey = `${row.pipeline_id || 'none'}|${row.status}`;
  const stageName = row.status || 'Без этапа';
  const campaignId = row.matched_campaign_id || 'unmatched';
  const campaignName = campaignNameById.get(campaignId) || 'Без кампании';

  let column = stageMap.get(stageKey);
  if (!column) {
    column = {
      stageKey,
      stageName,
      pipelineId: row.pipeline_id || undefined,
      pipelineName: row.pipeline_name || undefined,
      count: 0,
      cards: [],
    };
    stageMap.set(stageKey, column);
  }

  column.count += 1;

  const existingCard = column.cards.find((card) => card.campaignId === campaignId);
  if (existingCard) existingCard.count += 1;
  else column.cards.push({ campaignId, campaignName, count: 1 });
}
```

- [ ] **Step 5: Aggregate manager stats with filter-aware CPL/CPLQ**

```ts
const managerMap = new Map<string, { leads: number; qualifiedLeads: number }>();

for (const row of crmRows) {
  const managerName = row.responsible_name || 'Без менеджера';
  const stat = managerMap.get(managerName) || { leads: 0, qualifiedLeads: 0 };
  stat.leads += 1;
  if (qualifiedStageSet.has(String(row.status))) stat.qualifiedLeads += 1;
  managerMap.set(managerName, stat);
}

const managerStats = Array.from(managerMap.entries()).map(([managerName, stat]) => {
  const spendShare = totalLeads > 0 ? spend * (stat.leads / totalLeads) : 0;
  return {
    managerName,
    leads: stat.leads,
    qualifiedLeads: stat.qualifiedLeads,
    conversionLeadToQual: stat.leads > 0 ? (stat.qualifiedLeads / stat.leads) * 100 : 0,
    spend: spendShare,
    cpl: stat.leads > 0 ? spendShare / stat.leads : 0,
    cplq: stat.qualifiedLeads > 0 ? spendShare / stat.qualifiedLeads : 0,
  };
});
```

- [ ] **Step 6: Return filter options from the already matched data**

```ts
const filterOptions = {
  campaigns: uniqueCampaignsFromRows,
  adsets: uniqueAdsetsFromRows,
  creatives: uniqueCreativesFromRows,
};
```

- [ ] **Step 7: Run backend build again**

Run: `npm run build`  
Expected: `tsc` exits with code `0`

## Task 3: Add frontend CRM analytics API and types

**Files:**

- Modify: `/Users/rabota/dashboard skvoz/front/dashboard-v2/lib/api.ts`
- Modify: `/Users/rabota/dashboard skvoz/front/dashboard-v2/types.ts`

- [ ] **Step 1: Add frontend types for CRM analytics**

```ts
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

export interface CrmAnalyticsPayload {
  summary: CrmAnalyticsSummary;
  boardColumns: CrmBoardColumn[];
  managerStats: CrmManagerStat[];
  filterOptions: {
    campaigns: Array<{ id: string; name: string }>;
    adsets: Array<{ id: string; name: string }>;
    creatives: Array<{ id: string; name: string }>;
  };
}
```

- [ ] **Step 2: Add API helper in `lib/api.ts`**

```ts
crmAnalytics: (
  clientId: string,
  range: DateRange,
  filters?: { campaignIds?: string[]; adsetIds?: string[]; creativeIds?: string[] },
) => {
  const params = new URLSearchParams({ clientId, ...range });
  if (filters?.campaignIds?.length) params.set('campaignIds', filters.campaignIds.join(','));
  if (filters?.adsetIds?.length) params.set('adsetIds', filters.adsetIds.join(','));
  if (filters?.creativeIds?.length) params.set('creativeIds', filters.creativeIds.join(','));
  return apiFetch<CrmAnalyticsPayload>(`/api/stats/crm-analytics?${params}`);
},
```

- [ ] **Step 3: Verify frontend build after type/API additions**

Run: `npm run build`  
Expected: Vite build succeeds

## Task 4: Build the CRM block UI inside Analytics

**Files:**

- Create: `/Users/rabota/dashboard skvoz/front/dashboard-v2/components/CrmAnalyticsBlock.tsx`
- Create: `/Users/rabota/dashboard skvoz/front/dashboard-v2/components/CrmFilterBar.tsx`
- Create: `/Users/rabota/dashboard skvoz/front/dashboard-v2/components/CrmStageBoard.tsx`
- Create: `/Users/rabota/dashboard skvoz/front/dashboard-v2/components/CrmManagerTable.tsx`
- Modify: `/Users/rabota/dashboard skvoz/front/dashboard-v2/pages/Analytics.tsx`

- [ ] **Step 1: Create the CRM block container with local filter state**

```tsx
const [crmFilters, setCrmFilters] = useState({
  campaignIds: [] as string[],
  adsetIds: [] as string[],
  creativeIds: [] as string[],
});
const [crmData, setCrmData] = useState<CrmAnalyticsPayload | null>(null);
const [crmLoading, setCrmLoading] = useState(false);
const [crmError, setCrmError] = useState<string | null>(null);
```

- [ ] **Step 2: Fetch CRM analytics inside a dedicated block effect**

```tsx
useEffect(() => {
  if (!activeClientId) return;

  const run = async () => {
    setCrmLoading(true);
    setCrmError(null);
    try {
      const payload = await api.stats.crmAnalytics(activeClientId, {
        dateFrom: format(dateRange.startDate, 'yyyy-MM-dd'),
        dateTo: format(dateRange.endDate, 'yyyy-MM-dd'),
      }, crmFilters);
      setCrmData(payload);
    } catch (err: any) {
      setCrmError(err.message || 'Ошибка загрузки CRM-аналитики');
    } finally {
      setCrmLoading(false);
    }
  };

  run();
}, [activeClientId, dateRange, crmFilters]);
```

- [ ] **Step 3: Render the filter bar, summary cards, stage board, and manager table**

```tsx
<CrmFilterBar
  filters={crmFilters}
  options={crmData?.filterOptions}
  onChange={setCrmFilters}
/>
<CrmAnalyticsBlock
  summary={crmData?.summary}
  boardColumns={crmData?.boardColumns || []}
  managerStats={crmData?.managerStats || []}
  isLoading={crmLoading}
  error={crmError}
/>
```

- [ ] **Step 4: Add the block into `Analytics.tsx` without touching page-level filters**

```tsx
{!isExporting && (
  <CrmAnalyticsBlock
    clientId={activeClientId}
    dateRange={dateRange}
    formatValue={formatValue}
  />
)}
```

- [ ] **Step 5: Keep the visuals kanban-first**

```tsx
<section className="bg-white border border-slate-200 rounded-3xl p-6 md:p-8 space-y-6">
  <header>...</header>
  <CrmFilterBar ... />
  <SummaryGrid ... />
  <CrmStageBoard ... />
  <CrmManagerTable ... />
</section>
```

- [ ] **Step 6: Build frontend to catch integration issues**

Run: `npm run build`  
Expected: Vite build succeeds

## Task 5: Implement mobile drilldown cards in Campaigns

**Files:**

- Modify: `/Users/rabota/dashboard skvoz/front/dashboard-v2/pages/Campaigns.tsx`
- Optional create: `/Users/rabota/dashboard skvoz/front/dashboard-v2/components/MobileDrilldownCard.tsx`

- [ ] **Step 1: Add a mobile breakpoint branch for drilldown rendering**

```tsx
{drillLevel === 'adsets' && (
  <>
    <div className="md:hidden space-y-3 p-3">
      {drillAdSets.map((adSet) => (
        <MobileDrilldownCard
          key={adSet.id}
          title={adSet.name}
          leads={adSet.leads}
          qualifiedLeads={adSet.qualifiedLeads}
          spend={adSet.spend}
          actionLabel="Открыть креативы"
          onClick={() => drillIntoCreatives(adSet.id)}
        />
      ))}
    </div>
    <div className="hidden md:block">{/* existing table */}</div>
  </>
)}
```

- [ ] **Step 2: Mirror the same pattern for creatives**

```tsx
{drillLevel === 'creatives' && (
  <>
    <div className="md:hidden space-y-3 p-3">
      {drillCreatives.map((creative) => (
        <MobileDrilldownCard
          key={creative.id}
          title={creative.name}
          leads={creative.leads}
          qualifiedLeads={creative.qualifiedLeads}
          spend={creative.spend}
          actionLabel={creative.videoUrl || creative.imageUrl ? 'Открыть медиа' : undefined}
          onClick={creative.videoUrl || creative.imageUrl ? () => setLightbox({ url: creative.videoUrl || creative.imageUrl, isVideo: !!creative.videoUrl }) : undefined}
        />
      ))}
    </div>
    <div className="hidden md:block">{/* existing table */}</div>
  </>
)}
```

- [ ] **Step 3: Build frontend again**

Run: `npm run build`  
Expected: Vite build succeeds

## Task 6: Verify real behavior and prepare delivery

**Files:**

- Modify only files already touched by implementation

- [ ] **Step 1: Build backend**

Run: `npm run build`  
Expected: `tsc` exits with code `0`

- [ ] **Step 2: Build frontend**

Run: `npm run build`  
Expected: Vite build succeeds

- [ ] **Step 3: Run a direct CRM analytics smoke query**

Run:

```bash
curl -s "http://127.0.0.1:3001/api/stats/crm-analytics?clientId=<client-id>&dateFrom=2026-05-25&dateTo=2026-06-02"
```

Expected:

```json
{
  "summary": {},
  "boardColumns": [],
  "managerStats": [],
  "filterOptions": {}
}
```

- [ ] **Step 4: Manually verify frontend states**

Check:

- CRM block appears inside `Analytics`
- changing CRM filters updates only CRM block
- board columns render grouped campaign cards
- manager section changes with filters
- mobile `Campaigns` drilldown no longer depends on 1020px table layout

- [ ] **Step 5: Commit backend**

```bash
git -C "/Users/rabota/dashboard skvoz/back/dashboard-backend-v1" add \
  src/routes/stats.ts \
  src/services/crm-analytics.ts
git -C "/Users/rabota/dashboard skvoz/back/dashboard-backend-v1" commit -m "feat: add crm analytics endpoint" -m "Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

- [ ] **Step 6: Commit frontend**

```bash
git -C "/Users/rabota/dashboard skvoz/front/dashboard-v2" add \
  pages/Analytics.tsx \
  components/CrmAnalyticsBlock.tsx \
  components/CrmStageBoard.tsx \
  components/CrmManagerTable.tsx \
  components/CrmFilterBar.tsx \
  pages/Campaigns.tsx \
  lib/api.ts \
  types.ts
git -C "/Users/rabota/dashboard skvoz/front/dashboard-v2" commit -m "feat: add crm analytics kanban block" -m "Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

- [ ] **Step 7: Push changes**

```bash
git -C "/Users/rabota/dashboard skvoz/back/dashboard-backend-v1" push origin main
git -C "/Users/rabota/dashboard skvoz/front/dashboard-v2" push origin main
```
