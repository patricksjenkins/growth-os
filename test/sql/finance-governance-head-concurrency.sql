\set ON_ERROR_STOP on

-- Real two-session containment ordering proof. Run after
-- finance-governance-head-negative.sql and before rollback 090.
CREATE EXTENSION IF NOT EXISTS dblink;

CREATE OR REPLACE FUNCTION public.finance_governance_test_event_pause()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.idempotency_key = 'finance-head:concurrency-command' THEN
    PERFORM pg_sleep(1.5);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_finance_governance_test_event_pause
  ON public.finance_governance_head_events;
CREATE TRIGGER trg_finance_governance_test_event_pause
  BEFORE INSERT ON public.finance_governance_head_events
  FOR EACH ROW EXECUTE FUNCTION public.finance_governance_test_event_pause();

SELECT dblink_connect('finance_command', 'dbname=' || current_database());
SELECT dblink_connect('finance_kill', 'dbname=' || current_database());

DO $main$
DECLARE
  v_status text;
BEGIN
  PERFORM dblink_send_query(
    'finance_command',
    $remote$
      DO $command$
      BEGIN
        PERFORM set_config('request.jwt.claim.role', 'service_role', true);
        PERFORM public.finance_governance_head_command_rpc(
          '22222222-2222-4222-8222-222222222222',
          'create_case', '90222222-2222-4222-8222-222222222222',
          '90888888-2222-4222-8222-222222222222',
          NULL, NULL, NULL, '{}'::uuid[], NULL, NULL, NULL, '{}'::jsonb,
          'exception', 'Concurrent containment proof',
          'ffffffff-2222-4222-8222-222222222222', NULL,
          now() + interval '1 day', '{"resolution":"synthetic_containment"}'::jsonb,
          NULL, NULL, 0, 'finance-head:concurrency-command', repeat('1',64),
          'finance-head-b', 'department_head',
          '{"source_type":"concurrency","source_id":"command-before-kill","observed_at":"2026-07-24T12:00:00Z"}'::jsonb,
          true
        );
      END
      $command$;
    $remote$
  );
  PERFORM pg_sleep(0.25);
  PERFORM dblink_send_query(
    'finance_kill',
    $remote$
      DO $kill$
      BEGIN
        PERFORM set_config('request.jwt.claim.role', 'service_role', true);
        PERFORM public.finance_governance_head_kill_switch_rpc(
          '22222222-2222-4222-8222-222222222222',
          'concurrent synthetic containment'
        );
      END
      $kill$;
    $remote$
  );
  PERFORM pg_sleep(0.25);
  IF dblink_is_busy('finance_command') <> 1
     OR dblink_is_busy('finance_kill') <> 1 THEN
    RAISE EXCEPTION 'expected kill to wait behind in-flight Finance Head command';
  END IF;
  WHILE dblink_is_busy('finance_command') = 1 LOOP
    PERFORM pg_sleep(0.05);
  END LOOP;
  SELECT status INTO v_status
    FROM dblink_get_result('finance_command') AS result(status text);
  WHILE dblink_is_busy('finance_kill') = 1 LOOP
    PERFORM pg_sleep(0.05);
  END LOOP;
  SELECT status INTO v_status
    FROM dblink_get_result('finance_kill') AS result(status text);
END;
$main$;

SELECT dblink_disconnect('finance_command');
SELECT dblink_disconnect('finance_kill');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.finance_governance_head_cases
     WHERE id = '90888888-2222-4222-8222-222222222222'
       AND tenant_id = '22222222-2222-4222-8222-222222222222'
  ) THEN
    RAISE EXCEPTION 'prechecked Finance Head command did not finish before kill';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.finance_governance_head_controls
     WHERE tenant_id = '22222222-2222-4222-8222-222222222222'
       AND enabled = false
       AND execution_mode = 'disabled'
       AND kill_switch_engaged = true
  ) THEN
    RAISE EXCEPTION 'concurrent Finance Head kill did not commit containment';
  END IF;
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  BEGIN
    PERFORM public.finance_governance_head_command_rpc(
      '22222222-2222-4222-8222-222222222222',
      'create_case', '90222222-2222-4222-8222-222222222222',
      '90888889-2222-4222-8222-222222222222',
      NULL, NULL, NULL, '{}'::uuid[], NULL, NULL, NULL, '{}'::jsonb,
      'exception', 'Must fail after containment',
      'ffffffff-2222-4222-8222-222222222222', NULL,
      now() + interval '1 day', '{"resolution":"synthetic_containment"}'::jsonb,
      NULL, NULL, 0, 'finance-head:after-concurrent-kill', repeat('2',64),
      'finance-head-b', 'department_head',
      '{"source_type":"concurrency","source_id":"command-after-kill","observed_at":"2026-07-24T12:00:00Z"}'::jsonb,
      true
    );
    RAISE EXCEPTION 'expected command after concurrent Finance Head kill denial';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <> 'finance_governance_kill_switch_engaged' THEN RAISE; END IF;
  END;
END $$;

DROP TRIGGER trg_finance_governance_test_event_pause
  ON public.finance_governance_head_events;
DROP FUNCTION public.finance_governance_test_event_pause();
