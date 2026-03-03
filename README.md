# Nova Analytics — Backend API

Node.js + TypeScript backend for syncing ad platform data and CRM leads into Supabase.

## Architecture

```
Vercel Cron (every 4h)  →  /api/cron/sync-ads   →  Facebook / Google Ads API
Vercel Cron (every 3h)  →  /api/cron/sync-crm   →  AmoCRM / Bitrix24 API
CRM Webhook              →  /api/webhooks/*      →  Real-time lead updates
Frontend                 →  /api/stats/*         →  Read aggregated data
Frontend                 →  /api/connections/*   →  Manage ad accounts & CRM
```

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Environment variables
Copy `.env.example` to `.env` and fill in:

```env
SUPABASE_URL=https://iecwxlhneczgxebbcpel.supabase.co
SUPABASE_SERVICE_KEY=<service_role_key_from_supabase_dashboard>
SUPABASE_ANON_KEY=<anon_key>
FRONTEND_URL=https://your-dashboard.vercel.app
CRON_SECRET=<random_string>

# Facebook
# No extra env needed - access tokens stored per ad account in DB

# Google Ads
GOOGLE_CLIENT_ID=<from_google_cloud_console>
GOOGLE_CLIENT_SECRET=<from_google_cloud_console>
GOOGLE_ADS_DEVELOPER_TOKEN=<from_google_ads_api_center>
GOOGLE_ADS_MANAGER_ID=<your_mcc_account_id>  # optional

# AmoCRM
AMOCRM_CLIENT_ID=<from_amocrm_integration>
AMOCRM_CLIENT_SECRET=<from_amocrm_integration>
AMOCRM_REDIRECT_URI=https://your-backend.vercel.app/api/oauth/amocrm/callback

# Bitrix24
BITRIX24_CLIENT_ID=<from_bitrix24_app>
BITRIX24_CLIENT_SECRET=<from_bitrix24_app>
```

### 3. Set up Supabase database
Run `supabase-schema.sql` in Supabase SQL Editor.

### 4. Deploy to Vercel
```bash
vercel --prod
```

Set all env variables in Vercel dashboard under Settings → Environment Variables.

## API Endpoints

### Stats (require JWT auth)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/stats/overview` | Dashboard overview totals |
| GET | `/api/stats/campaigns` | Campaign-level stats |
| GET | `/api/stats/adsets` | Ad set / Ad group stats |
| GET | `/api/stats/creatives` | Ad creative stats |
| GET | `/api/stats/leads` | CRM leads |
| GET | `/api/stats/sync-status` | Last sync times & logs |

All stats endpoints accept query params: `clientId`, `dateFrom` (YYYY-MM-DD), `dateTo`, `platform`.

### Connections (require JWT auth)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/connections/ad-accounts` | List ad accounts |
| POST | `/api/connections/ad-accounts` | Add ad account |
| DELETE | `/api/connections/ad-accounts/:id` | Remove ad account |
| POST | `/api/connections/ad-accounts/:id/sync` | Trigger manual sync |
| GET | `/api/connections/crm` | List CRM connections |
| POST | `/api/connections/crm` | Add CRM connection |
| DELETE | `/api/connections/crm/:id` | Remove CRM connection |
| POST | `/api/connections/crm/:id/sync` | Trigger manual sync |

### Cron (require CRON_SECRET header)
| Method | Path | Schedule |
|--------|------|----------|
| POST | `/api/cron/sync-ads` | Every 4 hours |
| POST | `/api/cron/sync-crm` | Every 3 hours |

### Webhooks
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/webhooks/amocrm/:connectionId` | AmoCRM lead updates |
| POST | `/api/webhooks/bitrix24/:connectionId` | Bitrix24 lead updates |

## Local Development
```bash
npm run dev
```
Server starts on port 3001.
