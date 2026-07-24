'use strict';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ALLOWED_ACTION_CLASSES = Object.freeze([
  'analysis',
  'classification',
  'draft',
  'retrieval',
]);

function enabled(env, name) {
  return String(env?.[name] ?? '').trim().toLowerCase() === 'true';
}

function enabledUnlessFalse(env, name) {
  return String(env?.[name] ?? '').trim().toLowerCase() !== 'false';
}

function list(env, name) {
  return [...new Set(
    String(env?.[name] ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
  )];
}

/**
 * Pure, value-safe readiness check for the guard-error fail-closed cohort.
 *
 * The profile is deliberately narrow: automated calls only, an exact tenant
 * allowlist, explicitly classified low-risk actions, and no side effect. It
 * never promotes an unclassified call and never emits tenant ids.
 */
function assessAiSafetyEnforcementReadiness({ env = process.env } = {}) {
  const requested = enabled(env, 'AI_FAIL_CLOSED_GUARD_ERRORS_ENABLED');
  const tenantIds = list(env, 'AI_FAIL_CLOSED_TENANT_IDS');
  const actionClasses = list(env, 'AI_FAIL_CLOSED_ACTION_CLASSES');
  const invalidTenantCount = tenantIds.filter((id) => !UUID_PATTERN.test(id)).length;
  const invalidActionCount = actionClasses
    .filter((actionClass) => !ALLOWED_ACTION_CLASSES.includes(actionClass))
    .length;

  const checks = {
    tracking_enabled: enabledUnlessFalse(env, 'AI_USAGE_TRACKING_ENABLED'),
    monitor_enabled: enabledUnlessFalse(env, 'AI_MONITOR_MODE_ENABLED'),
    strict_metadata_enabled: enabled(env, 'AI_STRICT_METADATA_REQUIRED'),
    exact_tenant_cohort: tenantIds.length > 0 && invalidTenantCount === 0,
    bounded_action_classes: actionClasses.length > 0 && invalidActionCount === 0,
  };
  const missing = Object.entries(checks)
    .filter(([, ready]) => !ready)
    .map(([name]) => name);
  const ready = missing.length === 0;

  return {
    schema_version: 1,
    requested,
    ready,
    startup: {
      allowed: !requested || ready,
      decision: requested ? (ready ? 'allow_enforced_cohort' : 'block') : 'allow_inactive',
      reason_code: requested
        ? (ready
          ? 'ai_safety_fail_closed_cohort_ready'
          : 'ai_safety_fail_closed_cohort_invalid')
        : 'ai_safety_fail_closed_cohort_disabled',
    },
    summary: {
      tenant_count: tenantIds.length,
      action_class_count: actionClasses.length,
      invalid_tenant_count: invalidTenantCount,
      invalid_action_class_count: invalidActionCount,
      missing_check_count: missing.length,
    },
    checks,
    missing_checks: missing,
  };
}

function shouldFailClosed(meta = {}, { env = process.env } = {}) {
  const readiness = assessAiSafetyEnforcementReadiness({ env });
  if (!readiness.requested || !readiness.ready) return false;
  if (meta.isAutomated === false || meta.sideEffect !== 'none') return false;

  const tenantIds = list(env, 'AI_FAIL_CLOSED_TENANT_IDS');
  const actionClasses = list(env, 'AI_FAIL_CLOSED_ACTION_CLASSES');
  const tenantId = String(meta.tenantId ?? '').trim().toLowerCase();
  const actionClass = String(meta.actionClass ?? '').trim().toLowerCase();
  return tenantIds.includes(tenantId) && actionClasses.includes(actionClass);
}

class AiSafetyEnforcementReadinessError extends Error {
  constructor(readiness) {
    super('AI safety fail-closed cohort is enabled without complete readiness');
    this.name = 'AiSafetyEnforcementReadinessError';
    this.code = readiness.startup.reason_code;
    this.readiness = readiness;
  }
}

function enforceAiSafetyStartupReadiness({ env = process.env, logger } = {}) {
  const readiness = assessAiSafetyEnforcementReadiness({ env });
  const level = readiness.startup.allowed ? 'info' : 'warn';
  if (logger && typeof logger[level] === 'function') {
    logger[level]('AI safety enforcement readiness', readiness);
  }
  if (!readiness.startup.allowed) {
    throw new AiSafetyEnforcementReadinessError(readiness);
  }
  return readiness;
}

module.exports = {
  ALLOWED_ACTION_CLASSES,
  AiSafetyEnforcementReadinessError,
  assessAiSafetyEnforcementReadiness,
  enforceAiSafetyStartupReadiness,
  shouldFailClosed,
};
