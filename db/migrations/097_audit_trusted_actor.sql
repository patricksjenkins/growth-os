-- 097: record a TRUSTED actor in the finance audit trail, and demote
-- metadata.source to what it actually is — an unverified claim by the writer.
--
-- WHY 096 WAS WRONG (Codex 2026-07-26, round 4)
-- Migration 096 copied metadata->>'source' into changed_by_label. That made the
-- column non-empty, which looked like progress, but the value is supplied by
-- the caller: POST /api/finance/income passes req.body.metadata straight
-- through. Anyone who can create an entry could label it 'stripe-webhook', and
-- a human editing or deleting a Stripe-derived row inherited that row's
-- 'stripe-webhook' label. An audit trail that can be told what to say about who
-- acted is worse than an empty one, because it invites reliance.
--
-- The distinction this migration enforces:
--   changed_by / changed_by_label  = WHO acted. Trusted. Derived only from the
--     verified JWT identity, the session GUC (settable only by a caller that
--     already holds a privileged connection), or the database role.
--   row_source                     = what the row CLAIMS about its origin.
--     Untrusted. Useful provenance, never evidence of an actor.
--
-- Rows whose actor genuinely cannot be determined stay NULL. That is the
-- honest answer.

ALTER TABLE public.finance_audit_log
  ADD COLUMN IF NOT EXISTS row_source TEXT,
  ADD COLUMN IF NOT EXISTS actor_trust TEXT;

COMMENT ON COLUMN public.finance_audit_log.changed_by_label IS
  'TRUSTED actor identity (JWT sub, privileged session GUC, or DB role). Never derived from caller-supplied data.';
COMMENT ON COLUMN public.finance_audit_log.row_source IS
  'UNTRUSTED provenance claim copied from the row''s metadata.source. Evidence of intent, not of identity.';
COMMENT ON COLUMN public.finance_audit_log.actor_trust IS
  'How the actor was established: jwt | session | db_role | unknown.';

CREATE OR REPLACE FUNCTION public.finance_entries_audit_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor_id UUID; v_actor_label TEXT; v_changed TEXT[];
  v_before JSONB; v_after JSONB; v_tenant UUID; v_entry UUID;
  v_row_source TEXT; v_trust TEXT; v_claims JSONB; v_jwt_role TEXT;
BEGIN
  -- 1. Verified JWT identity. This cannot be forged by a request body: it is
  --    set by PostgREST from the signed token.
  BEGIN
    v_claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  EXCEPTION WHEN OTHERS THEN v_claims := NULL; END;

  BEGIN
    v_actor_id := nullif(v_claims->>'sub', '')::UUID;
  EXCEPTION WHEN OTHERS THEN v_actor_id := NULL; END;
  v_jwt_role := v_claims->>'role';

  -- 2. Session GUC. Only reachable by a caller that already holds the
  --    connection (direct SQL, or an RPC inside the same transaction), so it
  --    is trusted — but it does NOT survive PostgREST connection pooling,
  --    which is why it is almost always NULL over REST. See migration 096.
  IF v_actor_id IS NOT NULL THEN
    v_actor_label := 'user:' || v_actor_id::text;
    v_trust := 'jwt';
  ELSE
    v_actor_label := nullif(current_setting('app.actor_label', true), '');
    IF v_actor_label IS NOT NULL THEN
      v_trust := 'session';
      BEGIN v_actor_id := nullif(current_setting('app.actor_id', true), '')::UUID;
      EXCEPTION WHEN OTHERS THEN v_actor_id := NULL; END;
    ELSIF v_jwt_role IS NOT NULL THEN
      -- A service-role token is a real, verified caller; it just is not a
      -- person. Naming the role is honest and useful.
      v_actor_label := 'role:' || v_jwt_role;
      v_trust := 'jwt';
    ELSE
      v_actor_label := 'db:' || current_user;
      v_trust := 'db_role';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_before := NULL; v_after := to_jsonb(NEW);
    v_tenant := NEW.tenant_id; v_entry := NEW.id; v_changed := NULL;
    v_row_source := NEW.metadata->>'source';
  ELSIF TG_OP = 'UPDATE' THEN
    v_before := to_jsonb(OLD); v_after := to_jsonb(NEW);
    v_tenant := NEW.tenant_id; v_entry := NEW.id;
    v_row_source := NEW.metadata->>'source';
    SELECT array_agg(key) INTO v_changed FROM (
      SELECT key FROM jsonb_each(v_before) WHERE v_before->key IS DISTINCT FROM v_after->key
    ) AS diff;
  ELSE
    v_before := to_jsonb(OLD); v_after := NULL;
    v_tenant := OLD.tenant_id; v_entry := OLD.id; v_changed := NULL;
    v_row_source := OLD.metadata->>'source';
  END IF;

  INSERT INTO public.finance_audit_log
    (tenant_id, entry_id, action, changed_by, changed_by_label, before_row, after_row, changed_fields, row_source, actor_trust)
  VALUES
    (v_tenant, v_entry, TG_OP, v_actor_id, v_actor_label, v_before, v_after, v_changed, v_row_source, v_trust);
  RETURN COALESCE(NEW, OLD);
END;
$function$;

-- Undo 096's backfill: those values were provenance, not actors. Move them to
-- the column that means provenance and restore NULL where identity is unknown.
UPDATE public.finance_audit_log
SET row_source = COALESCE(row_source, changed_by_label),
    changed_by_label = NULL,
    actor_trust = 'unknown'
WHERE changed_by IS NULL
  AND changed_by_label IS NOT NULL
  AND changed_by_label NOT LIKE 'user:%'
  AND changed_by_label NOT LIKE 'role:%'
  AND changed_by_label NOT LIKE 'db:%';

-- Backfill provenance for the remaining historic rows from their captured payloads.
UPDATE public.finance_audit_log
SET row_source = COALESCE(after_row->'metadata'->>'source', before_row->'metadata'->>'source')
WHERE row_source IS NULL
  AND COALESCE(after_row->'metadata'->>'source', before_row->'metadata'->>'source') IS NOT NULL;

UPDATE public.finance_audit_log SET actor_trust = 'unknown' WHERE actor_trust IS NULL;
