-- ============================================================================
-- Migration 067: Additive agent outcome observability
-- Date: 2026-07-24
--
-- Separates handler execution, returned result, useful output, quality,
-- delivery, and business outcome. Existing agent_jobs rows and status behavior
-- remain unchanged. The worker treats this table as best-effort observability,
-- so code may be deployed before the migration without affecting tenant jobs.
--
-- ROLLBACK: db/rollbacks/067_agent_job_outcomes_rollback.sql
-- ============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_jobs_id_tenant
  ON public.agent_jobs (id, tenant_id);

CREATE TABLE IF NOT EXISTS public.agent_job_outcomes (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                   uuid NOT NULL,
  tenant_id                uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  agent_name               text NOT NULL,
  schema_version           integer NOT NULL DEFAULT 1,
  contract_source          text NOT NULL DEFAULT 'legacy_adapter'
                             CHECK (contract_source IN ('declared', 'legacy_adapter')),
  execution_state          text NOT NULL
                             CHECK (execution_state IN ('completed', 'failed')),
  result_state             text NOT NULL
                             CHECK (result_state IN ('succeeded', 'failed', 'unknown')),
  output_state             text NOT NULL
                             CHECK (output_state IN ('produced', 'no_output', 'no_op', 'unknown')),
  quality_state            text NOT NULL
                             CHECK (quality_state IN ('accepted', 'rejected', 'unverified', 'unknown')),
  delivery_state           text NOT NULL
                             CHECK (delivery_state IN ('delivered', 'not_delivered', 'not_applicable', 'unknown')),
  business_outcome_state   text NOT NULL
                             CHECK (business_outcome_state IN ('achieved', 'not_achieved', 'not_applicable', 'unverified', 'unknown')),
  reason_code              text,
  evidence                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  duration_ms              integer,
  observed_at              timestamptz NOT NULL DEFAULT now(),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id),
  FOREIGN KEY (job_id, tenant_id)
    REFERENCES public.agent_jobs(id, tenant_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_job_outcomes_tenant_observed
  ON public.agent_job_outcomes (tenant_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_job_outcomes_agent_observed
  ON public.agent_job_outcomes (agent_name, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_job_outcomes_business_state
  ON public.agent_job_outcomes (tenant_id, business_outcome_state, observed_at DESC);

ALTER TABLE public.agent_job_outcomes ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'agent_job_outcomes'
       AND policyname = 'tenant_iso_agent_job_outcomes'
  ) THEN
    CREATE POLICY tenant_iso_agent_job_outcomes
      ON public.agent_job_outcomes
      FOR SELECT TO authenticated
      USING (
        tenant_id = NULLIF(auth.jwt()->'app_metadata'->>'tenant_id', '')::uuid
        AND auth.jwt()->'app_metadata'->>'role'
          IN (
            'owner', 'platform_owner', 'founder', 'admin',
            'client_owner', 'tenant_owner'
          )
      );
  END IF;
END $$;

GRANT SELECT ON public.agent_job_outcomes TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.agent_job_outcomes FROM authenticated;
