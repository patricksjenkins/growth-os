-- 096: make the finance audit trail actually record WHO changed a row.
--
-- Every one of the ~800 rows in finance_audit_log has changed_by_label = NULL.
-- Not some. All of them, since the table was created.
--
-- WHY (this is not a typo bug):
-- setAuditContext() calls the set_audit_context RPC, which does
--   set_config('app.actor_label', ..., false)   -- session scope
-- and the trigger reads current_setting('app.actor_label', true).
-- The GUC names match perfectly, which is why it looked correct in review.
--
-- But over PostgREST those are two SEPARATE HTTP requests, and Supabase pools
-- connections: the RPC sets the variable on whichever backend served it, then
-- the INSERT is very likely served by a DIFFERENT backend, where the variable
-- was never set. The context is lost between the two calls by construction.
-- No amount of correctness in the application code can fix that — the pattern
-- only works when both statements share one session (direct psql, or an
-- explicit transaction), which the webhook path never does.
--
-- FIX: let the actor travel WITH THE ROW. Every writer already stamps
-- metadata.source ('stripe-webhook', 'mercury-feed', 'expense_tracker', ...),
-- and that value arrives in the same statement as the row, so pooling cannot
-- separate them. The GUC stays as the preferred source for the paths that do
-- share a session; metadata.source is the fallback.
--
-- Rows whose provenance genuinely is not recorded stay NULL. That is the
-- honest answer: an audit log that invents an actor is worse than one that
-- admits it does not know.

CREATE OR REPLACE FUNCTION public.finance_entries_audit_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor_id UUID; v_actor_label TEXT; v_changed TEXT[];
  v_before JSONB; v_after JSONB; v_tenant UUID; v_entry UUID;
  v_row_source TEXT;
BEGIN
  BEGIN v_actor_id := nullif(current_setting('app.actor_id', true), '')::UUID;
  EXCEPTION WHEN OTHERS THEN v_actor_id := NULL; END;
  v_actor_label := nullif(current_setting('app.actor_label', true), '');

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

  -- Session GUC first (direct-SQL callers), then the row's own declared
  -- source (everything that arrives over REST). NULL only when neither exists.
  v_actor_label := COALESCE(v_actor_label, v_row_source);

  INSERT INTO public.finance_audit_log (tenant_id, entry_id, action, changed_by, changed_by_label, before_row, after_row, changed_fields)
  VALUES (v_tenant, v_entry, TG_OP, v_actor_id, v_actor_label, v_before, v_after, v_changed);
  RETURN COALESCE(NEW, OLD);
END;
$function$;

-- Backfill what is recoverable: historic audit rows whose captured row payload
-- carries a source. Rows with no source stay NULL rather than being guessed.
UPDATE public.finance_audit_log
SET changed_by_label = COALESCE(after_row->'metadata'->>'source', before_row->'metadata'->>'source')
WHERE changed_by_label IS NULL
  AND COALESCE(after_row->'metadata'->>'source', before_row->'metadata'->>'source') IS NOT NULL;
