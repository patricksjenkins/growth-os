-- ─────────────────────────────────────────────────────────────────────
-- 059_growth_engine.sql — Growth Engine snapshot + weekly campaign focus
--
-- The prospecting-orchestrator (rules-based, no paid API, no sends) writes one
-- growth_engine_snapshots row per run. The Command Center reads the latest row
-- so the /admin/growth page and the Dashboard "Next Best Actions" band load
-- cheaply without recomputing the funnel on every request.
--
-- growth_campaign_focus holds the owner-approved weekly direction (vertical /
-- geography / angle). The orchestrator may RECOMMEND a focus but never
-- auto-activates one — status starts 'recommended' until the owner approves.
--
-- Strictly additive. RLS tenant isolation mirrors 047_targeted_campaigns.sql.
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS growth_engine_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  snapshot_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  focus JSONB NOT NULL DEFAULT '{}',            -- { vertical, geography, angle, status, week_start }
  funnel JSONB NOT NULL DEFAULT '{}',           -- { new_this_week, enriched, email_ready, ... closed_won }
  stage_counts JSONB NOT NULL DEFAULT '{}',     -- raw lifecycle_stage / status tallies
  next_actions JSONB NOT NULL DEFAULT '[]',     -- [{ id, label, count, severity, link }]
  alerts JSONB NOT NULL DEFAULT '[]',           -- [{ id, label, detail, severity }]
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_growth_snap_tenant ON growth_engine_snapshots(tenant_id, snapshot_at DESC);

CREATE TABLE IF NOT EXISTS growth_campaign_focus (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  week_start DATE NOT NULL,
  vertical TEXT,
  geography TEXT,
  angle TEXT,
  status TEXT NOT NULL DEFAULT 'recommended',   -- recommended | approved | active | done
  rationale TEXT,
  created_by TEXT DEFAULT 'system',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_growth_focus_week ON growth_campaign_focus(tenant_id, week_start);

-- ─────────────────────────────────────────────────────────────────────
-- RLS — tenant isolation (same pattern as 047).
-- ─────────────────────────────────────────────────────────────────────
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['growth_engine_snapshots','growth_campaign_focus'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = 'tenant_iso_' || t
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON %I FOR ALL USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid)',
        'tenant_iso_' || t, t
      );
    END IF;
  END LOOP;
END $$;
