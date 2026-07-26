-- 095_stripe_event_inbox.sql
-- Durable inbox for Stripe webhook events.
--
-- WHY (Codex audit 2026-07-26, verified): the webhook route returned HTTP 200
-- for ANY handler result, including {status:'error'}, orphaned, and
-- period_locked. Stripe treats 200 as delivered and stops retrying, so a soft
-- failure destroyed the event permanently — there was no record it ever
-- arrived. Combined with the service being bound to a sandbox account, real
-- money vanished with no trace on our side at all.
--
-- The inbox makes arrival durable and separate from processing:
--   received  -> the event is safely stored; we can always replay it
--   processed -> a handler completed and produced its intended effect
--   ignored   -> an event type we deliberately do not act on
--   rejected  -> a handler failed; payload retained for replay/diagnosis
--   orphaned  -> valid event, no matching tenant (needs owner linkage)
--
-- Idempotency lives here too: Stripe may deliver the same event id more than
-- once, and does not guarantee ordering.

CREATE TABLE IF NOT EXISTS public.stripe_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_event_id   text NOT NULL,              -- evt_...
  stripe_account_id text,                       -- acct_... the event came from
  event_type        text NOT NULL,              -- invoice.paid, etc.
  livemode          boolean,                    -- false = sandbox/test traffic
  status            text NOT NULL DEFAULT 'received'
                      CHECK (status IN ('received','processed','ignored','rejected','orphaned')),
  attempts          int NOT NULL DEFAULT 0,
  result            jsonb,                      -- handler return value
  error             text,
  payload           jsonb NOT NULL,             -- full event, for replay
  received_at       timestamptz NOT NULL DEFAULT now(),
  processed_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- One row per Stripe event id. A redelivery updates rather than duplicates,
-- which is what makes replay safe.
CREATE UNIQUE INDEX IF NOT EXISTS stripe_events_event_id_uniq
  ON public.stripe_events (stripe_event_id);

CREATE INDEX IF NOT EXISTS stripe_events_status_idx   ON public.stripe_events (status, received_at DESC);
CREATE INDEX IF NOT EXISTS stripe_events_type_idx     ON public.stripe_events (event_type, received_at DESC);
CREATE INDEX IF NOT EXISTS stripe_events_livemode_idx ON public.stripe_events (livemode, received_at DESC);

-- Platform/admin-only data: service-role key only, same posture as
-- ops_incidents (migration 057).
ALTER TABLE public.stripe_events ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.stripe_events IS
  'Durable Stripe webhook inbox. Arrival is recorded BEFORE processing so a handler failure can never destroy the event. See migration 095.';
