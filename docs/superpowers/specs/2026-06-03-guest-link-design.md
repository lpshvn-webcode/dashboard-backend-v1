# Guest Link Design

**Date:** 2026-06-03

## Goal

Add a single read-only guest link per client so the owner can share dashboard access with a client for 30 days without login, onboarding, or configuration setup. The guest can only open `Dashboard` and `Campaigns`, change dates, and inspect analytics data.

## Scope

Included:

- One active guest link per client
- Link expires automatically after 30 days
- Owner can create and regenerate the link
- Guest can view `Dashboard`
- Guest can view `Campaigns`
- Guest can change date range and filters already supported by those pages
- Guest access is read-only

Excluded:

- Guest access to `Analytics`, `Settings`, `Configuration`, sync actions, exports requiring private account context, or AI assistant actions
- Multiple simultaneous guest links per client
- Guest-specific branding or white-labeling

## Current State

The frontend currently requires a Supabase session for the whole app. Client selection depends on loading `clients` by `user_id`. Backend stats routes are protected by `requireAuth` and verify client ownership through the authenticated user. There is no public or token-based read-only access path today.

## Proposed Architecture

### Backend

Create a dedicated `client_guest_links` table that stores one active guest access record per client:

- `id`
- `client_id`
- `token_hash`
- `expires_at`
- `revoked_at`
- `created_by`
- `created_at`
- `updated_at`

The raw token is generated server-side, returned once to the owner, and never stored in plaintext. Validation compares the presented token against the stored hash and rejects expired or revoked links.

Add owner-only management endpoints:

- `POST /api/guest-links`
  - Input: `clientId`
  - Behavior: verify ownership, create or replace the single active guest link, set `expires_at = now + 30 days`, return the full share URL and metadata
- `GET /api/guest-links`
  - Input: `clientId`
  - Behavior: verify ownership, return current active link metadata if one exists
- `DELETE /api/guest-links`
  - Input: `clientId`
  - Behavior: verify ownership, revoke current active link

Add public read-only endpoints validated by token instead of user JWT:

- `GET /api/public/guest/meta?token=...`
- `GET /api/public/stats/cross-kpis?token=...&dateFrom=...&dateTo=...&platform=...`
- `GET /api/public/stats/cross-analytics?token=...&dateFrom=...&dateTo=...&platform=...&level=campaign|adset|creative&campaignId=...&campaignName=...&adsetName=...`

These endpoints reuse the same analytics tables and aggregation logic as the authenticated stats endpoints, but they derive `client_id` from the validated guest token instead of accepting arbitrary client ids from the caller.

### Frontend

Add a guest route namespace, for example:

- `/#/guest/:token`
- `/#/guest/:token/campaigns`

Guest pages should reuse existing `Dashboard` and `Campaigns` page components as much as possible. The new behavior should come from a dedicated guest access layer:

- a guest session context that reads the token from the route
- guest API helpers that call public read-only backend routes
- a guest data provider shaped like the current `DataContext`

The app should render a small guest shell without the private app sidebar, without client switching, and without private navigation. Only:

- date range picker
- source filters already supported by the pages
- navigation between `Dashboard` and `Campaigns`

Any controls that mutate state outside local filters must be hidden in guest mode.

## UX

Inside the authenticated app, add a simple guest-link management card or section:

- “Create guest link”
- show expiration date when active
- “Copy link”
- “Regenerate”
- “Disable”

Behavior rules:

- If no link exists, the owner sees create
- If an active link exists, the owner sees its expiration and actions
- Regenerate invalidates the previous link immediately
- Expired links show a clean “link expired” screen with no login requirement
- Invalid or revoked links show a clean “link unavailable” screen

## Security

- Tokens must be cryptographically random
- Only token hashes are stored
- Public endpoints must never accept `clientId`
- Public endpoints must expose only read-only analytics data needed by `Dashboard` and `Campaigns`
- Expired or revoked tokens return `401` or `404` style responses without revealing whether the client exists
- Guest mode must not render settings, sync controls, AI actions, or configuration data

## Error Handling

- If the token is invalid, revoked, or expired, show a dedicated guest error state
- If analytics data fails to load, reuse existing error banners where possible
- If the owner creates a new link, the old link should stop working immediately without partial overlap

## Testing

Backend:

- token creation and replacement
- token validation success and failure cases
- public stats endpoints derive client access only from token
- revoked and expired links are rejected

Frontend:

- guest routes render without Supabase auth
- guest dashboard and campaigns load data through public endpoints
- guest mode hides private navigation and mutation controls
- invalid token screen renders correctly

## Rollout

Implement backend first so public endpoints exist before wiring guest routes. Then add frontend guest mode and owner controls in the authenticated app. Verify the generated link works in a fresh browser session with no existing login state.
