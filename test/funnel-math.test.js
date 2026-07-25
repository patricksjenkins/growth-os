/**
 * A funnel must be arithmetically possible.
 *
 * Codex review 2026-07-25: the shipped stages chained `input` from the
 * previous stage's output while sourcing each `output` from an unrelated
 * query — a lifetime count, a current stock, or a same-day decision. The live
 * production read showed 575 "qualified" from 295 "contactable" and 164
 * "sequenced" from 0 sends. Those numbers appeared on the one dashboard meant
 * to be trustworthy evidence.
 */

const test = require('node:test');
const assert = require('node:assert');
const { validateStages, STAGES, OWNER_AGENT } = require('../core/revenue/funnel-trace');

test('a well-formed funnel reports no anomalies', () => {
  assert.deepStrictEqual(validateStages([
    { id: 'drafts_available', input: 96, output: 96 },
    { id: 'gate_evaluated', input: 96, output: 40 },
    { id: 'gate_passed', input: 40, output: 25 },
    { id: 'provider_accepted', input: 25, output: 25 },
  ]), []);
});

test('THE BUG: a stage emitting more than it received is reported', () => {
  const a = validateStages([
    { id: 'contactable', input: 683, output: 295 },
    { id: 'qualified', input: 295, output: 575 },
  ]);
  assert.strictEqual(a.length, 1, 'the impossible 575-of-295 must be caught');
  assert.strictEqual(a[0].stage, 'qualified');
  assert.match(a[0].detail, /emits 575 from an input of 295/);
});

test('a broken chain between stages is reported', () => {
  const a = validateStages([
    { id: 'sent', input: 5, output: 0 },
    { id: 'sequenced', input: 0, output: 164 },
  ]);
  // 164 sequenced from 0 sends: caught as an over-emit.
  assert.ok(a.some((x) => x.stage === 'sequenced'), 'the 164-from-0 must be caught');
});

test('a stage fed by something other than the previous output is reported', () => {
  const a = validateStages([
    { id: 'qualified', input: 295, output: 200 },
    { id: 'drafted', input: 496, output: 96 },
  ]);
  assert.ok(a.some((x) => /does not match/.test(x.detail)),
    'jumping to an unrelated population must not pass silently');
});

test('validation reports rather than throws — a blank panel is a silent failure', () => {
  assert.doesNotThrow(() => validateStages([
    { id: 'gate_passed', input: 0, output: 0 },
    { id: 'provider_accepted', input: 0, output: 3 },
  ]));
  const a = validateStages([
    { id: 'gate_passed', input: 0, output: 0 },
    { id: 'provider_accepted', input: 0, output: 3 },
  ]);
  assert.match(a[0].likely, /bypasses the gate ledger/,
    'a bulk send outside the gate ledger is a real, explainable case');
});

test('the stage list is same-day flow only — no lifetime stock', () => {
  assert.deepStrictEqual([...STAGES],
    ['drafts_available', 'gate_evaluated', 'gate_passed', 'provider_accepted']);
  for (const s of STAGES) {
    assert.ok(OWNER_AGENT[s], `${s} must name an owning agent`);
  }
  // These mixed stock into flow and produced the impossible arithmetic.
  for (const gone of ['prospect_supply', 'contactable', 'qualified', 'sequenced']) {
    assert.ok(!STAGES.includes(gone), `${gone} is stock, not same-day flow`);
  }
});
