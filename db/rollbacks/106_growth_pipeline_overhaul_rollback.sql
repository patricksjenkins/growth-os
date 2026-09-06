-- Review-only rollback. Applying this deletes new Growth Engine evidence and
-- therefore requires explicit production approval.
DROP TRIGGER IF EXISTS growth_events_append_only ON public.growth_events;
DROP TRIGGER IF EXISTS growth_events_project_stage ON public.growth_events;
DROP FUNCTION IF EXISTS public.growth_events_block_mutation();
DROP FUNCTION IF EXISTS public.project_growth_stage_event();
DROP FUNCTION IF EXISTS public.growth_stage_rank(text);
DROP TABLE IF EXISTS public.growth_restart_candidates;
DROP TABLE IF EXISTS public.growth_restart_batches;
DROP TABLE IF EXISTS public.growth_stage_state;
DROP TABLE IF EXISTS public.growth_events;
DROP FUNCTION IF EXISTS public.assert_growth_restart_tenant_refs();
DROP FUNCTION IF EXISTS public.assert_growth_stage_event_tenant();
DROP FUNCTION IF EXISTS public.assert_growth_lead_tenant();
ALTER TABLE public.drip_campaigns
  DROP COLUMN IF EXISTS includes_initial_touch,
  DROP COLUMN IF EXISTS total_touches,
  DROP COLUMN IF EXISTS plan_key;
DROP INDEX IF EXISTS public.uq_email_events_provider_event;
ALTER TABLE public.email_events DROP COLUMN IF EXISTS provider_event_id;
ALTER TABLE public.drip_inbound
  DROP COLUMN IF EXISTS routed_at,
  DROP COLUMN IF EXISTS intent,
  DROP COLUMN IF EXISTS body_text;
ALTER TABLE public.email_connections DROP COLUMN IF EXISTS reply_cursor_at;
DROP INDEX IF EXISTS public.idx_leads_fga_growth_evidence_queue;
ALTER TABLE public.leads
  DROP COLUMN IF EXISTS growth_evidence_attempts,
  DROP COLUMN IF EXISTS growth_evidence_checked_at,
  DROP COLUMN IF EXISTS growth_evidence_status;
