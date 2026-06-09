-- 043_outreach_batches.sql
-- Bulk outreach send batches (Sales Pipeline enhancement, 2026-06-09).
-- One row per "Review & Send Selected" action from the admin Pipeline.
-- Each item in `items` carries its own status so a single failed send
-- never poisons the batch, and Retry Failed can re-queue only failures.
-- The actual per-prospect send reuses the exact individual approve/send
-- path — this table only orchestrates and records.

CREATE TABLE IF NOT EXISTS outreach_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'running',        -- 'running' | 'completed'
  channel TEXT NOT NULL DEFAULT 'email',
  created_by TEXT DEFAULT 'admin',
  -- [{ lead_id, sequence_id, company, status: 'queued'|'sending'|'sent'|'failed'|'skipped', error }]
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  retry_of UUID REFERENCES outreach_batches(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_outreach_batches_tenant ON outreach_batches(tenant_id, created_at DESC);

ALTER TABLE outreach_batches ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'outreach_batches' AND policyname = 'tenant_iso_outreach_batches'
  ) THEN
    CREATE POLICY tenant_iso_outreach_batches ON outreach_batches
      FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
  END IF;
END $$;
