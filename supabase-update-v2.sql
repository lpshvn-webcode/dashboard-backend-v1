-- ============================================================
-- Nova Analytics - Schema Update v2
-- Run this in Supabase SQL Editor (after initial schema)
-- ============================================================

-- Add settings JSONB column to clients table
ALTER TABLE clients ADD COLUMN IF NOT EXISTS settings JSONB DEFAULT '{}';

-- Update existing clients to have default empty settings
UPDATE clients SET settings = '{}' WHERE settings IS NULL;
