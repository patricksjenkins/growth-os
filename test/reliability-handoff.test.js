/**
 * Tier-2 handoff: revenue -> reliability.
 *
 * Codex review 2026-07-25: "Configuration and provider failures merely return
 * an empty remediation plan. No structured request is sent to Operations
 * Guardian... There is also no repair verification or control-return
 * contract." That was accurate — Tier 2 was a label on a dead end.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  TIER, REQUESTED_ACTION, openHandoff, verifyHandoffs,
} = require('../core/revenue/reliability-handoff');

const GUARDIAN_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'worker', 'agents', 'revenue-guardian.js'), 'utf8');

/**
 * Records every write so tests can assert on the request that was actually
 * sent. A read (no insert/update in the chain) resolves to `existing`; a write
 * resolves to a fabricated row id.
 */
function stubDb({ existing = [], failOn = null } = {}) {
  const writes = [];
  return {
    writes,
    from(table) {
      const state = { table, op: null, payload: null };
      const settle = () => {
        if (state.op) writes.push({ ...state });
        if (failOn && failOn === state.op) {
          return Promise.resolve({ data: null, error: { message: 'db down' } });
        }
        return Promise.resolve({ data: state.op ? [{ id: 'inc-1' }] : existing, error: null });
      };
      const b = {
        select: () => b, eq: () => b, in: () => b, order: () => b,
        insert(p) { state.op = 'insert'; state.payload = p; return b; },
        update(p) { state.op = 'update'; state.payload = p; return b; },
        limit: () => settle(),
        then: (ok, err) => settle().then(ok, err),
      };
      return b;
    },
  };
}

test('a configuration blocker opens an approval-level request, not a silent no-op', async () => {
  const db = stubDb();
  const r = await openHandoff(db, {
    blockerClass: 'configuration', owningAgent: 'auto-outreach',
    diagnosis: 'ICP target_states missing', businessImpact: '0/25 sent on 2026-07-24',
  });
  assert.strictEqual(r.ok, true);
  const ins = db.writes.find((w) => w.op === 'insert');
  assert.ok(ins, 'a request must actually be written to the ledger');
  assert.strictEqual(ins.payload.issue_type, 'revenue_blocked_configuration');
  assert.strictEqual(ins.payload.permission_level, 2, 'config repair is approval-gated, not auto');
  assert.strictEqual(ins.payload.agent_name, 'auto-outreach', 'must name the owning agent');
  assert.strictEqual(ins.payload.verification_result, 'pending');
  assert.match(ins.payload.links_to_logs.requested_action, /Repair the outbound configuration/);
});

test('a provider outage is escalate-only and requires owner approval', async () => {
  const db = stubDb();
  await openHandoff(db, {
    blockerClass: 'provider', diagnosis: 'Resend 5xx', businessImpact: '0/25',
  });
  const ins = db.writes.find((w) => w.op === 'insert');
  assert.strictEqual(ins.payload.permission_level, 3);
  assert.strictEqual(ins.payload.requires_owner_approval, true);
  assert.ok(ins.payload.approval_reason, 'escalate-only must state what is being asked');
});

test('a persistent blocker updates ONE request instead of filing a new one daily', async () => {
  const db = stubDb({ existing: [{ id: 'inc-existing', attempt_count: 2 }] });
  const r = await openHandoff(db, {
    blockerClass: 'configuration', diagnosis: 'still broken', businessImpact: '0/25',
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.detail, 'handoff refreshed');
  assert.ok(!db.writes.some((w) => w.op === 'insert'), 'must not duplicate the ticket');
});

test('a failed handoff write reports failure — it must not look delivered', async () => {
  const db = stubDb({ failOn: 'insert' });
  const r = await openHandoff(db, {
    blockerClass: 'provider', diagnosis: 'x', businessImpact: 'y',
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.detail, /insert failed/);
});

test('an unroutable blocker class is refused, not guessed at', async () => {
  const r = await openHandoff(stubDb(), { blockerClass: 'vibes', diagnosis: 'x', businessImpact: 'y' });
  assert.strictEqual(r.ok, false);
  assert.match(r.detail, /no Tier-2 route/);
});

/* ── Control return ── */

test('ONLY delivered email closes a handoff', async () => {
  const open = [{ id: 'a', agent_name: 'auto-outreach', issue_type: 'revenue_blocked_provider' }];

  const notYet = stubDb({ existing: open });
  const r1 = await verifyHandoffs(notYet, { sendsResumed: false });
  assert.strictEqual(r1.recovered, 0);
  assert.strictEqual(r1.stillFailing, 1, 'an unrecovered handoff must be marked, not aged quietly');
  assert.strictEqual(
    notYet.writes.find((w) => w.op === 'update').payload.verification_result, 'still_failing');

  const fixed = stubDb({ existing: open });
  const r2 = await verifyHandoffs(fixed, { sendsResumed: true });
  assert.strictEqual(r2.recovered, 1);
  const up = fixed.writes.find((w) => w.op === 'update');
  assert.strictEqual(up.payload.status, 'recovered');
  assert.ok(up.payload.resolved_at, 'recovery must be timestamped');
});

test('no open handoffs is a clean no-op', async () => {
  const r = await verifyHandoffs(stubDb({ existing: [] }), { sendsResumed: true });
  assert.deepStrictEqual(r, { checked: 0, recovered: 0, stillFailing: 0 });
});

/* ── Wiring: the guardian must actually call it ── */

test('the guardian routes every Tier-2 condition to the handoff', () => {
  assert.match(GUARDIAN_SRC, /openHandoff/, 'must open handoffs');
  assert.match(GUARDIAN_SRC, /verifyHandoffs/, 'must verify and return control');
  for (const cls of ['configuration', 'provider', 'remediation_failed', 'data_integrity']) {
    assert.ok(GUARDIAN_SRC.includes(cls), `${cls} must be routed to Tier 2`);
  }
  assert.match(GUARDIAN_SRC, /sendsResumed: counted\.count >= target/,
    'control returns on the outcome, not on an agent reporting success');
});

test('every routed class has a stated requested action', () => {
  for (const cls of Object.keys(TIER)) {
    assert.ok(REQUESTED_ACTION[cls] && REQUESTED_ACTION[cls].length > 20,
      `${cls} must tell reliability what is actually being asked`);
  }
});

test('the handoff never sends, spends, or rewrites config', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'core', 'revenue', 'reliability-handoff.js'), 'utf8');
  assert.ok(!/sendEmail|resend\.|stripe|tenant_config/i.test(src));
  assert.ok(!/\.delete\(/.test(src));
});
