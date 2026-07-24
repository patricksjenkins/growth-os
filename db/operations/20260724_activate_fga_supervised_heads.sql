-- FGA-only supervised Department Head activation.
--
-- Scope:
--   * Repairs the missing authoritative tenant_users membership for the FGA
--     platform owner from immutable auth app_metadata.
--   * Enables all seven Department Heads in shadow/supervised-read-only mode.
--   * Stages the Chief of Staff control but keeps it disabled and killed until
--     accepted Reliability and Revenue reports satisfy its dependency gate.
--   * Grants no production write, provider dispatch, customer communication,
--     money movement, pricing, deployment, migration, or release authority.
--
-- This operation is idempotent and targets only the tenant with slug `fga`.

BEGIN;

DO $$
DECLARE
  v_tenant_id uuid;
  v_actor_id uuid;
  v_actor_email text;
  v_actor_role text;
BEGIN
  SELECT tenant.id
    INTO STRICT v_tenant_id
    FROM public.tenants tenant
   WHERE tenant.slug = 'fga';

  SELECT
    app_user.id,
    app_user.email,
    app_user.raw_app_meta_data->>'role'
    INTO STRICT v_actor_id, v_actor_email, v_actor_role
    FROM auth.users app_user
   WHERE NULLIF(app_user.raw_app_meta_data->>'tenant_id', '')::uuid = v_tenant_id
     AND app_user.raw_app_meta_data->>'role' IN (
       'owner', 'platform_owner', 'founder', 'admin',
       'client_owner', 'tenant_owner'
     )
   ORDER BY app_user.created_at
   LIMIT 1;

  INSERT INTO public.tenant_users (
    tenant_id, user_id, role, email, full_name
  ) VALUES (
    v_tenant_id, v_actor_id, v_actor_role, v_actor_email, NULL
  )
  ON CONFLICT (tenant_id, user_id) DO UPDATE SET
    role = EXCLUDED.role,
    email = EXCLUDED.email;

  INSERT INTO public.reliability_head_controls (
    tenant_id, department_head_id, mission, kpi_contract,
    authority_contract, enabled, execution_mode, kill_switch_engaged,
    revision, activated_by, activation_evidence
  ) VALUES (
    v_tenant_id,
    'reliability-head-v1',
    'Protect tenant isolation and prove reliable business outcomes.',
    '{
      "incident_detection_to_ack_minutes":{"target":"lte_15"},
      "tenant_isolation_gate_pass_rate":{"target":"eq_1"},
      "verified_recovery_rate":{"target":"gte_0_95"},
      "agent_business_outcome_rate":{"target":"gte_0_9"},
      "audit_evidence_completeness":{"target":"eq_1"},
      "sla_compliance_rate":{"target":"gte_0_95"}
    }'::jsonb,
    '{"allowed":["analyze","recommend","record_shadow_work","escalate"]}'::jsonb,
    true, 'shadow', false, 0, v_actor_id,
    '{"source":"owner_authorized_fga_activation"}'::jsonb
  );

  INSERT INTO public.revenue_head_controls (
    tenant_id, enabled, execution_mode, kill_switch_engaged,
    registered_agent_id, activated_by, activation_evidence
  ) VALUES (
    v_tenant_id, true, 'supervised_read_only', false,
    'revenue-head-v1', v_actor_id,
    '{"source":"owner_authorized_fga_activation"}'::jsonb
  );

  INSERT INTO public.onboarding_head_controls (
    tenant_id, registered_head_id, mission, kpi_contract,
    authority_contract, enabled, execution_mode, kill_switch_engaged,
    activated_by, activation_evidence
  ) VALUES (
    v_tenant_id,
    'onboarding-head-v1',
    'Deliver acknowledged implementations with evidence and proven customer outcomes.',
    '{
      "closed_won_to_accept_minutes":{"target":"lte_60"},
      "accepted_to_acknowledged_minutes":{"target":"lte_240"},
      "evidence_complete_handoff_rate":{"target":"eq_1"},
      "implementation_completion_rate":{"target":"gte_0_95"},
      "onboarding_sla_compliance_rate":{"target":"gte_0_95"},
      "exception_resolution_rate":{"target":"gte_0_95"},
      "time_to_first_value_days":{"target":"lte_14"},
      "customer_outcome_receipt_rate":{"target":"eq_1"}
    }'::jsonb,
    '{"allowed":["analyze","recommend","record_supervised_work","escalate"]}'::jsonb,
    true, 'shadow', false, v_actor_id,
    '{"source":"owner_authorized_fga_activation"}'::jsonb
  );

  INSERT INTO public.client_success_head_controls (
    tenant_id, enabled, execution_mode, kill_switch_engaged,
    registered_agent_id, registered_support_adapter_id, activated_by,
    activation_evidence
  ) VALUES (
    v_tenant_id, true, 'supervised_read_only', false,
    'client-success-head-v1', 'client-success-support-adapter-v1',
    v_actor_id,
    '{"source":"owner_authorized_fga_activation"}'::jsonb
  );

  INSERT INTO public.finance_governance_head_controls (
    tenant_id, registered_head_id, mission, kpi_contract,
    enabled, execution_mode, kill_switch_engaged,
    activated_by, activation_evidence
  ) VALUES (
    v_tenant_id,
    'finance-head-v1',
    'Protect reconciled integer financial truth and governed evidence without production authority.',
    '{
      "reconciliation_match_rate":{"target_bps":10000},
      "monthly_close_sla_days":{"target":5},
      "exception_resolution_sla_hours":{"target":24},
      "data_quality_pass_rate":{"target_bps":10000},
      "evidence_completeness_rate":{"target_bps":10000},
      "tenant_isolation_gate_pass_rate":{"target_bps":10000}
    }'::jsonb,
    true, 'supervised_read_only', false, v_actor_id,
    '{"source":"owner_authorized_fga_activation"}'::jsonb
  );

  INSERT INTO public.marketing_brand_head_controls (
    tenant_id, registered_head_id, mission, kpi_contract,
    max_observation_cohort_size, enabled, execution_mode,
    kill_switch_engaged, activated_by, activation_evidence
  ) VALUES (
    v_tenant_id,
    'marketing-head-v1',
    'Protect evidence-backed content quality, brand compliance, and accountable marketing follow-through without production authority.',
    '{
      "content_quality_acceptance_rate":{"target_bps":9000},
      "delivery_receipt_completeness_rate":{"target_bps":10000},
      "audience_evidence_completeness_rate":{"target_bps":10000},
      "reply_observation_rate":{"target_bps":500},
      "conversion_observation_rate":{"target_bps":100},
      "brand_compliance_exception_sla_hours":{"target":24},
      "cohort_size_limit":{"maximum":100}
    }'::jsonb,
    100, true, 'supervised_read_only', false, v_actor_id,
    '{"source":"owner_authorized_fga_activation"}'::jsonb
  );

  INSERT INTO public.product_engineering_head_controls (
    tenant_id, registered_head_id, mission, kpi_contract,
    authority_contract, enabled, execution_mode, kill_switch_engaged,
    activated_by, activation_evidence
  ) VALUES (
    v_tenant_id,
    'product-engineering-head-v1',
    'Protect product quality while proving that engineering work creates measured outcomes.',
    '{
      "reliability_quality_pass_rate":{"target":"eq_1"},
      "change_lead_time_hours":{"target":"lte_24"},
      "change_throughput_rate":{"target":"gte_1"},
      "regression_escape_rate":{"target":"eq_0"},
      "tenant_isolation_gate_pass_rate":{"target":"eq_1"},
      "incident_escape_rate":{"target":"eq_0"},
      "rollback_readiness_rate":{"target":"eq_1"},
      "accessibility_debt_count":{"target":"lte_0"},
      "security_debt_count":{"target":"lte_0"},
      "product_outcome_achievement_rate":{"target":"gte_0_8"}
    }'::jsonb,
    '{"allowed":["analyze","recommend","record_supervised_work","escalate"]}'::jsonb,
    true, 'shadow', false, v_actor_id,
    '{"source":"owner_authorized_fga_activation"}'::jsonb
  );

  INSERT INTO public.cos_supervision_controls (
    tenant_id, enabled, execution_mode, read_only, kill_switch_engaged,
    production_write_enabled, provider_dispatch_enabled,
    customer_communication_enabled, financial_action_enabled,
    revision, activated_by, activation_evidence
  ) VALUES (
    v_tenant_id, false, 'disabled', true, true,
    false, false, false, false,
    0, v_actor_id,
    '{"source":"staged_pending_accepted_reliability_and_revenue_reports"}'::jsonb
  );
END;
$$;

COMMIT;
