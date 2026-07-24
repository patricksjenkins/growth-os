\set ON_ERROR_STOP on

-- Real two-session containment ordering proof. Run after
-- marketing-brand-head-negative.sql and before rollback 091.
CREATE EXTENSION IF NOT EXISTS dblink;

CREATE OR REPLACE FUNCTION public.marketing_brand_test_event_pause()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.idempotency_key = 'marketing-head:concurrency-command' THEN
    PERFORM pg_sleep(1.5);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_marketing_brand_test_event_pause
  ON public.marketing_brand_head_events;
CREATE TRIGGER trg_marketing_brand_test_event_pause
  BEFORE INSERT ON public.marketing_brand_head_events
  FOR EACH ROW EXECUTE FUNCTION public.marketing_brand_test_event_pause();

SELECT dblink_connect('marketing_command', 'dbname=' || current_database());
SELECT dblink_connect('marketing_kill', 'dbname=' || current_database());

DO $main$
DECLARE
  v_status text;
BEGIN
  PERFORM dblink_send_query(
    'marketing_command',
    $remote$
      DO $command$
      BEGIN
        PERFORM set_config('request.jwt.claim.role', 'service_role', true);
        PERFORM public.marketing_brand_head_command_rpc(
          '22222222-2222-4222-8222-222222222222',
          'create_case',
          '{
            "report_id":"91222222-2222-4222-8222-222222222222",
            "case_id":"91888888-2222-4222-8222-222222222222",
            "case_type":"exception",
            "title":"Concurrent containment proof",
            "owner_id":"bbbbbbbb-2222-4222-8222-222222222222",
            "sla_due_at":"2026-08-01T12:00:00Z",
            "contract":{"resolution":"synthetic-containment"}
          }'::jsonb,
          0, 'marketing-head:concurrency-command', repeat('1',64),
          'marketing-head-b', 'department_head',
          '{"source_type":"concurrency","source_id":"command-before-kill","observed_at":"2026-07-24T12:00:00Z"}'::jsonb,
          true
        );
      END
      $command$;
    $remote$
  );
  PERFORM pg_sleep(0.25);
  PERFORM dblink_send_query(
    'marketing_kill',
    $remote$
      DO $kill$
      BEGIN
        PERFORM set_config('request.jwt.claim.role', 'service_role', true);
        PERFORM public.marketing_brand_head_kill_switch_rpc(
          '22222222-2222-4222-8222-222222222222',
          'concurrent synthetic containment'
        );
      END
      $kill$;
    $remote$
  );
  PERFORM pg_sleep(0.25);
  IF dblink_is_busy('marketing_command') <> 1
     OR dblink_is_busy('marketing_kill') <> 1 THEN
    RAISE EXCEPTION 'expected kill to wait behind in-flight Marketing Head command';
  END IF;
  WHILE dblink_is_busy('marketing_command') = 1 LOOP
    PERFORM pg_sleep(0.05);
  END LOOP;
  SELECT status INTO v_status
    FROM dblink_get_result('marketing_command') AS result(status text);
  WHILE dblink_is_busy('marketing_kill') = 1 LOOP
    PERFORM pg_sleep(0.05);
  END LOOP;
  SELECT status INTO v_status
    FROM dblink_get_result('marketing_kill') AS result(status text);
END;
$main$;

SELECT dblink_disconnect('marketing_command');
SELECT dblink_disconnect('marketing_kill');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.marketing_brand_head_cases
     WHERE id = '91888888-2222-4222-8222-222222222222'
       AND tenant_id = '22222222-2222-4222-8222-222222222222'
  ) THEN
    RAISE EXCEPTION 'prechecked Marketing Head command did not finish before kill';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.marketing_brand_head_controls
     WHERE tenant_id = '22222222-2222-4222-8222-222222222222'
       AND enabled = false
       AND execution_mode = 'disabled'
       AND kill_switch_engaged = true
  ) THEN
    RAISE EXCEPTION 'concurrent Marketing Head kill did not commit containment';
  END IF;
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  BEGIN
    PERFORM public.marketing_brand_head_command_rpc(
      '22222222-2222-4222-8222-222222222222',
      'create_case',
      '{
        "report_id":"91222222-2222-4222-8222-222222222222",
        "case_id":"91888889-2222-4222-8222-222222222222",
        "case_type":"exception",
        "title":"Must fail after containment",
        "owner_id":"bbbbbbbb-2222-4222-8222-222222222222",
        "sla_due_at":"2026-08-01T12:00:00Z",
        "contract":{"resolution":"synthetic-containment"}
      }'::jsonb,
      0, 'marketing-head:after-concurrent-kill', repeat('2',64),
      'marketing-head-b', 'department_head',
      '{"source_type":"concurrency","source_id":"command-after-kill","observed_at":"2026-07-24T12:00:00Z"}'::jsonb,
      true
    );
    RAISE EXCEPTION 'expected command after concurrent Marketing Head kill denial';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <> 'marketing_brand_kill_switch_engaged' THEN RAISE; END IF;
  END;
END $$;

DROP TRIGGER trg_marketing_brand_test_event_pause
  ON public.marketing_brand_head_events;
DROP FUNCTION public.marketing_brand_test_event_pause();
