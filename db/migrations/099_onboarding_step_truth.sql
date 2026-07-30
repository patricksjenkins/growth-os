-- 099: give onboarding steps somewhere to record what actually happened.
--
-- The engine could previously only say 'pending' / 'in_progress' / 'completed'.
-- It had nowhere to put a failure reason, so `_runAutomatedSteps` caught its
-- errors, logged them, and left the row at 'in_progress' — a state
-- `advanceOnboarding` did not count as blocking and day-7 completion ignored
-- entirely. A step could therefore fail and the workflow would still march to
-- "go_live: completed".
--
-- Three columns, so a step can tell the truth:
--   last_error  — why it failed, kept for the tracker and for retry
--   attempts    — how many times we have tried (a step failing repeatedly is
--                 a different problem from one that failed once)
--   kind        — 'automated' | 'founder' | 'customer'. The `automated`
--                 boolean could not distinguish "Patrick runs the Day-5 call"
--                 from "the customer uploads photos"; both were just
--                 automated=false, and neither had a handler, so both would
--                 have hit the default branch and warned.
--
-- No CHECK constraint on status: it is free TEXT today and adding 'failed',
-- 'skipped', and 'blocked' must not break the rows already written by any
-- in-flight workflow. (There are none in production — this engine has never
-- run — but that is not a reason to write a migration that would have.)

ALTER TABLE public.onboarding_steps
  ADD COLUMN IF NOT EXISTS last_error TEXT,
  ADD COLUMN IF NOT EXISTS attempts   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS kind       TEXT    NOT NULL DEFAULT 'automated';

-- Existing rows: `automated=false` meant a human step. Split is by step_name
-- because the boolean never carried who the human was.
UPDATE public.onboarding_steps
   SET kind = CASE
                WHEN step_name = 'founder_video_call'  THEN 'founder'
                WHEN step_name = 'client_photo_upload' THEN 'customer'
                WHEN automated IS FALSE                THEN 'founder'
                ELSE 'automated'
              END
 WHERE kind = 'automated';

CREATE INDEX IF NOT EXISTS idx_onboarding_steps_kind ON public.onboarding_steps(kind);

COMMENT ON COLUMN public.onboarding_steps.last_error IS
  'Why the step failed. Non-null means status=''failed'' and the workflow is blocked here.';
COMMENT ON COLUMN public.onboarding_steps.kind IS
  'automated | founder | customer — who is responsible for clearing this step.';
