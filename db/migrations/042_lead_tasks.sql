-- 042_lead_tasks.sql
-- Follow-up tasks attached to pipeline leads (Sales Pipeline enhancement,
-- 2026-06-09). Owner-created reminders like "Follow up on proposal Friday".
-- Surfaced in the admin Pipeline "Needs Your Attention" queue and the lead
-- drawer. Tenant-scoped like every other business table.

CREATE TABLE IF NOT EXISTS lead_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  due_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'open',          -- 'open' | 'done'
  completed_at TIMESTAMPTZ,
  created_by TEXT DEFAULT 'admin',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lead_tasks_tenant_status ON lead_tasks(tenant_id, status, due_at);
CREATE INDEX IF NOT EXISTS idx_lead_tasks_lead ON lead_tasks(lead_id);

ALTER TABLE lead_tasks ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'lead_tasks' AND policyname = 'tenant_iso_lead_tasks'
  ) THEN
    CREATE POLICY tenant_iso_lead_tasks ON lead_tasks
      FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
  END IF;
END $$;
