-- ============================================================
-- Nova Analytics - Full Supabase Schema
-- Run this in Supabase SQL Editor
-- ============================================================

-- ── Ad Accounts ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ad_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid REFERENCES clients(id) ON DELETE CASCADE NOT NULL,
  platform text NOT NULL CHECK (platform IN ('facebook', 'google', 'tiktok')),
  account_id text NOT NULL,
  account_name text NOT NULL DEFAULT '',
  access_token text NOT NULL,
  refresh_token text,
  token_expires_at timestamptz,
  is_active boolean DEFAULT true,
  last_synced_at timestamptz,
  created_at timestamptz DEFAULT now()
);

-- Prevent duplicate accounts per client+platform+account_id
CREATE UNIQUE INDEX IF NOT EXISTS ad_accounts_unique
  ON ad_accounts(client_id, platform, account_id);

ALTER TABLE ad_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own ad accounts" ON ad_accounts
  FOR ALL USING (
    client_id IN (SELECT id FROM clients WHERE user_id = auth.uid())
  );

-- ── Campaign Stats ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS campaign_stats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ad_account_id uuid REFERENCES ad_accounts(id) ON DELETE CASCADE NOT NULL,
  client_id uuid REFERENCES clients(id) ON DELETE CASCADE NOT NULL,
  platform text NOT NULL,
  date date NOT NULL,
  campaign_id text NOT NULL,
  campaign_name text NOT NULL DEFAULT '',
  status text DEFAULT '',
  spend numeric(12, 2) DEFAULT 0,
  impressions bigint DEFAULT 0,
  clicks bigint DEFAULT 0,
  reach bigint DEFAULT 0,
  leads integer DEFAULT 0,
  ctr numeric(8, 4) DEFAULT 0,
  cpl numeric(12, 2) DEFAULT 0,
  cpc numeric(12, 2) DEFAULT 0,
  currency text DEFAULT 'KZT',
  created_at timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS campaign_stats_unique
  ON campaign_stats(ad_account_id, campaign_id, date);

CREATE INDEX IF NOT EXISTS campaign_stats_client_date
  ON campaign_stats(client_id, date);

ALTER TABLE campaign_stats ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own campaign stats" ON campaign_stats
  FOR SELECT USING (
    client_id IN (SELECT id FROM clients WHERE user_id = auth.uid())
  );
-- Inserts/updates are done by backend service role (bypasses RLS)

-- ── AdSet Stats ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS adset_stats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ad_account_id uuid REFERENCES ad_accounts(id) ON DELETE CASCADE NOT NULL,
  client_id uuid REFERENCES clients(id) ON DELETE CASCADE NOT NULL,
  platform text NOT NULL,
  date date NOT NULL,
  campaign_id text NOT NULL,
  campaign_name text DEFAULT '',
  adset_id text NOT NULL,
  adset_name text NOT NULL DEFAULT '',
  status text DEFAULT '',
  spend numeric(12, 2) DEFAULT 0,
  impressions bigint DEFAULT 0,
  clicks bigint DEFAULT 0,
  reach bigint DEFAULT 0,
  leads integer DEFAULT 0,
  ctr numeric(8, 4) DEFAULT 0,
  cpl numeric(12, 2) DEFAULT 0,
  cpc numeric(12, 2) DEFAULT 0,
  currency text DEFAULT 'KZT',
  created_at timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS adset_stats_unique
  ON adset_stats(ad_account_id, adset_id, date);

CREATE INDEX IF NOT EXISTS adset_stats_client_date
  ON adset_stats(client_id, date);

ALTER TABLE adset_stats ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own adset stats" ON adset_stats
  FOR SELECT USING (
    client_id IN (SELECT id FROM clients WHERE user_id = auth.uid())
  );

-- ── Creative Stats ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS creative_stats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ad_account_id uuid REFERENCES ad_accounts(id) ON DELETE CASCADE NOT NULL,
  client_id uuid REFERENCES clients(id) ON DELETE CASCADE NOT NULL,
  platform text NOT NULL,
  date date NOT NULL,
  ad_id text NOT NULL,
  ad_name text DEFAULT '',
  adset_id text DEFAULT '',
  campaign_id text DEFAULT '',
  status text DEFAULT '',
  spend numeric(12, 2) DEFAULT 0,
  impressions bigint DEFAULT 0,
  clicks bigint DEFAULT 0,
  leads integer DEFAULT 0,
  ctr numeric(8, 4) DEFAULT 0,
  cpl numeric(12, 2) DEFAULT 0,
  image_url text,
  thumbnail_url text,
  video_url text,
  currency text DEFAULT 'KZT',
  created_at timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS creative_stats_unique
  ON creative_stats(ad_account_id, ad_id, date);

CREATE INDEX IF NOT EXISTS creative_stats_client_date
  ON creative_stats(client_id, date);

ALTER TABLE creative_stats ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own creative stats" ON creative_stats
  FOR SELECT USING (
    client_id IN (SELECT id FROM clients WHERE user_id = auth.uid())
  );

-- ── CRM Connections ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid REFERENCES clients(id) ON DELETE CASCADE NOT NULL,
  type text NOT NULL CHECK (type IN ('amocrm', 'bitrix24')),
  domain text NOT NULL,
  access_token text NOT NULL,
  refresh_token text,
  token_expires_at timestamptz,
  webhook_secret text,
  is_active boolean DEFAULT true,
  last_synced_at timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS crm_connections_unique
  ON crm_connections(client_id, type, domain);

ALTER TABLE crm_connections ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own CRM connections" ON crm_connections
  FOR ALL USING (
    client_id IN (SELECT id FROM clients WHERE user_id = auth.uid())
  );

-- ── CRM Leads ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  crm_connection_id uuid REFERENCES crm_connections(id) ON DELETE CASCADE NOT NULL,
  client_id uuid REFERENCES clients(id) ON DELETE CASCADE NOT NULL,
  crm_type text NOT NULL,
  lead_id text NOT NULL,
  lead_name text DEFAULT '',
  status text DEFAULT '',
  pipeline_id text,
  pipeline_name text,
  responsible_name text,
  created_at_crm timestamptz NOT NULL,
  closed_at timestamptz,
  price numeric(12, 2),
  currency text,
  -- UTM cross-analytics
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  utm_term text,
  -- Matched ad data (populated by cross-analytics logic)
  matched_campaign_id text,
  matched_adset_id text,
  matched_ad_id text,
  created_at timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS crm_leads_unique
  ON crm_leads(crm_connection_id, lead_id);

CREATE INDEX IF NOT EXISTS crm_leads_client_date
  ON crm_leads(client_id, created_at_crm);

CREATE INDEX IF NOT EXISTS crm_leads_utm
  ON crm_leads(client_id, utm_campaign);

ALTER TABLE crm_leads ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own CRM leads" ON crm_leads
  FOR SELECT USING (
    client_id IN (SELECT id FROM clients WHERE user_id = auth.uid())
  );

-- ── Sync Logs ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sync_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid REFERENCES clients(id) ON DELETE CASCADE NOT NULL,
  type text NOT NULL,
  status text NOT NULL CHECK (status IN ('success', 'error')),
  records_synced integer DEFAULT 0,
  error_message text,
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sync_logs_client
  ON sync_logs(client_id, created_at DESC);

ALTER TABLE sync_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own sync logs" ON sync_logs
  FOR SELECT USING (
    client_id IN (SELECT id FROM clients WHERE user_id = auth.uid())
  );
