-- One active onboarding workflow per tenant, enforced by the database.
--
-- WHY (2026-08-03)
-- startOnboarding guards against duplicates by reading getOnboardingStatus
-- first and bailing if a workflow already exists. That is check-then-act: two
-- Stripe webhook deliveries arriving together both read "none", both insert,
-- and the tenant ends up with two active workflows and two full checklists.
-- Patrick would then be looking at two copies of the same customer, each with
-- its own send buttons.
--
-- A guard in application code cannot fix that, because the window is between
-- its own read and its own write. Postgres can: the second insert simply
-- fails, and the caller's existing error path handles it.
--
-- Partial, so completed and cancelled workflows accumulate as history — a
-- tenant who churns and comes back must be able to onboard again.

CREATE UNIQUE INDEX IF NOT EXISTS uq_onboarding_workflows_one_active_per_tenant
  ON onboarding_workflows (tenant_id)
  WHERE status = 'active';

COMMENT ON INDEX uq_onboarding_workflows_one_active_per_tenant IS
  'A tenant may have only one active onboarding workflow. Prevents duplicate checklists from concurrent Stripe webhook deliveries.';
