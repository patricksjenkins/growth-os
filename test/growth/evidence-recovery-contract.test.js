'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const enrichment = fs.readFileSync(path.join(root, 'worker/agents/enrichment.js'), 'utf8');
const cron = fs.readFileSync(path.join(root, 'worker/scheduler/cron.js'), 'utf8');
const { getSchedule } = require('../../worker/scheduler/cron');
const { recoveryLimits } = require('../../core/growth/workload-policy');

test('evidence recovery is FGA-only, bounded, retryable, and prioritizes restart-ready leads', () => {
  assert.match(enrichment, /payload\.evidence_recovery === true && tenant\.id === FGA_TENANT_ID/);
  assert.match(enrichment, /growth_evidence_attempts', 5/);
  assert.match(enrichment, /recoveryPriority === 'restart_ready'/);
  assert.match(enrichment, /enqueueFgaScoringHandoffs/);
  assert.match(enrichment, /source: 'evidence_recovery_handoff'/);
  assert.match(enrichment, /lead\.status === 'new_lead'/);
  assert.match(enrichment, /\.gte\('lead_score', 60\)/);
  assert.match(enrichment, /\.eq\('outreach_ready', true\)/);
  const recovery = Object.fromEntries(getSchedule()
    .filter((job) => job.agent === 'enrichment' && job.payload?.evidence_recovery)
    .map((job) => [job.payload.recovery_priority, job.payload.limit]));
  assert.deepEqual(recovery, recoveryLimits({}));
  assert.equal((cron.match(/evidence_recovery: true/g) || []).length, 3);
});

test('FGA recovery limits are configurable but cannot silently exceed the reviewed ceiling', () => {
  assert.deepEqual(recoveryLimits({}), { restart_ready: 25, general: 10, contact: 5 });
  assert.deepEqual(recoveryLimits({
    FGA_RESTART_RECOVERY_DAILY_LIMIT: '100',
    FGA_GENERAL_RECOVERY_DAILY_LIMIT: '0',
    FGA_CONTACT_RECOVERY_DAILY_LIMIT: 'bad',
  }), { restart_ready: 25, general: 1, contact: 5 });
});
