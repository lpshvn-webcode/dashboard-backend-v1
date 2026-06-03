# CRM Analytics Kanban Design

**Date:** 2026-06-03

## Goal

Add a new CRM analytics block inside the existing `Analytics` page so the user can inspect CRM funnel health in a CRM-like kanban format, filtered by `campaign`, `adset`, and `creative`, with KPI cards and manager effectiveness metrics calculated strictly from the selected filter.

## Scope

Included:

- New CRM analytics section inside the current `Analytics` page
- Kanban-first layout
- Local CRM-block filters for `campaign`, `adset`, and `creative`
- KPI cards for:
  - total leads
  - qualified leads
  - lead-to-qualified conversion
  - spend
  - CPL
  - CPLQ
- Kanban columns based on CRM stages
- Grouped cards inside columns by campaign only
- Manager effectiveness table based on `responsible_name`
- Support for CRM sync modes:
  - one entity only
  - `both` meaning combined leads and deals
- Separate mobile fix for `Campaigns` drilldown so adsets/creatives are usable on phones

Excluded:

- Stage-to-stage transition speed
- Full lead-level CRM timeline
- Per-lead kanban cards
- A separate CRM analytics page
- CRM editing actions or writeback

## Product Decisions

### Placement

The new CRM block lives inside the existing `Analytics` page, not in a separate route or module.

### Visual Direction

The CRM block uses a kanban-first presentation:

- local filters at the top of the block
- KPI cards above the board
- kanban board as the center of the section
- manager effectiveness below the board

This should feel like a mini CRM view embedded into analytics rather than a generic chart dashboard.

### Grouping

Inside each kanban column, cards are grouped by campaign only.

Example card:

- `Diskurs // quiz v5`
- `7 заявок`

Manager names are not used as the primary grouping key inside the board. Managers are analyzed in a separate block below.

### Filter Behavior

The CRM block owns its own local filters. These filters do not affect the rest of the `Analytics` page.

Supported local filters:

- one or more campaigns
- one or more adsets
- one or more creatives

All CRM metrics inside the block must be recalculated from the active filter:

- total leads
- qualified leads
- lead-to-qualified conversion
- spend
- CPL
- CPLQ
- board counts
- manager metrics

## Current Data Reality

The current system stores CRM rows in `crm_leads` with current state only:

- `status`
- `pipeline_id`
- `pipeline_name`
- `responsible_name`
- `created_at_crm`
- `closed_at`
- `matched_campaign_id`
- `matched_adset_id`
- `matched_ad_id`

The system does not store explicit stage transition history. Therefore:

- current stage distribution is possible now
- current-state conversion metrics are possible now
- stage transition speed is intentionally out of scope

## Data Model and Semantics

### CRM Source

The CRM block should be based primarily on `crm_leads`.

Rows represent current CRM records and may come from:

- Bitrix24
- AmoCRM
- future CRM integrations

### Media Linkage

Filter matching uses the existing matched media keys:

- `matched_campaign_id`
- `matched_adset_id`
- `matched_ad_id`

These keys determine which CRM records belong to the selected media slice.

### Spend Calculation

Spend should be calculated for the same selected filter scope as the CRM records. The block should use the same media dimension filters for spend that it uses for CRM slicing, so KPI calculations remain consistent.

### Qualification Logic

Qualified leads must be determined from client configuration, not hardcoded statuses. Existing stage configuration semantics remain the source of truth.

### Sync Mode Logic

If the client syncs one CRM entity only, the block uses that entity.

If the client sync mode is `both`, the block combines both leads and deals in the same CRM analytics result. The board should still preserve stage identity via `pipeline_name + status`, so different pipelines do not become visually ambiguous.

## Backend Design

### New Endpoint

Add a dedicated endpoint for CRM analytics instead of overloading existing analytics endpoints.

Proposed shape:

- `GET /api/stats/crm-analytics`

Parameters:

- `clientId`
- `dateFrom`
- `dateTo`
- `campaignIds[]`
- `adsetIds[]`
- `creativeIds[]`

### Response Shape

The endpoint should return a structured payload with:

- `summary`
  - total leads
  - qualified leads
  - lead-to-qualified conversion
  - spend
  - CPL
  - CPLQ
- `boardColumns`
  - stage metadata
  - count in stage
  - grouped campaign cards
- `managerStats`
  - manager name
  - total leads
  - qualified leads
  - conversion
  - spend
  - CPL
  - CPLQ
- `filterOptions`
  - campaigns
  - adsets
  - creatives

### Aggregation Rules

The endpoint should:

1. identify CRM rows in `crm_leads` inside the selected date range
2. restrict those rows by matched media ids if filters are present
3. compute qualified counts from client stage config
4. compute spend using the same media filter scope
5. group board data by stage and then by campaign
6. group manager data by `responsible_name`

## Frontend Design

### Page Integration

The new block is added to the existing `Analytics.tsx` page as a self-contained section with local state.

The section should not mutate or override the page-level filters already used by the rest of analytics.

### Block Structure

Inside the CRM block:

1. local multi-select filter row
2. KPI cards
3. kanban board
4. manager effectiveness section

### Kanban Board

Each column represents a CRM stage.

Each column contains campaign-grouped cards rather than individual leads.

Each card should surface:

- campaign name
- count of records in this stage

Optional secondary details can be added later if needed, but first version should stay compact and readable.

### Manager Section

The manager section can be a compact table or structured list. It must show:

- manager name
- leads
- qualified leads
- lead-to-qualified conversion
- CPL
- CPLQ

All values are derived from the same filtered subset as the board and summary.

## Mobile Fix for Campaigns Drilldown

The current mobile experience in `Campaigns` uses desktop-style wide drilldown tables with large minimum widths. This is difficult to use on phones.

The mobile fix should:

- keep desktop grid drilldown unchanged
- introduce mobile-specific card layouts for adsets and creatives
- make adset-to-creative navigation feel like a native mobile drilldown rather than a horizontally scrolled desktop table

Each mobile drilldown card should at minimum show:

- name
- leads
- qualified leads
- spend
- action to open the next level

## Error Handling

- If no CRM rows match the filter, show an empty CRM block state rather than failing the full page
- If spend exists but CRM rows do not, still show spend-based KPI values where meaningful and zero CRM counts
- If CRM rows exist but media linkage is missing, they should simply not appear under filtered media slices
- If manager names are missing, group those rows into a fallback bucket such as “Без менеджера”

## Testing

Backend:

- endpoint returns valid summary data without media filters
- endpoint filters correctly by campaign, adset, and creative ids
- `both` sync mode combines leads and deals
- qualified count respects client stage config
- manager aggregation respects filtered scope

Frontend:

- CRM block renders independently inside analytics
- local filters affect only CRM block
- board columns and grouped campaign cards render correctly
- manager section updates when filters change
- mobile campaigns drilldown uses cards instead of unusable wide tables

## Rollout Order

1. backend CRM analytics endpoint
2. frontend CRM block in analytics
3. mobile drilldown fix in campaigns
4. verification against real client data
