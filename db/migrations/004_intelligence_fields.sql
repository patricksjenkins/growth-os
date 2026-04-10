-- ============================================================================
-- Migration 004: Intelligence & Enrichment Fields
-- Extends leads and contacts for scoring, prospecting, and enrichment agents
-- ============================================================================

-- === LEADS: Add B2B intelligence fields ===
ALTER TABLE leads ADD COLUMN IF NOT EXISTS industry TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS size TEXT;                       -- e.g. '50-100', '100-250'
ALTER TABLE leads ADD COLUMN IF NOT EXISTS website TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS domain TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS lifecycle_stage TEXT DEFAULT 'prospect';  -- prospect → enriched → scored → sequenced → meeting_booked → won/lost
ALTER TABLE leads ADD COLUMN IF NOT EXISTS outreach_ready BOOLEAN DEFAULT false;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS outreach_recommendation TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS enrichment_status TEXT;          -- pending, enriched, failed
ALTER TABLE leads ADD COLUMN IF NOT EXISTS enriched_at TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS employee_count_actual INTEGER;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS hq_state TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';    -- flexible vertical-specific data

-- === CONTACTS: Add intelligence fields ===
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS first_name TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_name TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS linkedin_url TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS role_in_buying TEXT;          -- decision_maker, influencer, champion, user
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS is_primary_contact BOOLEAN DEFAULT false;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS contact_status TEXT DEFAULT 'active';
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS source TEXT;                  -- serper_openai, manual, import, calendly

-- === INDEXES for intelligence queries ===
CREATE INDEX IF NOT EXISTS idx_leads_lifecycle ON leads(tenant_id, lifecycle_stage);
CREATE INDEX IF NOT EXISTS idx_leads_outreach ON leads(tenant_id, outreach_ready) WHERE outreach_ready = true;
CREATE INDEX IF NOT EXISTS idx_leads_enrichment ON leads(tenant_id, enrichment_status);
CREATE INDEX IF NOT EXISTS idx_leads_tier ON leads(tenant_id, priority_tier);
CREATE INDEX IF NOT EXISTS idx_contacts_lead ON contacts(lead_id);
CREATE INDEX IF NOT EXISTS idx_contacts_role ON contacts(tenant_id, role_in_buying);

-- === SYSTEM CONFIG: Scoring ICP parameters ===
-- These get inserted per-tenant via seed scripts, but we ensure the system_config table exists
CREATE TABLE IF NOT EXISTS system_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(tenant_id, key)
);

CREATE INDEX IF NOT EXISTS idx_system_config_tenant ON system_config(tenant_id, key);
