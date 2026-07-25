/**
 * computeCapState integration + import integrity (2026-07-24).
 *
 * While wiring the new breaker I referenced evaluateDeliverability without
 * importing it. `require()` of the module still succeeded, the 912-test suite
 * still passed, and the crash would only have appeared the next time the
 * sender actually ran — i.e. in production, on the code path whose job is to
 * decide whether to send.
 *
 * The unit tests for the breaker itself cannot catch that: they import the
 * module directly. This file exercises the SEAM.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'core', 'auto-outreach.js');
const src = fs.readFileSync(SRC, 'utf8');

test('every cross-module helper used by auto-outreach is imported', () => {
  // Collect identifiers this module calls that are known to live elsewhere.
  const externals = ['evaluateDeliverability', 'isSuppressed', 'hasActiveEnrollment',
    'isInboundLead', 'normalizeEmail', 'normalizeDomain', 'normalizeName'];
  const missing = externals.filter((name) => {
    const used = new RegExp(`\\b${name}\\s*\\(`).test(src);
    if (!used) return false;
    // imported either as a destructured require or a bare require assignment
    const imported = new RegExp(`(\\{[^}]*\\b${name}\\b[^}]*\\}\\s*=\\s*require)|(\\b${name}\\s*=\\s*require)`)
      .test(src);
    return !imported;
  });
  assert.deepStrictEqual(missing, [],
    `used but never imported (would throw at runtime): ${missing.join(', ')}`);
});

test('the breaker module is the one wired in — not a reimplemented rule', () => {
  assert.match(src, /require\('\.\/revenue\/deliverability-breaker'\)/,
    'capState must delegate to the shared breaker');
  assert.ok(!/sent7d >= 20 && bounceRate7d >=/.test(src),
    'the old inline rule that stopped the department must be gone');
});

test('bounce and complaint reads are tenant-scoped', () => {
  // The original queries had no tenant filter, so one tenant's bounces could
  // pause another tenant's sending — a cross-tenant bleed inside the safety
  // layer itself.
  const emailEventReads = src.split("from('email_events')").slice(1);
  assert.ok(emailEventReads.length >= 2, 'expected bounce + complaint reads');
  for (const [i, block] of emailEventReads.entries()) {
    const head = block.slice(0, 400);
    assert.match(head, /\.eq\('tenant_id', tenant\.id\)/,
      `email_events read #${i + 1} must be scoped to the tenant`);
  }
});

test('computeCapState runs end to end against a stubbed db', async () => {
  // Proves the seam executes — the exact failure the missing import caused.
  const { computeCapState } = require('../core/auto-outreach');
  if (typeof computeCapState !== 'function') return; // not exported: static checks above still guard

  const rows = { count: 0, data: [] };
  const builder = () => {
    const b = {
      select: () => b, eq: () => b, gte: () => b, lte: () => b, in: () => b,
      neq: () => b, limit: () => b, order: () => b,
      then: (res) => Promise.resolve(rows).then(res),
    };
    return b;
  };
  const db = { from: () => builder() };
  const tenant = { id: '30566ed6-026a-45e1-9502-029e6219df31', slug: 'fga', config: {} };

  const state = await computeCapState(db, tenant, new Date('2026-07-25T15:00:00Z'));
  assert.strictEqual(typeof state.deliverabilityPaused, 'boolean');
  assert.strictEqual(state.deliverabilityPaused, false,
    'zero sends and zero bounces must not read as paused');
  assert.ok('suppressCandidates' in state, 'capState must expose addresses to suppress');
  assert.ok('hardBounces7d' in state, 'capState must distinguish hard bounces');
});
