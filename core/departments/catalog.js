'use strict';

/**
 * Canonical supervised Department Head contracts.
 *
 * These definitions are deliberately executable data rather than prompt text.
 * Every consumer receives an immutable copy and must evaluate an action against
 * this catalog before creating department work or a report. A catalog decision
 * never grants production-bound authority; those actions remain subject to the
 * consolidated owner approval boundary.
 */

const DEPARTMENT_KEYS = Object.freeze([
  'reliability',
  'revenue',
  'onboarding',
  'client_success',
  'finance',
  'marketing',
  'product_engineering',
]);

const PRODUCTION_BOUNDARY_ACTIONS = new Set([
  'deploy_production',
  'apply_production_migration',
  'delete_production_data',
  'rewrite_production_data',
  'send_customer_email',
  'send_customer_sms',
  'send_customer_mms',
  'place_customer_voice_call',
  'send_customer_notification',
  'publish_public_content',
  'move_money',
  'charge_customer',
  'refund_customer',
  'change_pricing',
  'change_contract',
  'change_legal_policy',
  'change_compliance_setting',
  'launch_paid_advertising',
  'release_app_store_build',
  'activate_production_write_authority',
]);

const UNIVERSAL_PROHIBITIONS = Object.freeze([
  'cross_tenant_access',
  'conceal_incident',
  'fabricate_evidence',
  'weaken_authorization',
  'expose_credentials',
  'use_customer_data_as_test_data',
]);

const CONTRACTS = {
  reliability: {
    name: 'Reliability, Security, and Agent Operations',
    mission: 'Prove agents are safe, accurate, observable, and producing expected business output.',
    kpis: [
      'outcome_success_by_component',
      'detection_time_and_mttr',
      'false_green_rate',
      'tenant_isolation_coverage',
      'ai_quality_regression_rate',
      'cost_vs_cap',
    ],
    acceptedReportTypes: [
      'agent_outcome_report',
      'incident_reconciliation_report',
      'tenant_isolation_report',
      'security_control_report',
      'cost_cap_report',
    ],
    supervisedActions: [
      'read_only_diagnosis',
      'deduplicate_incidents',
      'draft_recovery_plan',
      'verify_recovery_evidence',
      'assign_supervised_work',
      'escalate_exception',
    ],
    ownerApprovalActions: [
      'accept_risk',
      'override_kill_switch',
      'change_security_enforcement',
      'approve_production_remediation',
      'send_security_incident_communication',
    ],
    prohibitedActions: [
      'retry_outbound_send',
      'suppress_security_incident',
      'disable_tenant_isolation',
    ],
  },
  revenue: {
    name: 'Revenue and Sales',
    mission: 'Create qualified conversations and move accepted opportunities to onboarding without silent stalls.',
    kpis: [
      'qualified_replies_per_week',
      'demo_bookings_per_week',
      'reply_to_demo_conversion',
      'queue_age_and_sla_breaches',
      'suppression_and_identity_incidents',
    ],
    acceptedReportTypes: [
      'lead_action_outcome_report',
      'conversion_cohort_report',
      'scheduling_lifecycle_report',
      'closed_won_handoff_report',
      'suppression_identity_report',
    ],
    supervisedActions: [
      'diagnose_funnel',
      'prioritize_approved_work',
      'draft_experiment',
      'assign_supervised_work',
      'escalate_exception',
    ],
    ownerApprovalActions: [
      'change_price',
      'change_offer',
      'change_outreach_copy',
      'change_send_cap',
      'launch_new_segment',
    ],
    prohibitedActions: [
      'send_with_unproven_tenant_identity',
      'bypass_suppression',
      'claim_unobserved_conversion',
    ],
  },
  onboarding: {
    name: 'Onboarding and Implementation',
    mission: 'Move an accepted customer from signature to verified go-live with explicit acceptance criteria.',
    kpis: [
      'signed_to_live_time',
      'blocked_step_age',
      'first_pass_acceptance',
      'handoff_completeness',
      'thirty_day_rework',
    ],
    acceptedReportTypes: [
      'accepted_customer_handoff',
      'onboarding_workflow_report',
      'prerequisite_exception_report',
      'go_live_acceptance_report',
    ],
    supervisedActions: [
      'build_checklist',
      'advance_accepted_step',
      'prepare_assets',
      'assign_supervised_work',
      'escalate_blocked_prerequisite',
    ],
    ownerApprovalActions: [
      'approve_go_live_exception',
      'perform_relationship_call',
      'release_testflight_build',
      'change_customer_scope',
    ],
    prohibitedActions: [
      'declare_go_live_without_acceptance',
      'commit_unapproved_delivery_date',
      'skip_required_prerequisite',
    ],
  },
  client_success: {
    name: 'Client Success and Support',
    mission: 'Keep customers receiving measurable value, safe service, and timely support.',
    kpis: [
      'support_first_response_and_resolution',
      'verified_value_delivered_per_client',
      'retention_and_save_rate',
      'identity_and_routing_incidents',
      'health_play_completion',
    ],
    acceptedReportTypes: [
      'client_health_intervention_report',
      'support_sla_report',
      'verified_value_report',
      'customer_impact_incident_report',
    ],
    supervisedActions: [
      'triage_from_approved_playbook',
      'draft_support_response',
      'track_sla_clock',
      'assemble_value_evidence',
      'assign_supervised_work',
      'escalate_exception',
    ],
    ownerApprovalActions: [
      'conduct_churn_save',
      'approve_material_service_recovery',
      'promise_credit_or_refund',
      'send_customer_communication',
    ],
    prohibitedActions: [
      'send_with_uncertain_tenant_identity',
      'expose_cross_tenant_content',
      'claim_heuristic_health_as_outcome',
    ],
  },
  finance: {
    name: 'Finance and Data Governance',
    mission: 'Maintain auditable financial truth and govern business-critical data definitions.',
    kpis: [
      'reconciliation_completion',
      'owner_metric_accuracy',
      'close_completion_and_exceptions',
      'margin_per_client',
      'tax_and_compliance_calendar',
    ],
    acceptedReportTypes: [
      'billing_attribution_report',
      'reconciliation_report',
      'monthly_close_report',
      'data_definition_exception_report',
    ],
    supervisedActions: [
      'reconcile_within_approved_rules',
      'draft_close_package',
      'flag_definition_drift',
      'assign_supervised_work',
      'escalate_exception',
    ],
    ownerApprovalActions: [
      'approve_financial_commitment',
      'approve_payment_or_expense',
      'file_tax',
      'change_revenue_definition',
      'change_compliance_setting',
    ],
    prohibitedActions: [
      'move_money',
      'auto_approve_uncertain_expense',
      'sign_off_unreconciled_period',
    ],
  },
  marketing: {
    name: 'Marketing and Brand',
    mission: 'Produce trusted proof and measurable demand without requiring major owner rework.',
    kpis: [
      'accepted_content_rate',
      'publish_plan_completion',
      'qualified_inbound_attributed_to_content',
      'case_studies_shipped',
      'cost_per_qualified_opportunity',
    ],
    acceptedReportTypes: [
      'content_quality_report',
      'content_delivery_report',
      'campaign_attribution_report',
      'case_study_evidence_report',
    ],
    supervisedActions: [
      'plan_against_approved_theme',
      'draft_content',
      'quality_score_content',
      'assign_supervised_work',
      'escalate_exception',
    ],
    ownerApprovalActions: [
      'approve_brand_claim',
      'approve_campaign_budget',
      'publish_public_content',
      'launch_paid_advertising',
    ],
    prohibitedActions: [
      'invent_customer_proof',
      'change_brand_policy',
      'claim_unobserved_attribution',
    ],
  },
  product_engineering: {
    name: 'Product and Engineering',
    mission: 'Ship safe improvements that solve verified customer and operating problems.',
    kpis: [
      'lead_time_to_verified_outcome',
      'regression_escape_rate',
      'customer_impact_defects',
      'rework_rate',
      'roadmap_value_delivered',
    ],
    acceptedReportTypes: [
      'verified_problem_report',
      'release_evidence_report',
      'regression_report',
      'post_release_outcome_report',
      'capacity_report',
    ],
    supervisedActions: [
      'draft_specification',
      'prepare_reversible_change',
      'run_verification',
      'summarize_release_evidence',
      'assign_supervised_work',
      'escalate_exception',
    ],
    ownerApprovalActions: [
      'change_product_scope',
      'merge_release',
      'deploy_production',
      'apply_production_migration',
      'change_customer_behavior',
    ],
    prohibitedActions: [
      'bypass_failed_regression',
      'deploy_without_rollback',
      'claim_unobserved_customer_outcome',
    ],
  },
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function departmentContract(departmentKey) {
  if (!DEPARTMENT_KEYS.includes(departmentKey)) {
    throw new TypeError(`Unknown department contract: ${departmentKey}`);
  }
  return clone({
    key: departmentKey,
    ...CONTRACTS[departmentKey],
    universalProhibitions: UNIVERSAL_PROHIBITIONS,
    executionMode: 'shadow',
    productionWriteAuthority: false,
  });
}

function listDepartmentContracts() {
  return DEPARTMENT_KEYS.map(departmentContract);
}

function evaluateDepartmentAction(departmentKey, action) {
  const contract = departmentContract(departmentKey);
  const normalized = String(action || '').trim();
  if (!normalized) {
    return { decision: 'deny', reason: 'action_required' };
  }
  if (
    PRODUCTION_BOUNDARY_ACTIONS.has(normalized)
    || contract.ownerApprovalActions.includes(normalized)
  ) {
    return { decision: 'owner_approval_required', reason: 'production_or_owner_boundary' };
  }
  if (
    contract.prohibitedActions.includes(normalized)
    || contract.universalProhibitions.includes(normalized)
  ) {
    return { decision: 'deny', reason: 'prohibited_action' };
  }
  if (contract.supervisedActions.includes(normalized)) {
    return { decision: 'allow_shadow', reason: 'supervised_contract' };
  }
  return { decision: 'deny', reason: 'unregistered_action' };
}

module.exports = {
  DEPARTMENT_KEYS,
  PRODUCTION_BOUNDARY_ACTIONS,
  UNIVERSAL_PROHIBITIONS,
  departmentContract,
  listDepartmentContracts,
  evaluateDepartmentAction,
};
