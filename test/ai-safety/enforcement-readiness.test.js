'use strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  AiSafetyEnforcementReadinessError,
  assessAiSafetyEnforcementReadiness,
  enforceAiSafetyStartupReadiness,
  shouldFailClosed,
} = require('../../core/ai-safety/enforcement-readiness');

const TENANT_A = '30566ed6-026a-45e1-9502-029e6219df31';
const TENANT_B = '40566ed6-026a-45e1-9502-029e6219df32';

function readyEnv() {
  return {
    AI_FAIL_CLOSED_GUARD_ERRORS_ENABLED: 'true',
    AI_FAIL_CLOSED_TENANT_IDS: TENANT_A,
    AI_FAIL_CLOSED_ACTION_CLASSES: 'analysis,classification',
    AI_USAGE_TRACKING_ENABLED: 'true',
    AI_MONITOR_MODE_ENABLED: 'true',
    AI_STRICT_METADATA_REQUIRED: 'true',
  };
}

test('fail-closed cohort is disabled by default and startup remains compatible', () => {
  const readiness = assessAiSafetyEnforcementReadiness({ env: {} });
  assert.equal(readiness.requested, false);
  assert.equal(readiness.startup.allowed, true);
  assert.equal(readiness.startup.decision, 'allow_inactive');
});

test('requested enforcement blocks startup unless all readiness checks pass', () => {
  const env = {
    AI_FAIL_CLOSED_GUARD_ERRORS_ENABLED: 'true',
    AI_FAIL_CLOSED_TENANT_IDS: 'not-a-tenant',
    AI_FAIL_CLOSED_ACTION_CLASSES: 'customer_send',
  };
  assert.throws(
    () => enforceAiSafetyStartupReadiness({ env }),
    (error) => {
      assert.ok(error instanceof AiSafetyEnforcementReadinessError);
      assert.equal(error.code, 'ai_safety_fail_closed_cohort_invalid');
      assert.equal(error.readiness.summary.invalid_tenant_count, 1);
      assert.equal(error.readiness.summary.invalid_action_class_count, 1);
      assert.equal(JSON.stringify(error).includes('not-a-tenant'), false);
      return true;
    }
  );
});

test('eligible action must match exact tenant, low-risk class, and no-side-effect contract', () => {
  const env = readyEnv();
  assert.equal(shouldFailClosed({
    tenantId: TENANT_A,
    actionClass: 'analysis',
    sideEffect: 'none',
    isAutomated: true,
  }, { env }), true);
  assert.equal(shouldFailClosed({
    tenantId: TENANT_B,
    actionClass: 'analysis',
    sideEffect: 'none',
    isAutomated: true,
  }, { env }), false);
  assert.equal(shouldFailClosed({
    tenantId: TENANT_A,
    actionClass: 'analysis',
    sideEffect: 'customer_message',
    isAutomated: true,
  }, { env }), false);
  assert.equal(shouldFailClosed({
    tenantId: TENANT_A,
    actionClass: 'analysis',
    sideEffect: 'none',
    isAutomated: false,
  }, { env }), false);
});

test('readiness output contains counts and checks, never tenant identifiers', () => {
  const serialized = JSON.stringify(assessAiSafetyEnforcementReadiness({
    env: readyEnv(),
  }));
  assert.equal(serialized.includes(TENANT_A), false);
});

test('API checks AI safety readiness before opening its listener', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'api', 'server.js'),
    'utf8'
  );
  const readiness = source.indexOf(
    'enforceAiSafetyStartupReadiness({ env: process.env, logger: log });'
  );
  const listen = source.indexOf('app.listen(PORT');
  assert.ok(readiness >= 0);
  assert.ok(listen >= 0);
  assert.ok(readiness < listen);
});
