-- ============================================================================
-- Migration 079: Shadow billing/customer/revenue/margin attribution (G15)
-- Date: 2026-07-24
--
-- Additive and inert by default. Existing finance_entries, totals, APIs,
-- Stripe webhooks, billing behavior, and customer records are unchanged.
-- Provider calls and historical backfills are intentionally outside this
-- migration. Writes require service_role plus an explicit false-by-default
-- feature gate and are available only through the atomic RPCs below.
--
-- ROLLBACK: db/rollbacks/079_billing_customer_attribution_rollback.sql
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.billing_identity_mappings (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  scope_type            text NOT NULL CHECK (scope_type IN ('tenant', 'customer')),
  customer_id           uuid REFERENCES public.customers(id) ON DELETE RESTRICT,
  provider              text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]{1,39}$'),
  provider_account_ref  text NOT NULL
    CHECK (
      char_length(provider_account_ref) BETWEEN 2 AND 255
      AND provider_account_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{1,254}$'
    ),
  provider_object_type  text NOT NULL
    CHECK (provider_object_type IN ('tenant', 'customer', 'subscription')),
  provider_object_ref   text NOT NULL
    CHECK (
      char_length(provider_object_ref) BETWEEN 2 AND 255
      AND provider_object_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{1,254}$'
    ),
  authority_state       text NOT NULL DEFAULT 'authoritative'
    CHECK (authority_state = 'authoritative'),
  evidence_type         text NOT NULL CHECK (evidence_type ~ '^[a-z][a-z0-9_]{1,39}$'),
  evidence_id           text NOT NULL
    CHECK (
      char_length(evidence_id) BETWEEN 2 AND 255
      AND evidence_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{1,254}$'
    ),
  evidence_digest       text NOT NULL CHECK (evidence_digest ~ '^[a-f0-9]{64}$'),
  evidence_observed_at  timestamptz NOT NULL,
  actor_type            text NOT NULL CHECK (actor_type IN ('service', 'system')),
  actor_id              text,
  idempotency_key       text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  request_fingerprint   text NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (provider, provider_account_ref, provider_object_type, provider_object_ref),
  CHECK (
    (scope_type = 'tenant' AND customer_id IS NULL AND provider_object_type = 'tenant')
    OR
    (
      scope_type = 'customer'
      AND customer_id IS NOT NULL
      AND provider_object_type IN ('customer', 'subscription')
    )
  ),
  CHECK (
    (actor_type = 'system' AND actor_id IS NULL)
    OR
    (
      actor_type = 'service'
      AND NULLIF(btrim(actor_id), '') IS NOT NULL
      AND char_length(btrim(actor_id)) BETWEEN 2 AND 160
    )
  ),
  CHECK (evidence_observed_at <= created_at + interval '5 minutes')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_identity_tenant_scope
  ON public.billing_identity_mappings (
    tenant_id, provider, provider_account_ref, provider_object_type
  )
  WHERE scope_type = 'tenant';
CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_identity_customer_scope
  ON public.billing_identity_mappings (
    tenant_id, customer_id, provider, provider_account_ref, provider_object_type
  )
  WHERE scope_type = 'customer' AND provider_object_type = 'customer';
CREATE INDEX IF NOT EXISTS idx_billing_identity_customer
  ON public.billing_identity_mappings (tenant_id, customer_id, provider);

CREATE TABLE IF NOT EXISTS public.finance_attribution_records (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                  uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  customer_id                uuid NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  tenant_mapping_id          uuid NOT NULL,
  customer_mapping_id        uuid NOT NULL,
  provider                   text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]{1,39}$'),
  provider_account_ref       text NOT NULL
    CHECK (
      char_length(provider_account_ref) BETWEEN 2 AND 255
      AND provider_account_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{1,254}$'
    ),
  source_event_type          text NOT NULL
    CHECK (source_event_type ~ '^[a-z][a-z0-9_]{1,39}$'),
  source_event_id            text NOT NULL
    CHECK (
      char_length(source_event_id) BETWEEN 2 AND 255
      AND source_event_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{1,254}$'
    ),
  occurred_on                date NOT NULL,
  currency                   text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  revenue_minor              bigint NOT NULL,
  cost_minor                 bigint NOT NULL,
  margin_minor               bigint GENERATED ALWAYS AS (revenue_minor - cost_minor) STORED,
  reconciliation_status      text NOT NULL
    CHECK (reconciliation_status IN ('pending', 'matched', 'exception')),
  reconciled_revenue_minor   bigint,
  reconciled_cost_minor      bigint,
  evidence_digest            text NOT NULL CHECK (evidence_digest ~ '^[a-f0-9]{64}$'),
  evidence_observed_at       timestamptz NOT NULL,
  actor_type                 text NOT NULL CHECK (actor_type IN ('service', 'system')),
  actor_id                   text,
  idempotency_key            text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  request_fingerprint        text NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (provider, provider_account_ref, source_event_type, source_event_id),
  FOREIGN KEY (tenant_mapping_id, tenant_id)
    REFERENCES public.billing_identity_mappings(id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (customer_mapping_id, tenant_id)
    REFERENCES public.billing_identity_mappings(id, tenant_id) ON DELETE RESTRICT,
  CHECK (
    (actor_type = 'system' AND actor_id IS NULL)
    OR
    (
      actor_type = 'service'
      AND NULLIF(btrim(actor_id), '') IS NOT NULL
      AND char_length(btrim(actor_id)) BETWEEN 2 AND 160
    )
  ),
  CHECK (evidence_observed_at <= created_at + interval '5 minutes'),
  CHECK (
    (
      reconciliation_status = 'pending'
      AND reconciled_revenue_minor IS NULL
      AND reconciled_cost_minor IS NULL
    )
    OR
    (
      reconciliation_status = 'matched'
      AND reconciled_revenue_minor = revenue_minor
      AND reconciled_cost_minor = cost_minor
    )
    OR
    (
      reconciliation_status = 'exception'
      AND reconciled_revenue_minor IS NOT NULL
      AND reconciled_cost_minor IS NOT NULL
      AND (
        reconciled_revenue_minor <> revenue_minor
        OR reconciled_cost_minor <> cost_minor
      )
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_finance_attribution_tenant_period
  ON public.finance_attribution_records (tenant_id, occurred_on DESC);
CREATE INDEX IF NOT EXISTS idx_finance_attribution_customer_period
  ON public.finance_attribution_records (tenant_id, customer_id, occurred_on DESC);
CREATE INDEX IF NOT EXISTS idx_finance_attribution_reconciliation
  ON public.finance_attribution_records (
    tenant_id, reconciliation_status, occurred_on DESC
  );

CREATE OR REPLACE FUNCTION public.billing_attribution_immutable_row()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'billing_attribution_evidence_is_immutable';
END;
$$;

DROP TRIGGER IF EXISTS trg_billing_identity_mappings_immutable
  ON public.billing_identity_mappings;
CREATE TRIGGER trg_billing_identity_mappings_immutable
  BEFORE UPDATE OR DELETE ON public.billing_identity_mappings
  FOR EACH ROW EXECUTE FUNCTION public.billing_attribution_immutable_row();

DROP TRIGGER IF EXISTS trg_finance_attribution_records_immutable
  ON public.finance_attribution_records;
CREATE TRIGGER trg_finance_attribution_records_immutable
  BEFORE UPDATE OR DELETE ON public.finance_attribution_records
  FOR EACH ROW EXECUTE FUNCTION public.billing_attribution_immutable_row();

CREATE OR REPLACE FUNCTION public.billing_identity_tenant_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.customer_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM public.customers customer
     WHERE customer.id = NEW.customer_id
       AND customer.tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'billing_identity_customer_not_found_for_tenant';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_billing_identity_tenant_guard
  ON public.billing_identity_mappings;
CREATE TRIGGER trg_billing_identity_tenant_guard
  BEFORE INSERT ON public.billing_identity_mappings
  FOR EACH ROW EXECUTE FUNCTION public.billing_identity_tenant_guard();

CREATE OR REPLACE FUNCTION public.finance_attribution_tenant_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_tenant_mapping public.billing_identity_mappings%ROWTYPE;
  v_customer_mapping public.billing_identity_mappings%ROWTYPE;
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.customers customer
     WHERE customer.id = NEW.customer_id
       AND customer.tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'finance_attribution_customer_not_found_for_tenant';
  END IF;

  SELECT mapping.* INTO STRICT v_tenant_mapping
    FROM public.billing_identity_mappings mapping
   WHERE mapping.id = NEW.tenant_mapping_id
     AND mapping.tenant_id = NEW.tenant_id;
  SELECT mapping.* INTO STRICT v_customer_mapping
    FROM public.billing_identity_mappings mapping
   WHERE mapping.id = NEW.customer_mapping_id
     AND mapping.tenant_id = NEW.tenant_id;

  IF v_tenant_mapping.scope_type <> 'tenant'
     OR v_tenant_mapping.customer_id IS NOT NULL
     OR v_customer_mapping.scope_type <> 'customer'
     OR v_customer_mapping.customer_id IS DISTINCT FROM NEW.customer_id
     OR v_tenant_mapping.provider IS DISTINCT FROM NEW.provider
     OR v_customer_mapping.provider IS DISTINCT FROM NEW.provider
     OR v_tenant_mapping.provider_account_ref IS DISTINCT FROM NEW.provider_account_ref
     OR v_customer_mapping.provider_account_ref IS DISTINCT FROM NEW.provider_account_ref
     OR v_tenant_mapping.authority_state <> 'authoritative'
     OR v_customer_mapping.authority_state <> 'authoritative' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'finance_attribution_identity_chain_invalid';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_finance_attribution_tenant_guard
  ON public.finance_attribution_records;
CREATE TRIGGER trg_finance_attribution_tenant_guard
  BEFORE INSERT ON public.finance_attribution_records
  FOR EACH ROW EXECUTE FUNCTION public.finance_attribution_tenant_guard();

ALTER TABLE public.billing_identity_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_attribution_records ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON
  public.billing_identity_mappings,
  public.finance_attribution_records
FROM PUBLIC, anon, authenticated;
GRANT SELECT ON
  public.billing_identity_mappings,
  public.finance_attribution_records
TO service_role;
REVOKE INSERT, UPDATE, DELETE ON
  public.billing_identity_mappings,
  public.finance_attribution_records
FROM service_role;

REVOKE EXECUTE ON FUNCTION public.billing_attribution_immutable_row()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.billing_identity_tenant_guard()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.finance_attribution_tenant_guard()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.billing_identity_register_rpc(
  p_tenant_id uuid,
  p_scope_type text,
  p_customer_id uuid,
  p_provider text,
  p_provider_account_ref text,
  p_provider_object_type text,
  p_provider_object_ref text,
  p_evidence_type text,
  p_evidence_id text,
  p_evidence_digest text,
  p_evidence_observed_at timestamptz,
  p_actor_type text,
  p_actor_id text,
  p_idempotency_key text,
  p_request_fingerprint text,
  p_feature_gate_enabled boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_claims text;
  v_calling_role text;
  v_existing public.billing_identity_mappings%ROWTYPE;
  v_mapping public.billing_identity_mappings%ROWTYPE;
BEGIN
  v_claims := NULLIF(current_setting('request.jwt.claims', true), '');
  v_calling_role := COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    CASE WHEN v_claims IS NOT NULL THEN v_claims::jsonb ->> 'role' END,
    session_user::text
  );
  IF v_calling_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'billing_identity_registration_requires_service_role';
  END IF;
  IF p_feature_gate_enabled IS DISTINCT FROM true THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'billing_attribution_writes_disabled';
  END IF;
  IF p_tenant_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.tenants tenant
     WHERE tenant.id = p_tenant_id AND tenant.status = 'active'
  ) THEN
    RAISE EXCEPTION 'billing_identity_active_tenant_required';
  END IF;
  IF p_scope_type NOT IN ('tenant', 'customer')
     OR p_provider_object_type NOT IN ('tenant', 'customer', 'subscription')
     OR (p_scope_type = 'tenant' AND (
       p_customer_id IS NOT NULL OR p_provider_object_type <> 'tenant'
     ))
     OR (p_scope_type = 'customer' AND (
       p_customer_id IS NULL OR p_provider_object_type = 'tenant'
     )) THEN
    RAISE EXCEPTION 'billing_identity_scope_invalid';
  END IF;
  IF p_provider !~ '^[a-z][a-z0-9_]{1,39}$'
     OR p_provider_account_ref !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{1,254}$'
     OR p_provider_object_ref !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{1,254}$'
     OR p_evidence_type !~ '^[a-z][a-z0-9_]{1,39}$'
     OR p_evidence_id !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{1,254}$'
     OR char_length(p_idempotency_key) NOT BETWEEN 8 AND 200
     OR p_request_fingerprint !~ '^[a-f0-9]{64}$'
     OR p_evidence_digest !~ '^[a-f0-9]{64}$'
     OR p_evidence_observed_at IS NULL
     OR p_evidence_observed_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'billing_identity_evidence_invalid';
  END IF;
  IF p_actor_type NOT IN ('service', 'system')
     OR (p_actor_type = 'system' AND p_actor_id IS NOT NULL)
     OR (
       p_actor_type = 'service'
       AND (
         NULLIF(btrim(p_actor_id), '') IS NULL
         OR char_length(btrim(p_actor_id)) NOT BETWEEN 2 AND 160
       )
     ) THEN
    RAISE EXCEPTION 'billing_identity_actor_invalid';
  END IF;
  IF p_customer_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.customers customer
     WHERE customer.id = p_customer_id AND customer.tenant_id = p_tenant_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'billing_identity_customer_not_found_for_tenant';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_provider || ':' || p_provider_account_ref || ':'
      || p_provider_object_type || ':' || p_provider_object_ref,
    0
  ));

  SELECT mapping.* INTO v_existing
    FROM public.billing_identity_mappings mapping
   WHERE mapping.tenant_id = p_tenant_id
     AND mapping.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.request_fingerprint IS DISTINCT FROM p_request_fingerprint
       OR v_existing.scope_type IS DISTINCT FROM p_scope_type
       OR v_existing.customer_id IS DISTINCT FROM p_customer_id
       OR v_existing.provider IS DISTINCT FROM p_provider
       OR v_existing.provider_account_ref IS DISTINCT FROM p_provider_account_ref
       OR v_existing.provider_object_type IS DISTINCT FROM p_provider_object_type
       OR v_existing.provider_object_ref IS DISTINCT FROM p_provider_object_ref
       OR v_existing.evidence_type IS DISTINCT FROM p_evidence_type
       OR v_existing.evidence_id IS DISTINCT FROM p_evidence_id
       OR v_existing.evidence_digest IS DISTINCT FROM p_evidence_digest
       OR v_existing.evidence_observed_at IS DISTINCT FROM p_evidence_observed_at
       OR v_existing.actor_type IS DISTINCT FROM p_actor_type
       OR v_existing.actor_id IS DISTINCT FROM p_actor_id THEN
      RAISE EXCEPTION USING ERRCODE = '23505',
        MESSAGE = 'billing_identity_idempotency_conflict';
    END IF;
    RETURN jsonb_build_object('outcome', 'replay', 'mapping', to_jsonb(v_existing));
  END IF;

  SELECT mapping.* INTO v_existing
    FROM public.billing_identity_mappings mapping
   WHERE mapping.provider = p_provider
     AND mapping.provider_account_ref = p_provider_account_ref
     AND mapping.provider_object_type = p_provider_object_type
     AND mapping.provider_object_ref = p_provider_object_ref
   FOR UPDATE;
  IF FOUND THEN
    IF v_existing.tenant_id IS DISTINCT FROM p_tenant_id
       OR v_existing.scope_type IS DISTINCT FROM p_scope_type
       OR v_existing.customer_id IS DISTINCT FROM p_customer_id THEN
      RAISE EXCEPTION USING ERRCODE = '23505',
        MESSAGE = 'billing_identity_cross_tenant_or_customer_conflict';
    END IF;
    RETURN jsonb_build_object(
      'outcome', 'already_registered',
      'mapping', to_jsonb(v_existing)
    );
  END IF;

  INSERT INTO public.billing_identity_mappings (
    tenant_id, scope_type, customer_id, provider, provider_account_ref,
    provider_object_type, provider_object_ref, evidence_type, evidence_id,
    evidence_digest, evidence_observed_at, actor_type, actor_id,
    idempotency_key, request_fingerprint
  ) VALUES (
    p_tenant_id, p_scope_type, p_customer_id, p_provider,
    p_provider_account_ref, p_provider_object_type, p_provider_object_ref,
    p_evidence_type, p_evidence_id, p_evidence_digest,
    p_evidence_observed_at, p_actor_type, p_actor_id,
    p_idempotency_key, p_request_fingerprint
  ) RETURNING * INTO v_mapping;

  RETURN jsonb_build_object('outcome', 'registered', 'mapping', to_jsonb(v_mapping));
END;
$$;

CREATE OR REPLACE FUNCTION public.finance_attribution_record_rpc(
  p_tenant_id uuid,
  p_customer_id uuid,
  p_tenant_mapping_id uuid,
  p_customer_mapping_id uuid,
  p_provider text,
  p_provider_account_ref text,
  p_source_event_type text,
  p_source_event_id text,
  p_occurred_on date,
  p_currency text,
  p_revenue_minor bigint,
  p_cost_minor bigint,
  p_reconciliation_status text,
  p_reconciled_revenue_minor bigint,
  p_reconciled_cost_minor bigint,
  p_evidence_digest text,
  p_evidence_observed_at timestamptz,
  p_actor_type text,
  p_actor_id text,
  p_idempotency_key text,
  p_request_fingerprint text,
  p_feature_gate_enabled boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_claims text;
  v_calling_role text;
  v_existing public.finance_attribution_records%ROWTYPE;
  v_record public.finance_attribution_records%ROWTYPE;
  v_tenant_mapping public.billing_identity_mappings%ROWTYPE;
  v_customer_mapping public.billing_identity_mappings%ROWTYPE;
BEGIN
  v_claims := NULLIF(current_setting('request.jwt.claims', true), '');
  v_calling_role := COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    CASE WHEN v_claims IS NOT NULL THEN v_claims::jsonb ->> 'role' END,
    session_user::text
  );
  IF v_calling_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'finance_attribution_requires_service_role';
  END IF;
  IF p_feature_gate_enabled IS DISTINCT FROM true THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'billing_attribution_writes_disabled';
  END IF;
  IF p_tenant_id IS NULL OR p_customer_id IS NULL
     OR p_tenant_mapping_id IS NULL OR p_customer_mapping_id IS NULL THEN
    RAISE EXCEPTION 'finance_attribution_identity_required';
  END IF;
  IF p_provider !~ '^[a-z][a-z0-9_]{1,39}$'
     OR p_provider_account_ref !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{1,254}$'
     OR p_source_event_type !~ '^[a-z][a-z0-9_]{1,39}$'
     OR p_source_event_id !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{1,254}$'
     OR p_occurred_on IS NULL
     OR p_currency !~ '^[A-Z]{3}$'
     OR p_revenue_minor IS NULL
     OR p_cost_minor IS NULL
     OR p_reconciliation_status NOT IN ('pending', 'matched', 'exception')
     OR char_length(p_idempotency_key) NOT BETWEEN 8 AND 200
     OR p_request_fingerprint !~ '^[a-f0-9]{64}$'
     OR p_evidence_digest !~ '^[a-f0-9]{64}$'
     OR p_evidence_observed_at IS NULL
     OR p_evidence_observed_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'finance_attribution_evidence_invalid';
  END IF;
  IF (
    p_reconciliation_status = 'pending'
    AND (p_reconciled_revenue_minor IS NOT NULL OR p_reconciled_cost_minor IS NOT NULL)
  ) OR (
    p_reconciliation_status = 'matched'
    AND (
      p_reconciled_revenue_minor IS DISTINCT FROM p_revenue_minor
      OR p_reconciled_cost_minor IS DISTINCT FROM p_cost_minor
    )
  ) OR (
    p_reconciliation_status = 'exception'
    AND (
      p_reconciled_revenue_minor IS NULL
      OR p_reconciled_cost_minor IS NULL
      OR (
        p_reconciled_revenue_minor = p_revenue_minor
        AND p_reconciled_cost_minor = p_cost_minor
      )
    )
  ) THEN
    RAISE EXCEPTION 'finance_attribution_reconciliation_invalid';
  END IF;
  IF p_actor_type NOT IN ('service', 'system')
     OR (p_actor_type = 'system' AND p_actor_id IS NOT NULL)
     OR (
       p_actor_type = 'service'
       AND (
         NULLIF(btrim(p_actor_id), '') IS NULL
         OR char_length(btrim(p_actor_id)) NOT BETWEEN 2 AND 160
       )
     ) THEN
    RAISE EXCEPTION 'finance_attribution_actor_invalid';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.customers customer
     WHERE customer.id = p_customer_id AND customer.tenant_id = p_tenant_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'finance_attribution_customer_not_found_for_tenant';
  END IF;

  SELECT mapping.* INTO STRICT v_tenant_mapping
    FROM public.billing_identity_mappings mapping
   WHERE mapping.id = p_tenant_mapping_id
     AND mapping.tenant_id = p_tenant_id
   FOR SHARE;
  SELECT mapping.* INTO STRICT v_customer_mapping
    FROM public.billing_identity_mappings mapping
   WHERE mapping.id = p_customer_mapping_id
     AND mapping.tenant_id = p_tenant_id
   FOR SHARE;
  IF v_tenant_mapping.scope_type <> 'tenant'
     OR v_tenant_mapping.customer_id IS NOT NULL
     OR v_customer_mapping.scope_type <> 'customer'
     OR v_customer_mapping.customer_id IS DISTINCT FROM p_customer_id
     OR v_tenant_mapping.provider IS DISTINCT FROM p_provider
     OR v_customer_mapping.provider IS DISTINCT FROM p_provider
     OR v_tenant_mapping.provider_account_ref IS DISTINCT FROM p_provider_account_ref
     OR v_customer_mapping.provider_account_ref IS DISTINCT FROM p_provider_account_ref
     OR v_tenant_mapping.authority_state <> 'authoritative'
     OR v_customer_mapping.authority_state <> 'authoritative' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'finance_attribution_identity_chain_invalid';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_provider || ':' || p_provider_account_ref || ':'
      || p_source_event_type || ':' || p_source_event_id,
    0
  ));

  SELECT record.* INTO v_existing
    FROM public.finance_attribution_records record
   WHERE record.tenant_id = p_tenant_id
     AND record.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.request_fingerprint IS DISTINCT FROM p_request_fingerprint
       OR v_existing.customer_id IS DISTINCT FROM p_customer_id
       OR v_existing.tenant_mapping_id IS DISTINCT FROM p_tenant_mapping_id
       OR v_existing.customer_mapping_id IS DISTINCT FROM p_customer_mapping_id
       OR v_existing.provider IS DISTINCT FROM p_provider
       OR v_existing.provider_account_ref IS DISTINCT FROM p_provider_account_ref
       OR v_existing.source_event_type IS DISTINCT FROM p_source_event_type
       OR v_existing.source_event_id IS DISTINCT FROM p_source_event_id
       OR v_existing.occurred_on IS DISTINCT FROM p_occurred_on
       OR v_existing.currency IS DISTINCT FROM p_currency
       OR v_existing.revenue_minor IS DISTINCT FROM p_revenue_minor
       OR v_existing.cost_minor IS DISTINCT FROM p_cost_minor
       OR v_existing.reconciliation_status IS DISTINCT FROM p_reconciliation_status
       OR v_existing.reconciled_revenue_minor IS DISTINCT FROM p_reconciled_revenue_minor
       OR v_existing.reconciled_cost_minor IS DISTINCT FROM p_reconciled_cost_minor
       OR v_existing.evidence_digest IS DISTINCT FROM p_evidence_digest
       OR v_existing.evidence_observed_at IS DISTINCT FROM p_evidence_observed_at
       OR v_existing.actor_type IS DISTINCT FROM p_actor_type
       OR v_existing.actor_id IS DISTINCT FROM p_actor_id THEN
      RAISE EXCEPTION USING ERRCODE = '23505',
        MESSAGE = 'finance_attribution_idempotency_conflict';
    END IF;
    RETURN jsonb_build_object('outcome', 'replay', 'attribution', to_jsonb(v_existing));
  END IF;

  SELECT record.* INTO v_existing
    FROM public.finance_attribution_records record
   WHERE record.provider = p_provider
     AND record.provider_account_ref = p_provider_account_ref
     AND record.source_event_type = p_source_event_type
     AND record.source_event_id = p_source_event_id
   FOR UPDATE;
  IF FOUND THEN
    IF v_existing.tenant_id IS DISTINCT FROM p_tenant_id
       OR v_existing.customer_id IS DISTINCT FROM p_customer_id
       OR v_existing.tenant_mapping_id IS DISTINCT FROM p_tenant_mapping_id
       OR v_existing.customer_mapping_id IS DISTINCT FROM p_customer_mapping_id
       OR v_existing.occurred_on IS DISTINCT FROM p_occurred_on
       OR v_existing.currency IS DISTINCT FROM p_currency
       OR v_existing.revenue_minor IS DISTINCT FROM p_revenue_minor
       OR v_existing.cost_minor IS DISTINCT FROM p_cost_minor
       OR v_existing.reconciliation_status IS DISTINCT FROM p_reconciliation_status
       OR v_existing.reconciled_revenue_minor IS DISTINCT FROM p_reconciled_revenue_minor
       OR v_existing.reconciled_cost_minor IS DISTINCT FROM p_reconciled_cost_minor
       OR v_existing.evidence_digest IS DISTINCT FROM p_evidence_digest
       OR v_existing.evidence_observed_at IS DISTINCT FROM p_evidence_observed_at
       OR v_existing.actor_type IS DISTINCT FROM p_actor_type
       OR v_existing.actor_id IS DISTINCT FROM p_actor_id THEN
      RAISE EXCEPTION USING ERRCODE = '23505',
        MESSAGE = 'finance_attribution_source_event_conflict';
    END IF;
    RETURN jsonb_build_object(
      'outcome', 'already_recorded',
      'attribution', to_jsonb(v_existing)
    );
  END IF;

  INSERT INTO public.finance_attribution_records (
    tenant_id, customer_id, tenant_mapping_id, customer_mapping_id,
    provider, provider_account_ref, source_event_type, source_event_id,
    occurred_on, currency, revenue_minor, cost_minor,
    reconciliation_status, reconciled_revenue_minor, reconciled_cost_minor,
    evidence_digest, evidence_observed_at, actor_type, actor_id,
    idempotency_key, request_fingerprint
  ) VALUES (
    p_tenant_id, p_customer_id, p_tenant_mapping_id, p_customer_mapping_id,
    p_provider, p_provider_account_ref, p_source_event_type, p_source_event_id,
    p_occurred_on, p_currency, p_revenue_minor, p_cost_minor,
    p_reconciliation_status, p_reconciled_revenue_minor,
    p_reconciled_cost_minor, p_evidence_digest, p_evidence_observed_at,
    p_actor_type, p_actor_id, p_idempotency_key, p_request_fingerprint
  ) RETURNING * INTO v_record;

  RETURN jsonb_build_object('outcome', 'recorded', 'attribution', to_jsonb(v_record));
END;
$$;

REVOKE EXECUTE ON FUNCTION public.billing_identity_register_rpc(
  uuid, text, uuid, text, text, text, text, text, text, text,
  timestamptz, text, text, text, text, boolean
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_identity_register_rpc(
  uuid, text, uuid, text, text, text, text, text, text, text,
  timestamptz, text, text, text, text, boolean
) TO service_role;

REVOKE EXECUTE ON FUNCTION public.finance_attribution_record_rpc(
  uuid, uuid, uuid, uuid, text, text, text, text, date, text, bigint,
  bigint, text, bigint, bigint, text, timestamptz, text, text, text,
  text, boolean
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finance_attribution_record_rpc(
  uuid, uuid, uuid, uuid, text, text, text, text, date, text, bigint,
  bigint, text, bigint, bigint, text, timestamptz, text, text, text,
  text, boolean
) TO service_role;
