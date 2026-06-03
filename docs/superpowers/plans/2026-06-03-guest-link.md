# Guest Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a single expiring read-only guest link per client that opens `Dashboard` and `Campaigns` without login.

**Architecture:** Add a backend token-based guest access layer that derives client access from a validated guest token, then add a frontend guest shell and guest data provider that reuse existing analytics pages in read-only mode. Owner-facing controls will live in the authenticated app and manage a single guest link per client.

**Tech Stack:** Express, TypeScript, Supabase/Postgres, React, Vite, React Router, existing analytics API layer.

---

## File Structure

**Backend**

- Create: `src/services/guest-links.ts`
- Modify: `src/routes/stats.ts`
- Modify: `src/index.ts`
- Create or update docs only if endpoint behavior needs clarification during implementation

**Frontend**

- Modify: `App.tsx`
- Create: `contexts/GuestContext.tsx`
- Create: `contexts/GuestDataContext.tsx`
- Modify: `lib/api.ts`
- Modify: `pages/Dashboard.tsx`
- Modify: `pages/Campaigns.tsx`
- Modify: `pages/Settings.tsx`
- Create: `components/GuestLinkCard.tsx`
- Create: `components/GuestLayout.tsx`

## Task 1: Backend guest-link domain

**Files:**

- Create: `/Users/rabota/dashboard skvoz/back/dashboard-backend-v1/src/services/guest-links.ts`
- Modify: `/Users/rabota/dashboard skvoz/back/dashboard-backend-v1/src/routes/stats.ts`

- [ ] Add token generation, hashing, validation, and single-link replacement helpers in `guest-links.ts`
- [ ] Add authenticated endpoints to create, fetch, and revoke a guest link for a client
- [ ] Add public token-validated endpoints for guest meta, cross-kpis, and cross-analytics
- [ ] Reuse existing stats aggregation logic instead of duplicating query behavior
- [ ] Verify TypeScript build: `npm run build`

## Task 2: Frontend guest routing and state

**Files:**

- Modify: `/Users/rabota/dashboard skvoz/front/dashboard-v2/App.tsx`
- Create: `/Users/rabota/dashboard skvoz/front/dashboard-v2/contexts/GuestContext.tsx`
- Create: `/Users/rabota/dashboard skvoz/front/dashboard-v2/contexts/GuestDataContext.tsx`
- Modify: `/Users/rabota/dashboard skvoz/front/dashboard-v2/lib/api.ts`
- Create: `/Users/rabota/dashboard skvoz/front/dashboard-v2/components/GuestLayout.tsx`

- [ ] Add guest route namespace for dashboard and campaigns
- [ ] Add guest token context that resolves token metadata and invalid states
- [ ] Add guest API helpers for public analytics endpoints
- [ ] Add guest data provider with the same read shape needed by `Dashboard` and `Campaigns`
- [ ] Verify frontend build: `npm run build`

## Task 3: Reuse existing pages in read-only guest mode

**Files:**

- Modify: `/Users/rabota/dashboard skvoz/front/dashboard-v2/pages/Dashboard.tsx`
- Modify: `/Users/rabota/dashboard skvoz/front/dashboard-v2/pages/Campaigns.tsx`

- [ ] Hide private actions that should not appear in guest mode
- [ ] Keep date picker and supported filters working in guest mode
- [ ] Remove dependencies on authenticated-only state where guest pages reuse shared components
- [ ] Verify guest routes render without Supabase login by running a production build and local smoke check

## Task 4: Owner controls for managing the link

**Files:**

- Create: `/Users/rabota/dashboard skvoz/front/dashboard-v2/components/GuestLinkCard.tsx`
- Modify: `/Users/rabota/dashboard skvoz/front/dashboard-v2/pages/Settings.tsx`
- Modify: `/Users/rabota/dashboard skvoz/front/dashboard-v2/lib/api.ts`

- [ ] Add UI to create, copy, regenerate, and disable the guest link
- [ ] Show expiration date and current status
- [ ] Keep interactions scoped to the active client
- [ ] Verify build again after wiring controls

## Task 5: Verification and delivery

**Files:**

- Modify only files already touched by implementation

- [ ] Build backend: `npm run build`
- [ ] Build frontend: `npm run build`
- [ ] Smoke-test the generated guest URL in a fresh browser context or with direct API calls for token meta and stats
- [ ] Commit backend with a conventional commit message
- [ ] Push backend to `origin main`
- [ ] Commit frontend with a conventional commit message
- [ ] Push frontend to `origin main`
