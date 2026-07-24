-- Operator-invoked, data-preserving rollback for migration 072.
-- Removes only the command functions. Work items, events, and audit evidence
-- created while the RPCs were enabled remain intact.

DROP FUNCTION IF EXISTS public.work_item_transition_rpc(
  uuid, uuid, integer, text, text, text, text, text, text,
  text, text, text, text, jsonb
);

DROP FUNCTION IF EXISTS public.work_item_create_rpc(
  uuid, text, text, text, text, text, text, text, text, text, text,
  text, text, text, text, text, text, text, uuid, jsonb, jsonb,
  timestamptz, timestamptz
);

