-- Reversible FGA-only shutdown for the supervised Department Head cohort.
-- Evidence and historical rows are retained.

BEGIN;

WITH fga AS (
  SELECT id FROM public.tenants WHERE slug = 'fga'
)
UPDATE public.reliability_head_controls control
   SET enabled = false, execution_mode = 'disabled',
       kill_switch_engaged = true, updated_at = now()
  FROM fga
 WHERE control.tenant_id = fga.id;

WITH fga AS (
  SELECT id FROM public.tenants WHERE slug = 'fga'
)
UPDATE public.revenue_head_controls control
   SET enabled = false, execution_mode = 'disabled',
       kill_switch_engaged = true, updated_at = now()
  FROM fga
 WHERE control.tenant_id = fga.id;

WITH fga AS (
  SELECT id FROM public.tenants WHERE slug = 'fga'
)
UPDATE public.onboarding_head_controls control
   SET enabled = false, execution_mode = 'disabled',
       kill_switch_engaged = true, updated_at = now()
  FROM fga
 WHERE control.tenant_id = fga.id;

WITH fga AS (
  SELECT id FROM public.tenants WHERE slug = 'fga'
)
UPDATE public.client_success_head_controls control
   SET enabled = false, execution_mode = 'disabled',
       kill_switch_engaged = true, updated_at = now()
  FROM fga
 WHERE control.tenant_id = fga.id;

WITH fga AS (
  SELECT id FROM public.tenants WHERE slug = 'fga'
)
UPDATE public.finance_governance_head_controls control
   SET enabled = false, execution_mode = 'disabled',
       kill_switch_engaged = true, updated_at = now()
  FROM fga
 WHERE control.tenant_id = fga.id;

WITH fga AS (
  SELECT id FROM public.tenants WHERE slug = 'fga'
)
UPDATE public.marketing_brand_head_controls control
   SET enabled = false, execution_mode = 'disabled',
       kill_switch_engaged = true, updated_at = now()
  FROM fga
 WHERE control.tenant_id = fga.id;

WITH fga AS (
  SELECT id FROM public.tenants WHERE slug = 'fga'
)
UPDATE public.product_engineering_head_controls control
   SET enabled = false, execution_mode = 'disabled',
       kill_switch_engaged = true, updated_at = now()
  FROM fga
 WHERE control.tenant_id = fga.id;

WITH fga AS (
  SELECT id FROM public.tenants WHERE slug = 'fga'
)
UPDATE public.cos_supervision_controls control
   SET enabled = false, execution_mode = 'disabled', read_only = true,
       kill_switch_engaged = true, updated_at = now()
  FROM fga
 WHERE control.tenant_id = fga.id;

COMMIT;
