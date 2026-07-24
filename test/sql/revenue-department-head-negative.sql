\set ON_ERROR_STOP on

-- Migration 086 runtime proof. Synthetic identifiers and aggregate metrics
-- only. Run after the autonomous bootstrap and migration 086.
INSERT INTO public.tenants (id, status) VALUES
  ('11111111-1111-4111-8111-111111111111', 'active'),
  ('22222222-2222-4222-8222-222222222222', 'active')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.tenant_users (tenant_id, user_id, role) VALUES
  (
    '11111111-1111-4111-8111-111111111111',
    'aaaaaaaa-1111-4111-8111-111111111111',
    'owner'
  ),
  (
    '22222222-2222-4222-8222-222222222222',
    'bbbbbbbb-2222-4222-8222-222222222222',
    'owner'
  )
ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role;
INSERT INTO public.revenue_head_controls (
  tenant_id, enabled, execution_mode, kill_switch_engaged,
  registered_agent_id, activated_by, activation_evidence
) VALUES
  (
    '11111111-1111-4111-8111-111111111111',
    true, 'supervised_read_only', false, 'revenue-head-a',
    'aaaaaaaa-1111-4111-8111-111111111111',
    '{"source":"synthetic_owner_activation"}'::jsonb
  ),
  (
    '22222222-2222-4222-8222-222222222222',
    true, 'supervised_read_only', false, 'revenue-head-b',
    'bbbbbbbb-2222-4222-8222-222222222222',
    '{"source":"synthetic_owner_activation"}'::jsonb
  )
ON CONFLICT (tenant_id) DO NOTHING;

BEGIN;
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM public.revenue_head_charter_register_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_version => 1,
      p_mission => 'Own evidence-backed revenue health, surface material exceptions, and coordinate accountable follow-through.',
      p_qualification_rate_target_bps => 5000,
      p_appointment_rate_target_bps => 6000,
      p_held_rate_target_bps => 8000,
      p_proposal_rate_target_bps => 7000,
      p_win_rate_target_bps => 3000,
      p_max_sales_cycle_days => 45,
      p_actor_id => 'aaaaaaaa-1111-4111-8111-111111111111',
      p_evidence => jsonb_build_object(
        'schema_version', 1,
        'sources', jsonb_build_array(jsonb_build_object(
          'source_type', 'owner_charter',
          'source_id', 'charter_a_v1',
          'evidence_digest', repeat('a', 64),
          'observed_at', '2026-07-24T12:00:00Z'
        ))
      ),
      p_idempotency_key => 'revenue-head:authenticated-denied',
      p_request_fingerprint => repeat('1', 64),
      p_feature_gate_enabled => true
    );
    RAISE EXCEPTION 'expected authenticated revenue head RPC denial';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
DO $$
BEGIN
  BEGIN
    INSERT INTO public.revenue_head_reports (
      id, tenant_id, charter_id, period_start, period_end, source_system,
      source_report_id, leads_created, qualified_leads, appointments_booked,
      appointments_held, proposals_sent, closed_won, closed_lost,
      open_pipeline_minor, booked_revenue_minor, currency,
      average_sales_cycle_days, funnel_health, business_effect_state,
      evidence, evidence_count, evidence_digest, idempotency_key,
      request_fingerprint
    ) VALUES (
      gen_random_uuid(), '11111111-1111-4111-8111-111111111111',
      gen_random_uuid(), '2026-07-01', '2026-07-31', 'sales_ledger',
      'direct_denied', 0, 0, 0, 0, 0, 0, 0, 0, 0, 'USD', 0,
      'unverified', 'unverified', '{}'::jsonb, 1, repeat('a', 64),
      'revenue-head:direct-denied', repeat('1', 64)
    );
    RAISE EXCEPTION 'expected direct service-role revenue head write denial';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.revenue_head_charter_register_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_version => 1,
      p_mission => 'Own evidence-backed revenue health, surface material exceptions, and coordinate accountable follow-through.',
      p_qualification_rate_target_bps => 5000,
      p_appointment_rate_target_bps => 6000,
      p_held_rate_target_bps => 8000,
      p_proposal_rate_target_bps => 7000,
      p_win_rate_target_bps => 3000,
      p_max_sales_cycle_days => 45,
      p_actor_id => 'aaaaaaaa-1111-4111-8111-111111111111',
      p_evidence => jsonb_build_object(
        'schema_version', 1,
        'sources', jsonb_build_array(jsonb_build_object(
          'source_type', 'owner_charter', 'source_id', 'disabled',
          'evidence_digest', repeat('a', 64),
          'observed_at', '2026-07-24T12:00:00Z'
        ))
      ),
      p_idempotency_key => 'revenue-head:disabled',
      p_request_fingerprint => repeat('1', 64),
      p_feature_gate_enabled => false
    );
    RAISE EXCEPTION 'expected disabled revenue head write denial';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.revenue_head_charter_register_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_version => 1,
      p_mission => 'Own evidence-backed revenue health, surface material exceptions, and coordinate accountable follow-through.',
      p_qualification_rate_target_bps => 5000,
      p_appointment_rate_target_bps => 6000,
      p_held_rate_target_bps => 8000,
      p_proposal_rate_target_bps => 7000,
      p_win_rate_target_bps => 3000,
      p_max_sales_cycle_days => 45,
      p_actor_id => 'bbbbbbbb-2222-4222-8222-222222222222',
      p_evidence => jsonb_build_object(
        'schema_version', 1,
        'sources', jsonb_build_array(jsonb_build_object(
          'source_type', 'owner_charter', 'source_id', 'cross_tenant',
          'evidence_digest', repeat('a', 64),
          'observed_at', '2026-07-24T12:00:00Z'
        ))
      ),
      p_idempotency_key => 'revenue-head:cross-owner',
      p_request_fingerprint => repeat('2', 64),
      p_feature_gate_enabled => true
    );
    RAISE EXCEPTION 'expected cross-tenant charter actor denial';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.revenue_head_charter_register_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_version => 1,
      p_mission => 'Own evidence-backed revenue health, surface material exceptions, and coordinate accountable follow-through.',
      p_qualification_rate_target_bps => 5000,
      p_appointment_rate_target_bps => 6000,
      p_held_rate_target_bps => 8000,
      p_proposal_rate_target_bps => 7000,
      p_win_rate_target_bps => 3000,
      p_max_sales_cycle_days => 45,
      p_actor_id => 'aaaaaaaa-1111-4111-8111-111111111111',
      p_evidence => jsonb_build_object(
        'schema_version', 1,
        'sources', jsonb_build_array(
          jsonb_build_object(
            'source_type', 'sales_ledger', 'source_id', 'duplicate',
            'evidence_digest', repeat('a', 64),
            'observed_at', '2026-07-24T12:00:00Z'
          ),
          jsonb_build_object(
            'source_type', 'sales_ledger', 'source_id', 'duplicate',
            'evidence_digest', repeat('a', 64),
            'observed_at', '2026-07-24T12:00:00Z'
          )
        )
      ),
      p_idempotency_key => 'revenue-head:duplicate-evidence',
      p_request_fingerprint => repeat('3', 64),
      p_feature_gate_enabled => true
    );
    RAISE EXCEPTION 'expected duplicate revenue evidence source denial';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
DO $$
DECLARE
  charter_a_result jsonb;
  charter_b_result jsonb;
  report_a_result jsonb;
  report_a_replay jsonb;
  report_unverified jsonb;
  create_result jsonb;
  accept_result jsonb;
  accept_replay jsonb;
  start_result jsonb;
  complete_result jsonb;
  decision_create jsonb;
  decision_accept jsonb;
  decision_result jsonb;
  kill_result jsonb;
  charter_a uuid;
  charter_b uuid;
  report_a uuid := '33333333-1111-4111-8111-111111111111';
  report_b uuid := '33333333-2222-4222-8222-222222222222';
  item_a uuid := '44444444-1111-4111-8111-111111111111';
  decision_a uuid := '55555555-1111-4111-8111-111111111111';
  escalation_a uuid := '66666666-1111-4111-8111-111111111111';
  evidence_two jsonb := jsonb_build_object(
    'schema_version', 1,
    'sources', jsonb_build_array(
      jsonb_build_object(
        'source_type', 'sales_ledger', 'source_id', 'sales_snapshot_a',
        'evidence_digest', repeat('a', 64),
        'observed_at', '2026-07-24T12:00:00Z'
      ),
      jsonb_build_object(
        'source_type', 'booking_ledger', 'source_id', 'booking_snapshot_a',
        'evidence_digest', repeat('b', 64),
        'observed_at', '2026-07-24T12:01:00Z'
      )
    )
  );
  evidence_one jsonb := jsonb_build_object(
    'schema_version', 1,
    'sources', jsonb_build_array(jsonb_build_object(
      'source_type', 'sales_ledger', 'source_id', 'single_snapshot',
      'evidence_digest', repeat('c', 64),
      'observed_at', '2026-07-24T12:02:00Z'
    ))
  );
BEGIN
  charter_a_result := public.revenue_head_charter_register_rpc(
    p_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_version => 1,
    p_mission => 'Own evidence-backed revenue health, surface material exceptions, and coordinate accountable follow-through.',
    p_qualification_rate_target_bps => 5000,
    p_appointment_rate_target_bps => 6000,
    p_held_rate_target_bps => 8000,
    p_proposal_rate_target_bps => 7000,
    p_win_rate_target_bps => 3000,
    p_max_sales_cycle_days => 45,
    p_actor_id => 'aaaaaaaa-1111-4111-8111-111111111111',
    p_evidence => evidence_one,
    p_idempotency_key => 'revenue-head:charter:a:1',
    p_request_fingerprint => repeat('1', 64),
    p_feature_gate_enabled => true
  );
  charter_a := (charter_a_result->'charter'->>'id')::uuid;
  charter_b_result := public.revenue_head_charter_register_rpc(
    p_tenant_id => '22222222-2222-4222-8222-222222222222',
    p_version => 1,
    p_mission => 'Own evidence-backed revenue health, surface material exceptions, and coordinate accountable follow-through.',
    p_qualification_rate_target_bps => 5000,
    p_appointment_rate_target_bps => 6000,
    p_held_rate_target_bps => 8000,
    p_proposal_rate_target_bps => 7000,
    p_win_rate_target_bps => 3000,
    p_max_sales_cycle_days => 45,
    p_actor_id => 'bbbbbbbb-2222-4222-8222-222222222222',
    p_evidence => evidence_one,
    p_idempotency_key => 'revenue-head:charter:b:1',
    p_request_fingerprint => repeat('2', 64),
    p_feature_gate_enabled => true
  );
  charter_b := (charter_b_result->'charter'->>'id')::uuid;

  BEGIN
    PERFORM public.revenue_head_report_accept_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_report_id => report_a, p_charter_id => charter_a,
      p_period_start => '2026-07-01', p_period_end => '2026-07-31',
      p_source_system => 'sales_ledger',
      p_source_report_id => 'malformed_report',
      p_leads_created => 10, p_qualified_leads => 11,
      p_appointments_booked => 0, p_appointments_held => 0,
      p_proposals_sent => 0, p_closed_won => 0, p_closed_lost => 0,
      p_open_pipeline_minor => 0, p_booked_revenue_minor => 0,
      p_currency => 'USD', p_average_sales_cycle_days => 0,
      p_evidence => evidence_two,
      p_idempotency_key => 'revenue-head:report:malformed',
      p_request_fingerprint => repeat('3', 64),
      p_feature_gate_enabled => true
    );
    RAISE EXCEPTION 'expected malformed sales report denial';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  report_a_result := public.revenue_head_report_accept_rpc(
    p_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_report_id => report_a, p_charter_id => charter_a,
    p_period_start => '2026-07-01', p_period_end => '2026-07-31',
    p_source_system => 'sales_ledger',
    p_source_report_id => 'sales_snapshot_shared',
    p_leads_created => 100, p_qualified_leads => 60,
    p_appointments_booked => 40, p_appointments_held => 35,
    p_proposals_sent => 25, p_closed_won => 8, p_closed_lost => 12,
    p_open_pipeline_minor => 500000, p_booked_revenue_minor => 200000,
    p_currency => 'USD', p_average_sales_cycle_days => 32,
    p_evidence => evidence_two,
    p_idempotency_key => 'revenue-head:report:a:healthy',
    p_request_fingerprint => repeat('4', 64),
    p_feature_gate_enabled => true
  );
  IF report_a_result->'report'->>'funnel_health' <> 'healthy'
     OR report_a_result->'report'->>'business_effect_state' <> 'observed'
     OR report_a_result->'report'->>'outcome_healthy' <> 'true' THEN
    RAISE EXCEPTION 'evidence-backed healthy funnel was not accepted honestly';
  END IF;
  report_a_replay := public.revenue_head_report_accept_rpc(
    p_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_report_id => report_a, p_charter_id => charter_a,
    p_period_start => '2026-07-01', p_period_end => '2026-07-31',
    p_source_system => 'sales_ledger',
    p_source_report_id => 'sales_snapshot_shared',
    p_leads_created => 100, p_qualified_leads => 60,
    p_appointments_booked => 40, p_appointments_held => 35,
    p_proposals_sent => 25, p_closed_won => 8, p_closed_lost => 12,
    p_open_pipeline_minor => 500000, p_booked_revenue_minor => 200000,
    p_currency => 'USD', p_average_sales_cycle_days => 32,
    p_evidence => evidence_two,
    p_idempotency_key => 'revenue-head:report:a:healthy',
    p_request_fingerprint => repeat('4', 64),
    p_feature_gate_enabled => true
  );
  IF report_a_replay->>'outcome' <> 'replay' THEN
    RAISE EXCEPTION 'expected exact revenue report replay';
  END IF;

  report_unverified := public.revenue_head_report_accept_rpc(
    p_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_report_id => '33333333-1111-4111-8111-222222222222',
    p_charter_id => charter_a,
    p_period_start => '2026-08-01', p_period_end => '2026-08-31',
    p_source_system => 'sales_ledger',
    p_source_report_id => 'single_evidence_report',
    p_leads_created => 100, p_qualified_leads => 60,
    p_appointments_booked => 40, p_appointments_held => 35,
    p_proposals_sent => 25, p_closed_won => 8, p_closed_lost => 12,
    p_open_pipeline_minor => 500000, p_booked_revenue_minor => 200000,
    p_currency => 'USD', p_average_sales_cycle_days => 32,
    p_evidence => evidence_one,
    p_idempotency_key => 'revenue-head:report:a:unverified',
    p_request_fingerprint => repeat('5', 64),
    p_feature_gate_enabled => true
  );
  IF report_unverified->'report'->>'funnel_health' <> 'unverified'
     OR report_unverified->'report'->>'outcome_healthy' <> 'false' THEN
    RAISE EXCEPTION 'no-evidence report appeared healthy';
  END IF;

  BEGIN
    PERFORM public.revenue_head_report_accept_rpc(
      p_tenant_id => '22222222-2222-4222-8222-222222222222',
      p_report_id => report_b, p_charter_id => charter_b,
      p_period_start => '2026-07-01', p_period_end => '2026-07-31',
      p_source_system => 'sales_ledger',
      p_source_report_id => 'sales_snapshot_shared',
      p_leads_created => 100, p_qualified_leads => 60,
      p_appointments_booked => 40, p_appointments_held => 35,
      p_proposals_sent => 25, p_closed_won => 8, p_closed_lost => 12,
      p_open_pipeline_minor => 500000, p_booked_revenue_minor => 200000,
      p_currency => 'USD', p_average_sales_cycle_days => 32,
      p_evidence => evidence_two,
      p_idempotency_key => 'revenue-head:report:b:rebind',
      p_request_fingerprint => repeat('6', 64),
      p_feature_gate_enabled => true
    );
    RAISE EXCEPTION 'expected report provider identity rebind denial';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  BEGIN
    PERFORM public.revenue_head_work_command_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_item_id => item_a, p_report_id => report_a, p_command => 'create',
      p_expected_revision => 0, p_actor_type => 'agent',
      p_actor_id => 'unregistered-head', p_authority_tier => 'department_head',
      p_evidence => evidence_two,
      p_idempotency_key => 'revenue-head:item:unregistered',
      p_request_fingerprint => repeat('7', 64),
      p_feature_gate_enabled => true, p_item_kind => 'exception',
      p_action_scope => 'raise_exception', p_title => 'Synthetic exception',
      p_assignee_type => 'agent', p_assignee_id => 'revenue-head-a',
      p_due_at => now() + interval '1 hour'
    );
    RAISE EXCEPTION 'expected unregistered revenue head denial';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.revenue_head_work_command_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_item_id => item_a, p_report_id => report_a, p_command => 'create',
      p_expected_revision => 0, p_actor_type => 'agent',
      p_actor_id => 'revenue-head-a', p_authority_tier => 'department_head',
      p_evidence => evidence_two,
      p_idempotency_key => 'revenue-head:item:outreach',
      p_request_fingerprint => repeat('8', 64),
      p_feature_gate_enabled => true, p_item_kind => 'work',
      p_action_scope => 'send_outreach', p_title => 'Forbidden outreach',
      p_assignee_type => 'agent', p_assignee_id => 'revenue-head-a',
      p_due_at => now() + interval '1 hour'
    );
    RAISE EXCEPTION 'expected prohibited outreach scope denial';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  create_result := public.revenue_head_work_command_rpc(
    p_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_item_id => item_a, p_report_id => report_a, p_command => 'create',
    p_expected_revision => 0, p_actor_type => 'agent',
    p_actor_id => 'revenue-head-a', p_authority_tier => 'department_head',
    p_evidence => evidence_two,
    p_idempotency_key => 'revenue-head:item:a:create',
    p_request_fingerprint => repeat('9', 64),
    p_feature_gate_enabled => true, p_item_kind => 'exception',
    p_action_scope => 'raise_exception',
    p_title => 'Monitor accepted funnel health exception evidence',
    p_assignee_type => 'agent', p_assignee_id => 'revenue-head-a',
    p_due_at => now() + interval '1 hour'
  );
  BEGIN
    PERFORM public.revenue_head_work_command_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_item_id => item_a, p_report_id => report_a, p_command => 'accept',
      p_expected_revision => 1, p_actor_type => 'human',
      p_actor_id => 'aaaaaaaa-1111-4111-8111-111111111111',
      p_authority_tier => 'owner', p_evidence => evidence_two,
      p_idempotency_key => 'revenue-head:item:a:accept-mismatch',
      p_request_fingerprint => repeat('a', 64),
      p_feature_gate_enabled => true
    );
    RAISE EXCEPTION 'expected assignee acceptance mismatch denial';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  accept_result := public.revenue_head_work_command_rpc(
    p_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_item_id => item_a, p_report_id => report_a, p_command => 'accept',
    p_expected_revision => 1, p_actor_type => 'agent',
    p_actor_id => 'revenue-head-a', p_authority_tier => 'department_head',
    p_evidence => evidence_two,
    p_idempotency_key => 'revenue-head:item:a:accept',
    p_request_fingerprint => repeat('b', 64),
    p_feature_gate_enabled => true
  );
  accept_replay := public.revenue_head_work_command_rpc(
    p_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_item_id => item_a, p_report_id => report_a, p_command => 'accept',
    p_expected_revision => 1, p_actor_type => 'agent',
    p_actor_id => 'revenue-head-a', p_authority_tier => 'department_head',
    p_evidence => evidence_two,
    p_idempotency_key => 'revenue-head:item:a:accept',
    p_request_fingerprint => repeat('b', 64),
    p_feature_gate_enabled => true
  );
  IF accept_replay->>'outcome' <> 'replay' THEN
    RAISE EXCEPTION 'expected exact revenue head work replay';
  END IF;
  BEGIN
    PERFORM public.revenue_head_work_command_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_item_id => item_a, p_report_id => report_a, p_command => 'start',
      p_expected_revision => 1, p_actor_type => 'agent',
      p_actor_id => 'revenue-head-a', p_authority_tier => 'department_head',
      p_evidence => evidence_two,
      p_idempotency_key => 'revenue-head:item:a:stale',
      p_request_fingerprint => repeat('c', 64),
      p_feature_gate_enabled => true
    );
    RAISE EXCEPTION 'expected stale revenue head revision denial';
  EXCEPTION WHEN serialization_failure THEN NULL;
  END;
  start_result := public.revenue_head_work_command_rpc(
    p_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_item_id => item_a, p_report_id => report_a, p_command => 'start',
    p_expected_revision => 2, p_actor_type => 'agent',
    p_actor_id => 'revenue-head-a', p_authority_tier => 'department_head',
    p_evidence => evidence_two,
    p_idempotency_key => 'revenue-head:item:a:start',
    p_request_fingerprint => repeat('d', 64),
    p_feature_gate_enabled => true
  );
  complete_result := public.revenue_head_work_command_rpc(
    p_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_item_id => item_a, p_report_id => report_a, p_command => 'complete',
    p_expected_revision => 3, p_actor_type => 'agent',
    p_actor_id => 'revenue-head-a', p_authority_tier => 'department_head',
    p_evidence => evidence_two,
    p_idempotency_key => 'revenue-head:item:a:complete',
    p_request_fingerprint => repeat('e', 64),
    p_feature_gate_enabled => true,
    p_completion_evidence_digest => repeat('f', 64)
  );
  IF NOT EXISTS (
    SELECT 1 FROM public.revenue_head_reports report
     WHERE report.id = report_a
       AND report.outcome_healthy = true
       AND report.funnel_health = 'healthy'
  ) THEN
    RAISE EXCEPTION 'completed work changed funnel outcome health';
  END IF;

  PERFORM public.revenue_head_work_command_rpc(
    p_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_item_id => escalation_a, p_report_id => report_a, p_command => 'create',
    p_expected_revision => 0, p_actor_type => 'agent',
    p_actor_id => 'revenue-head-a', p_authority_tier => 'department_head',
    p_evidence => evidence_two,
    p_idempotency_key => 'revenue-head:escalation:a:create',
    p_request_fingerprint => repeat('f', 64),
    p_feature_gate_enabled => true, p_item_kind => 'goal',
    p_action_scope => 'track_goal',
    p_title => 'Track funnel recovery against the accepted KPI charter',
    p_assignee_type => 'agent', p_assignee_id => 'revenue-head-a',
    p_due_at => now() + interval '1 hour'
  );
  BEGIN
    PERFORM public.revenue_head_work_command_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_item_id => escalation_a, p_report_id => report_a,
      p_command => 'escalate', p_expected_revision => 1,
      p_actor_type => 'agent', p_actor_id => 'revenue-head-a',
      p_authority_tier => 'department_head', p_evidence => evidence_two,
      p_idempotency_key => 'revenue-head:escalation:a:premature',
      p_request_fingerprint => repeat('a', 64),
      p_feature_gate_enabled => true,
      p_escalation_code => 'sla_risk'
    );
    RAISE EXCEPTION 'expected premature revenue head SLA escalation denial';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  PERFORM public.revenue_head_work_command_rpc(
    p_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_item_id => escalation_a, p_report_id => report_a,
    p_command => 'escalate', p_expected_revision => 1,
    p_actor_type => 'human',
    p_actor_id => 'aaaaaaaa-1111-4111-8111-111111111111',
    p_authority_tier => 'owner', p_evidence => evidence_two,
    p_idempotency_key => 'revenue-head:escalation:a:owner',
    p_request_fingerprint => repeat('b', 64),
    p_feature_gate_enabled => true,
    p_escalation_code => 'owner_material_risk'
  );

  decision_create := public.revenue_head_work_command_rpc(
    p_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_item_id => decision_a, p_report_id => report_a, p_command => 'create',
    p_expected_revision => 0, p_actor_type => 'agent',
    p_actor_id => 'revenue-head-a', p_authority_tier => 'department_head',
    p_evidence => evidence_two,
    p_idempotency_key => 'revenue-head:decision:a:create',
    p_request_fingerprint => repeat('1', 64),
    p_feature_gate_enabled => true, p_item_kind => 'decision',
    p_action_scope => 'request_owner_decision',
    p_title => 'Approve supervised follow-through recommendation',
    p_assignee_type => 'human',
    p_assignee_id => 'aaaaaaaa-1111-4111-8111-111111111111',
    p_due_at => now() + interval '1 hour'
  );
  decision_accept := public.revenue_head_work_command_rpc(
    p_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_item_id => decision_a, p_report_id => report_a, p_command => 'accept',
    p_expected_revision => 1, p_actor_type => 'human',
    p_actor_id => 'aaaaaaaa-1111-4111-8111-111111111111',
    p_authority_tier => 'owner', p_evidence => evidence_two,
    p_idempotency_key => 'revenue-head:decision:a:accept',
    p_request_fingerprint => repeat('2', 64),
    p_feature_gate_enabled => true
  );
  BEGIN
    PERFORM public.revenue_head_work_command_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_item_id => decision_a, p_report_id => report_a,
      p_command => 'record_decision', p_expected_revision => 2,
      p_actor_type => 'agent', p_actor_id => 'revenue-head-a',
      p_authority_tier => 'department_head', p_evidence => evidence_two,
      p_idempotency_key => 'revenue-head:decision:a:spoof',
      p_request_fingerprint => repeat('3', 64),
      p_feature_gate_enabled => true,
      p_completion_evidence_digest => repeat('4', 64),
      p_decision => 'approved'
    );
    RAISE EXCEPTION 'expected department head owner-decision denial';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  decision_result := public.revenue_head_work_command_rpc(
    p_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_item_id => decision_a, p_report_id => report_a,
    p_command => 'record_decision', p_expected_revision => 2,
    p_actor_type => 'human',
    p_actor_id => 'aaaaaaaa-1111-4111-8111-111111111111',
    p_authority_tier => 'owner', p_evidence => evidence_two,
    p_idempotency_key => 'revenue-head:decision:a:owner',
    p_request_fingerprint => repeat('5', 64),
    p_feature_gate_enabled => true,
    p_completion_evidence_digest => repeat('6', 64),
    p_decision => 'approved'
  );

  kill_result := public.revenue_head_kill_switch_rpc(
    '11111111-1111-4111-8111-111111111111',
    'synthetic_containment'
  );
  IF kill_result->>'outcome' <> 'kill_switch_engaged'
     OR kill_result - 'outcome' - 'tenant_id' - 'revision' <> '{}'::jsonb
     OR NOT EXISTS (
       SELECT 1 FROM public.revenue_head_controls control
        WHERE control.tenant_id = '11111111-1111-4111-8111-111111111111'
          AND control.enabled = false
          AND control.execution_mode = 'disabled'
          AND control.kill_switch_engaged = true
     )
     OR NOT EXISTS (
       SELECT 1 FROM public.revenue_head_controls control
        WHERE control.tenant_id = '22222222-2222-4222-8222-222222222222'
          AND control.enabled = true
          AND control.execution_mode = 'supervised_read_only'
          AND control.kill_switch_engaged = false
     ) THEN
    RAISE EXCEPTION 'revenue head kill switch containment invalid';
  END IF;
  BEGIN
    PERFORM public.revenue_head_report_accept_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_report_id => gen_random_uuid(), p_charter_id => charter_a,
      p_period_start => '2026-09-01', p_period_end => '2026-09-30',
      p_source_system => 'sales_ledger', p_source_report_id => 'killed',
      p_leads_created => 0, p_qualified_leads => 0,
      p_appointments_booked => 0, p_appointments_held => 0,
      p_proposals_sent => 0, p_closed_won => 0, p_closed_lost => 0,
      p_open_pipeline_minor => 0, p_booked_revenue_minor => 0,
      p_currency => 'USD', p_average_sales_cycle_days => 0,
      p_evidence => evidence_one,
      p_idempotency_key => 'revenue-head:report:killed',
      p_request_fingerprint => repeat('7', 64),
      p_feature_gate_enabled => true
    );
    RAISE EXCEPTION 'expected engaged revenue head kill switch denial';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
COMMIT;

BEGIN;
DO $$
BEGIN
  BEGIN
    UPDATE public.revenue_head_controls
       SET kill_switch_engaged = false
     WHERE tenant_id = '11111111-1111-4111-8111-111111111111';
    RAISE EXCEPTION 'expected one-way revenue head kill-switch denial';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE public.revenue_head_reports
       SET funnel_health = 'critical'
     WHERE tenant_id = '11111111-1111-4111-8111-111111111111';
    RAISE EXCEPTION 'expected immutable revenue head report denial';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
  END;
END $$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"role":"authenticated","app_metadata":{"tenant_id":"11111111-1111-4111-8111-111111111111","role":"owner"}}',
  true
);
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.revenue_head_charters
     WHERE tenant_id = '22222222-2222-4222-8222-222222222222'
  ) THEN
    RAISE EXCEPTION 'authenticated revenue head RLS tenant isolation failed';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.revenue_head_reports
     WHERE tenant_id = '11111111-1111-4111-8111-111111111111'
  ) THEN
    RAISE EXCEPTION 'authenticated revenue head could not read own report';
  END IF;
END $$;
ROLLBACK;
