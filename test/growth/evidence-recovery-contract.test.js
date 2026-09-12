'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const enrichment = fs.readFileSync(path.join(root, 'worker/agents/enrichment.js'), 'utf8');
const cron = fs.readFileSync(path.join(root, 'worker/scheduler/cron.js'), 'utf8');
const {
  getSchedule,
  _test: { fgaNeedsDraftSupply, outreachNeedsDraftSupply },
} = require('../../worker/scheduler/cron');
const { recoveryLimits } = require('../../core/growth/workload-policy');
const { FGA_TENANT_ID } = require('../../core/config');
const { resolveEnrichmentWorkload } = require('../../worker/agents/enrichment')._test;

test('evidence recovery is FGA-only, bounded, retryable, and prioritizes restart-ready leads', () => {
  assert.equal(resolveEnrichmentWorkload(FGA_TENANT_ID, {
    evidence_recovery: true,
    recovery_priority: 'restart_ready',
  }, {}).evidenceRecovery, true);
  assert.equal(resolveEnrichmentWorkload('customer-tenant', {
    evidence_recovery: true,
    recovery_priority: 'restart_ready',
  }, {}).evidenceRecovery, false);
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

test('the enrichment agent enforces FGA recovery limits even when a job requests more', () => {
  assert.deepEqual(resolveEnrichmentWorkload(FGA_TENANT_ID, {
    evidence_recovery: true,
    recovery_priority: 'contact',
    limit: 500,
  }, {}), { evidenceRecovery: true, recoveryPriority: 'contact', limit: 5 });
  assert.deepEqual(resolveEnrichmentWorkload(FGA_TENANT_ID, { limit: 500 }, {}), {
    evidenceRecovery: false,
    recoveryPriority: null,
    limit: 25,
  });
  assert.deepEqual(resolveEnrichmentWorkload('customer-tenant', { limit: 500 }, {}), {
    evidenceRecovery: false,
    recoveryPriority: null,
    limit: 500,
  });
});

test('FGA discovery checks demand after the send day and generic customer sweeps exclude FGA', async () => {
  const schedule = getSchedule();
  const fga = { id: FGA_TENANT_ID, slug: 'fga' };
  const customer = { id: 'customer-tenant', slug: 'customer' };
  const fgaDiscovery = schedule.find((job) => job.agent === 'prospecting' && job.cron === '40 18 * * *');
  const customerDiscovery = schedule.find((job) => job.agent === 'prospecting' && job.cron === '0 6 * * *');
  const genericEnrichment = schedule.find((job) =>
    job.agent === 'enrichment' && job.cron === '0 8 * * *' && !job.payload?.evidence_recovery);
  assert.equal(await fgaDiscovery.when(customer), false);
  assert.equal(await fgaNeedsDraftSupply(fga, async () => ({ available: true, hold: false })), true);
  assert.equal(await fgaNeedsDraftSupply(fga, async () => ({ available: true, hold: true })), false);
  assert.equal(await fgaNeedsDraftSupply(fga, async () => { throw new Error('unavailable'); }), false);
  assert.equal(await fgaNeedsDraftSupply(customer, async () => ({ available: true, hold: false })), false);
  assert.equal(customerDiscovery.when(fga), false);
  assert.equal(customerDiscovery.when(customer), true);
  assert.equal(genericEnrichment.when(fga), false);
  assert.equal(genericEnrichment.when(customer), true);
});

test('every paid FGA supply schedule is demand-gated and recovery repeats the gate', () => {
  const schedule = getSchedule();
  const exactFgaSupplyJobs = schedule.filter((job) =>
    (job.agent === 'prospecting' && job.cron === '40 18 * * *')
    || (job.agent === 'enrichment' && job.payload?.evidence_recovery === true)
    || job.agent === 'growth-restart');
  assert.equal(exactFgaSupplyJobs.length, 5);
  for (const job of exactFgaSupplyJobs) {
    assert.equal(job.when, fgaNeedsDraftSupply,
      `${job.agent}:${job.payload?.recovery_priority || 'discovery'} must share the fail-closed supply gate`);
  }
  const sharedOutreach = schedule.find((job) => job.agent === 'outreach' && job.cron === '0 9 * * *');
  assert.equal(sharedOutreach.when, outreachNeedsDraftSupply);
  assert.match(enrichment, /if \(evidenceRecovery\) \{\s*const supply = await readFgaDraftSupply/);
  assert.doesNotMatch(enrichment, /evidenceRecovery && recoveryPriority === 'restart_ready'/);
});

test('the shared outreach schedule preserves customer drafting and gates exact FGA', async () => {
  const fga = { id: FGA_TENANT_ID, slug: 'fga' };
  const customer = { id: 'customer-tenant', slug: 'customer' };
  assert.equal(await outreachNeedsDraftSupply(customer, async () => ({ available: true, hold: true })), true);
  assert.equal(await outreachNeedsDraftSupply(fga, async () => ({ available: true, hold: true })), false);
  assert.equal(await outreachNeedsDraftSupply(fga, async () => ({ available: true, hold: false })), true);
  assert.equal(await outreachNeedsDraftSupply(fga, async () => { throw new Error('unavailable'); }), false);
});
