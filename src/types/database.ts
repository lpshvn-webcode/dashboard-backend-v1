export interface Database {
  public: {
    Tables: {
      clients: {
        Row: Client;
        Insert: Omit<Client, 'id' | 'created_at'>;
        Update: Partial<Omit<Client, 'id' | 'created_at'>>;
      };
      ad_accounts: {
        Row: AdAccount;
        Insert: Omit<AdAccount, 'id' | 'created_at'>;
        Update: Partial<Omit<AdAccount, 'id' | 'created_at'>>;
      };
      campaign_stats: {
        Row: CampaignStat;
        Insert: Omit<CampaignStat, 'id' | 'created_at'>;
        Update: Partial<Omit<CampaignStat, 'id' | 'created_at'>>;
      };
      adset_stats: {
        Row: AdsetStat;
        Insert: Omit<AdsetStat, 'id' | 'created_at'>;
        Update: Partial<Omit<AdsetStat, 'id' | 'created_at'>>;
      };
      creative_stats: {
        Row: CreativeStat;
        Insert: Omit<CreativeStat, 'id' | 'created_at'>;
        Update: Partial<Omit<CreativeStat, 'id' | 'created_at'>>;
      };
      crm_connections: {
        Row: CrmConnection;
        Insert: Omit<CrmConnection, 'id' | 'created_at'>;
        Update: Partial<Omit<CrmConnection, 'id' | 'created_at'>>;
      };
      crm_leads: {
        Row: CrmLead;
        Insert: Omit<CrmLead, 'id' | 'created_at'>;
        Update: Partial<Omit<CrmLead, 'id' | 'created_at'>>;
      };
      sync_logs: {
        Row: SyncLog;
        Insert: Omit<SyncLog, 'id' | 'created_at'>;
        Update: Partial<Omit<SyncLog, 'id' | 'created_at'>>;
      };
    };
  };
}

export interface Client {
  id: string;
  user_id: string;
  name: string;
  sheet_url: string;
  position: number;
  created_at: string;
}

export type AdPlatform = 'facebook' | 'google' | 'tiktok';

export interface AdAccount {
  id: string;
  client_id: string;
  platform: AdPlatform;
  account_id: string;       // Platform-specific account ID
  account_name: string;
  access_token: string;     // Encrypted in production
  refresh_token?: string;
  token_expires_at?: string;
  is_active: boolean;
  last_synced_at?: string;
  created_at: string;
}

export interface CampaignStat {
  id: string;
  ad_account_id: string;
  client_id: string;
  platform: AdPlatform;
  date: string;             // YYYY-MM-DD
  campaign_id: string;
  campaign_name: string;
  status: string;
  spend: number;
  impressions: number;
  clicks: number;
  reach: number;
  leads: number;            // Lead form submissions
  ctr: number;
  cpl: number;              // Cost per lead
  cpc: number;
  currency: string;
  created_at: string;
}

export interface AdsetStat {
  id: string;
  ad_account_id: string;
  client_id: string;
  platform: AdPlatform;
  date: string;
  campaign_id: string;
  campaign_name: string;
  adset_id: string;
  adset_name: string;
  status: string;
  spend: number;
  impressions: number;
  clicks: number;
  reach: number;
  leads: number;
  ctr: number;
  cpl: number;
  cpc: number;
  currency: string;
  created_at: string;
}

export interface CreativeStat {
  id: string;
  ad_account_id: string;
  client_id: string;
  platform: AdPlatform;
  date: string;
  ad_id: string;
  ad_name: string;
  adset_id: string;
  campaign_id: string;
  status: string;
  spend: number;
  impressions: number;
  clicks: number;
  leads: number;
  ctr: number;
  cpl: number;
  image_url?: string;
  thumbnail_url?: string;
  video_url?: string;
  currency: string;
  created_at: string;
}

export type CrmType = 'amocrm' | 'bitrix24';
export type CrmSyncType = 'leads' | 'deals' | 'both';

export interface CrmConnection {
  id: string;
  client_id: string;
  type: CrmType;
  domain: string;           // e.g. mycompany.amocrm.ru or mycompany.bitrix24.ru
  access_token: string;
  refresh_token?: string;
  token_expires_at?: string;
  webhook_secret?: string;
  sync_type: CrmSyncType;   // 'leads' | 'deals' | 'both' (Bitrix24 only)
  is_active: boolean;
  last_synced_at?: string;
  created_at: string;
}

export interface CrmLead {
  id: string;
  crm_connection_id: string;
  client_id: string;
  crm_type: CrmType;
  lead_id: string;          // CRM's own lead ID (prefixed: 'L_' for leads, 'D_' for deals)
  lead_name: string;
  status: string;
  pipeline_id?: string;
  pipeline_name?: string;
  responsible_name?: string;
  created_at_crm: string;   // When lead was created in CRM
  closed_at?: string;
  price?: number;
  currency?: string;
  phone?: string;           // Phone number for deduplication
  record_type?: string;     // 'lead' or 'deal'
  is_duplicate?: boolean;   // Marked if same phone exists in both leads and deals
  // UTM params for cross-analytics
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
  // Matched ad data
  matched_campaign_id?: string;
  matched_adset_id?: string;
  matched_ad_id?: string;
  created_at: string;
}

export interface SyncLog {
  id: string;
  client_id: string;
  type: 'facebook' | 'google' | 'tiktok' | 'amocrm' | 'bitrix24';
  status: 'success' | 'error';
  records_synced: number;
  error_message?: string;
  started_at: string;
  finished_at: string;
  created_at: string;
}
