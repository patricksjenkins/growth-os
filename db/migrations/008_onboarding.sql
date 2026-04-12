-- ============================================================================
-- Migration 008: Onboarding Workflows
-- Tables for tracking the 7-day automated client onboarding process
-- ============================================================================

-- === Onboarding Workflows ===
CREATE TABLE IF NOT EXISTS onboarding_workflows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active',
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  current_day INTEGER NOT NULL DEFAULT 0,
  intake_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- === Onboarding Steps ===
CREATE TABLE IF NOT EXISTS onboarding_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_id UUID NOT NULL REFERENCES onboarding_workflows(id) ON DELETE CASCADE,
  day INTEGER NOT NULL,
  step_name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  completed_at TIMESTAMPTZ,
  automated BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- === Indexes ===
CREATE INDEX IF NOT EXISTS idx_onboarding_wf_tenant ON onboarding_workflows(tenant_id);
CREATE INDEX IF NOT EXISTS idx_onboarding_wf_status ON onboarding_workflows(status);
CREATE INDEX IF NOT EXISTS idx_onboarding_steps_workflow ON onboarding_steps(workflow_id);
CREATE INDEX IF NOT EXISTS idx_onboarding_steps_tenant ON onboarding_steps(tenant_id);
CREATE INDEX IF NOT EXISTS idx_onboarding_steps_status ON onboarding_steps(status);
CREATE INDEX IF NOT EXISTS idx_onboarding_steps_day ON onboarding_steps(day);

-- === RLS ===
ALTER TABLE onboarding_workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_steps ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY tenant_iso_onboarding_wf ON onboarding_workflows FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY tenant_iso_onboarding_steps ON onboarding_steps FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
