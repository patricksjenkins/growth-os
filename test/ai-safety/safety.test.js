/**
 * AI Safety — unit + runaway-simulation tests (Phase 16).
 * All tests run against an in-memory fake DB (no network, no real Supabase,
 * no provider calls). They verify the monitor-only contract: things are
 * DETECTED and LOGGED but NOT blocked while enforcement flags are off.
 */

'use strict';

// db/client builds a Supabase client at require-time; give it dummy env so the
// require doesn't throw, then swap getServiceClient for our fake below.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { makeClient } = require('./fake-db');

const dbc = require('../../db/client');

// Shared store simulates the single source of truth (the database).
let store;
function resetDb() { store = {}; dbc.getServiceClient = () => makeClient(store); }

// Reset all AI safety env to "unset" so each test controls its own flags.
const AI_ENV = [
  'AI_USAGE_TRACKING_ENABLED', 'AI_MONITOR_MODE_ENABLED', 'AI_ALERTS_ENABLED',
  'AI_HARD_LIMITS_ENABLED', 'AI_CIRCUIT_BREAKER_ENABLED', 'AI_QUEUE_LIMITS_ENABLED',
  'AI_IDEMPOTENCY_ENFORCEMENT', 'AI_STRICT_METADATA_REQUIRED', 'AI_DISTRIBUTED_RATE_LIMIT_ENABLED',
  'AI_PROVIDER_KILL_SWITCH_ENABLED', 'AI_AGENT_KILL_SWITCH_ENABLED', 'AI_COST_ENFORCEMENT_ENABLED',
  'AI_MANUAL_BATCH_APPROVAL_ENABLED', 'AI_MAX_CALLS_PER_TENANT_PER_MINUTE', 'AI_BATCH_APPROVAL_THRESHOLD',
];
function clearEnv() { for (const k of AI_ENV) delete process.env[k]; }

beforeEach(() => { resetDb(); clearEnv(); });
afterEach(() => { clearEnv(); });

const flags = require('../../core/ai-safety/flags');
const tracker = require('../../core/ai-safety/usage-tracker');
const switches = require('../../core/ai-safety/switches');
const guard = require('../../core/ai-safety/guard');
const idem = require('../../core/ai-safety/idempotency');
const events = require('../../core/ai-safety/events');
const { guardedEnqueue } = require('../../core/ai-safety/guarded-enqueue');

const TENANT = '30566ed6-026a-45e1-9502-029e6219df31';

// ---------------------------------------------------------------------------
// Phase 4: safe-default flag contract
// ---------------------------------------------------------------------------
test('flags: safe defaults — observability ON, all enforcement OFF', () => {
  const snap = flags.snapshot();
  assert.equal(snap.flags.trackingEnabled, true);
  assert.equal(snap.flags.monitorMode, true);
  assert.equal(snap.flags.alertsEnabled, true);
  assert.equal(snap.flags.hardLimits, false);
  assert.equal(snap.flags.circuitBreaker, false);
  assert.equal(snap.flags.idempotencyEnforcement, false);
  assert.equal(snap.state, 'monitoring_only');
});

test('flags: each enforcement flag is independent and defaults off', () => {
  assert.equal(flags.flags.hardLimits(), false);
  process.env.AI_HARD_LIMITS_ENABLED = 'true';
  assert.equal(flags.flags.hardLimits(), true);
  assert.equal(flags.flags.circuitBreaker(), false); // independent
  assert.equal(flags.snapshot().state, 'partial_enforcement');
});

test('flags: missing var never disables existing system (tracking on by default)', () => {
  delete process.env.AI_USAGE_TRACKING_ENABLED;
  assert.equal(flags.flags.trackingEnabled(), true);
});

// ---------------------------------------------------------------------------
// Phase 10: idempotency key determinism
// ---------------------------------------------------------------------------
test('idempotency: key is deterministic and stage-sensitive', () => {
  const a = idem.outreachKey({ tenantId: TENANT, leadId: 'L1', campaignId: 'C', campaignStage: 'initial' });
  const b = idem.outreachKey({ tenantId: TENANT, leadId: 'L1', campaignId: 'C', campaignStage: 'initial' });
  const c = idem.outreachKey({ tenantId: TENANT, leadId: 'L1', campaignId: 'C', campaignStage: 'followup_1' });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

// ---------------------------------------------------------------------------
// Phase 3: usage tracking records (incl. untracked flag), respects flag
// ---------------------------------------------------------------------------
test('usage-tracker: records an event and flags untracked metadata', async () => {
  await tracker.recordUsage({ provider: 'anthropic', model: 'claude-sonnet-4-6', inputTokens: 100, outputTokens: 50 });
  assert.equal(store.ai_usage_events.length, 1);
  assert.equal(store.ai_usage_events[0].untracked, true); // no tenant/agent

  await tracker.recordUsage({ tenantId: TENANT, agentName: 'outreach', model: 'claude-sonnet-4-6' });
  assert.equal(store.ai_usage_events[1].untracked, false);
});

test('usage-tracker: tracking flag OFF means no write (still never throws)', async () => {
  process.env.AI_USAGE_TRACKING_ENABLED = 'false';
  const r = await tracker.recordUsage({ tenantId: TENANT, agentName: 'outreach' });
  assert.equal(r.recorded, false);
  assert.equal(store.ai_usage_events, undefined);
});

// ---------------------------------------------------------------------------
// Phase 6/7: switches monitor vs enforce, human exemption
// ---------------------------------------------------------------------------
test('switches: open kill switch does NOT block when enforcement off', async () => {
  await switches.setSwitch({ kind: 'kill_switch', scope: 'provider', scopeValue: 'anthropic', state: 'open', reason: 'test', actor: 'tester' });
  const decision = await switches.evaluate({ provider: 'anthropic', agentName: 'outreach', isAutomated: true });
  assert.equal(decision.blocked, false);
  assert.equal(decision.open.length, 1);
  // audit trail recorded
  assert.equal(store.ai_safety_switch_audit.length, 1);
  assert.equal(store.ai_safety_switch_audit[0].new_state, 'open');
});

test('switches: open provider kill switch BLOCKS automated when enforcement on, exempts humans', async () => {
  process.env.AI_PROVIDER_KILL_SWITCH_ENABLED = 'true';
  await switches.setSwitch({ kind: 'kill_switch', scope: 'provider', scopeValue: 'anthropic', state: 'open', reason: 'kill', actor: 'tester' });
  const automated = await switches.evaluate({ provider: 'anthropic', isAutomated: true });
  assert.equal(automated.blocked, true);
  const human = await switches.evaluate({ provider: 'anthropic', isAutomated: false });
  assert.equal(human.blocked, false);
  assert.equal(human.exempt, 'human_initiated');
});

// ---------------------------------------------------------------------------
// guard.beforeCall monitor vs enforce
// ---------------------------------------------------------------------------
test('guard.beforeCall: monitor mode allows even with an open switch, logs would_block', async () => {
  await switches.setSwitch({ kind: 'kill_switch', scope: 'agent', scopeValue: 'outreach', state: 'open', reason: 'x', actor: 't' });
  const decision = await guard.beforeCall({ provider: 'anthropic', agentName: 'outreach', isAutomated: true });
  assert.equal(decision.allow, true); // NOT blocked in monitor mode
  const evt = (store.ai_safety_events || []).find((e) => e.event_type === 'would_block');
  assert.ok(evt, 'a would_block event was logged');
  assert.equal(evt.enforced, false);
});

test('guard.beforeCall: blocks when agent kill switch enforcement enabled', async () => {
  process.env.AI_AGENT_KILL_SWITCH_ENABLED = 'true';
  await switches.setSwitch({ kind: 'kill_switch', scope: 'agent', scopeValue: 'outreach', state: 'open', reason: 'x', actor: 't' });
  const decision = await guard.beforeCall({ provider: 'anthropic', agentName: 'outreach', isAutomated: true });
  assert.equal(decision.allow, false);
});

// ---------------------------------------------------------------------------
// Phase 5: threshold evaluation in monitor mode (detect, don't block)
// ---------------------------------------------------------------------------
test('guard.evaluateThresholds: per-minute breach is logged but not enforced', async () => {
  process.env.AI_MAX_CALLS_PER_TENANT_PER_MINUTE = '5';
  for (let i = 0; i < 8; i++) {
    await tracker.recordUsage({ tenantId: TENANT, agentName: 'outreach', model: 'claude-sonnet-4-6' });
  }
  const breached = await guard.evaluateThresholds({ tenantId: TENANT, agentName: 'outreach' });
  assert.ok(breached.includes('tenant_per_minute'));
  const evt = store.ai_safety_events.find((e) => e.rule === 'tenant_per_minute');
  assert.ok(evt);
  assert.equal(evt.enforced, false);          // monitor-only
  assert.equal(evt.detail.would_block, true);
});

// ---------------------------------------------------------------------------
// Phase 11: guarded enqueue — 104 jobs become ONE tracked batch
// ---------------------------------------------------------------------------
test('guarded-enqueue: 104-lead backfill = one batch of 104, flagged large, not held', async () => {
  process.env.AI_BATCH_APPROVAL_THRESHOLD = '20';
  const items = Array.from({ length: 104 }, (_, i) => ({ lead_id: `lead_${i}` }));
  const res = await guardedEnqueue({ tenantId: TENANT, agentName: 'outreach', items, source: 'manual_script', reason: 'apify_email_one_shot_test' });
  assert.equal(res.ok, true);
  assert.equal(res.enqueued, 104);
  assert.equal(res.flaggedLarge, true);
  assert.equal(res.pendingApproval, false);     // approval gating off by default
  assert.equal(store.ai_job_batches.length, 1); // ONE batch, not 104 records
  assert.equal(store.ai_job_batches[0].item_count, 104);
  assert.equal(store.agent_jobs.length, 104);
  assert.ok(store.agent_jobs.every((j) => j.batch_id === store.ai_job_batches[0].id));
  const evt = store.ai_safety_events.find((e) => e.event_type === 'large_batch');
  assert.ok(evt);
});

test('guarded-enqueue: large batch HELD for approval when gating enabled', async () => {
  process.env.AI_BATCH_APPROVAL_THRESHOLD = '20';
  process.env.AI_MANUAL_BATCH_APPROVAL_ENABLED = 'true';
  const items = Array.from({ length: 50 }, (_, i) => ({ lead_id: `l${i}` }));
  const res = await guardedEnqueue({ tenantId: TENANT, agentName: 'outreach', items, source: 'manual_script' });
  assert.equal(res.pendingApproval, true);
  assert.equal(res.enqueued, 0);                // jobs NOT created until approved
  assert.equal((store.agent_jobs || []).length, 0);
  assert.equal(store.ai_job_batches[0].status, 'pending_approval');
});

// ---------------------------------------------------------------------------
// Phase 10: duplicate detection (monitor-only)
// ---------------------------------------------------------------------------
test('idempotency: duplicate outreach detected and logged, not blocked', async () => {
  store.outreach_sequences = [{ id: 's1', tenant_id: TENANT, lead_id: 'L9', sequence_status: 'sent', created_at: new Date().toISOString() }];
  const r = await idem.detectOutreachDuplicate({ tenantId: TENANT, leadId: 'L9', campaignStage: 'initial' });
  assert.equal(r.duplicate, true);
  assert.equal(r.wouldBlock, true);             // would block, but enforcement off
  assert.ok(r.signals.includes('already_sent'));
  const evt = store.ai_safety_events.find((e) => e.event_type === 'duplicate');
  assert.ok(evt);
  assert.equal(evt.enforced, false);
});

// ---------------------------------------------------------------------------
// Phase 14: alert delivery to the owner notifications feed + dedup
// ---------------------------------------------------------------------------
test('alerts: warning/critical deliver to notifications feed; dedup suppresses repeats', async () => {
  const r1 = await events.alert({ dedupKey: 'k1', severity: 'warning', rule: 'tenant_per_minute', tenantId: TENANT, agentName: 'outreach', detail: { count: 12, limit: 10 } });
  assert.equal(r1.alerted, true);
  assert.equal(r1.delivered, true);
  assert.equal(store.notifications.length, 1);
  assert.equal(store.notifications[0].category, 'ai_safety_alert');

  // Same dedupKey within cooldown — suppressed, no second notification.
  const r2 = await events.alert({ dedupKey: 'k1', severity: 'warning', rule: 'tenant_per_minute', tenantId: TENANT });
  assert.equal(r2.suppressed, true);
  assert.equal(store.notifications.length, 1);
});

test('alerts: info severity logs but does NOT ping the owner', async () => {
  await events.alert({ dedupKey: 'info1', severity: 'info', rule: 'large_batch', tenantId: TENANT });
  assert.equal((store.notifications || []).length, 0);
});

test('alerts: disabled flag means no alert at all', async () => {
  process.env.AI_ALERTS_ENABLED = 'false';
  const r = await events.alert({ dedupKey: 'k2', severity: 'critical', rule: 'x', tenantId: TENANT });
  assert.equal(r.alerted, false);
  assert.equal((store.notifications || []).length, 0);
});

// ---------------------------------------------------------------------------
// RUNAWAY SIMULATION (Phase 16) — reproduce the 2026-06-09 incident shape and
// assert the system records/alerts while NOT interrupting normal operation.
// ---------------------------------------------------------------------------
test('runaway sim: 104 single-lead jobs + repeated lead + 2 workers + restart', async () => {
  process.env.AI_MAX_CALLS_PER_TENANT_PER_MINUTE = '10';

  // (1) 104 single-lead outreach jobs arrive as ONE guarded batch.
  const items = Array.from({ length: 104 }, (_, i) => ({ lead_id: `lead_${i}` }));
  const batch = await guardedEnqueue({ tenantId: TENANT, agentName: 'outreach', items, source: 'manual_script', reason: 'apify_email_one_shot_2026-06-09' });
  assert.equal(batch.flaggedLarge, true);
  assert.equal(store.ai_job_batches.length, 1, 'burst visible as ONE batch');

  // (2) Simulate TWO workers (separate client instances, SAME store) each
  //     recording provider calls for the same lead — proving shared counting.
  const workerA = makeClient(store);
  const workerB = makeClient(store);
  dbc.getServiceClient = () => workerA;
  for (let i = 0; i < 6; i++) await tracker.recordUsage({ tenantId: TENANT, agentName: 'outreach', leadId: 'lead_0', model: 'claude-sonnet-4-6' });
  dbc.getServiceClient = () => workerB;
  for (let i = 0; i < 6; i++) await tracker.recordUsage({ tenantId: TENANT, agentName: 'outreach', leadId: 'lead_0', model: 'claude-sonnet-4-6' });

  // Both workers' calls land in the same ledger (12 total, restart-proof).
  assert.equal(store.ai_usage_events.length, 12);

  // (3) Threshold evaluation sees the combined cross-worker total and flags it.
  const breached = await guard.evaluateThresholds({ tenantId: TENANT, agentName: 'outreach', leadId: 'lead_0' });
  assert.ok(breached.includes('tenant_per_minute'), 'cross-worker total breaches the minute cap');
  assert.ok(breached.includes('calls_per_lead'), 'repeated same-lead calls flagged');

  // (4) A "restart" = brand new client, SAME store. Counters persist.
  dbc.getServiceClient = () => makeClient(store);
  const afterRestart = await tracker.countCalls({ minutes: 1, tenantId: TENANT });
  assert.equal(afterRestart, 12, 'usage totals survive a restart (DB-backed, not in-memory)');

  // (5) Monitor-mode contract: NOTHING was blocked. Every safety event is
  //     enforced:false, and a provider call guard still allows.
  const allEvents = store.ai_safety_events || [];
  assert.ok(allEvents.length > 0, 'events were recorded');
  assert.ok(allEvents.every((e) => e.enforced === false), 'no event enforced/blocked in monitor mode');
  const decision = await guard.beforeCall({ tenantId: TENANT, agentName: 'outreach', provider: 'anthropic', isAutomated: true });
  assert.equal(decision.allow, true, 'normal operation remains available while enforcement disabled');
});
