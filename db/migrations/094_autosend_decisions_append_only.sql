-- 094_autosend_decisions_append_only.sql
-- Make the gate-decision ledger genuinely append-only.
--
-- autosend_decisions is the evidence the daily revenue invariant counts
-- against: an auto_send only counts if a same-day accepted decision row
-- exists for the EXACT sequence that went out. Codex review 2026-07-26:
-- the code called this ledger "append-only" but nothing enforced it — any
-- service-role writer could UPDATE a 'blocked' decision to 'sent' after the
-- fact, or DELETE the trail. Evidence you can rewrite is not evidence.
--
-- Trigger, not RLS: RLS policies don't bind the service-role key, and the
-- service-role key is exactly the credential every worker uses. A BEFORE
-- trigger raises for every session, service role included.
--
-- Rollback (if ever needed, with owner approval):
--   drop trigger if exists autosend_decisions_append_only on autosend_decisions;
--   drop function if exists autosend_decisions_block_mutation();

create or replace function autosend_decisions_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'autosend_decisions is append-only: % is not allowed (gate decisions are evidence and may not be rewritten)', TG_OP
    using errcode = '42501';
end;
$$;

drop trigger if exists autosend_decisions_append_only on autosend_decisions;
create trigger autosend_decisions_append_only
  before update or delete on autosend_decisions
  for each row execute function autosend_decisions_block_mutation();

comment on trigger autosend_decisions_append_only on autosend_decisions is
  'Evidence ledger for the daily revenue invariant. INSERT-only by design; see migration 094.';
