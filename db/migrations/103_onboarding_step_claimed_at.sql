-- When a step was claimed, so a crashed claim can be taken back.
--
-- WHY (2026-08-03)
-- runStep() claims a step by flipping it to 'in_progress' before it sends
-- anything, so two concurrent clicks cannot both send. The claim was
-- conditioned on the status the CALLER had read, which meant a caller who read
-- the row as 'in_progress' claimed in_progress -> in_progress and sent again.
-- Two overlapping requests produced two emails, both reporting success.
--
-- Claiming only from a not-yet-claimed status fixes the duplicate, but creates
-- the opposite failure: a step whose process died mid-send stays 'in_progress'
-- forever and can never be clicked again. So the claim is stamped, and a claim
-- older than the stale window may be taken over — by exactly one caller, since
-- the takeover is itself a conditional update on this column.

ALTER TABLE onboarding_steps
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

-- Any row already sitting in_progress predates the column. Without a value it
-- would fail the "older than the window" test forever (NULL is not < anything)
-- and be permanently unclickable. Date it from creation so the stale path can
-- reach it.
UPDATE onboarding_steps
   SET claimed_at = created_at
 WHERE status = 'in_progress'
   AND claimed_at IS NULL;

COMMENT ON COLUMN onboarding_steps.claimed_at IS
  'When this step was claimed for execution. A claim older than the stale window may be taken over; see core/onboarding-center.js runStep().';
