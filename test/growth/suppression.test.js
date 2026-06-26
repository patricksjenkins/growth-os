'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { makeDb, hasEq } = require('./_stub');
const S = require('../../core/growth/suppression');

test('normalization', () => {
  assert.strictEqual(S.normalizeEmail('  A@B.COM '), 'a@b.com');
  assert.strictEqual(S.normalizeEmail('not-an-email'), null);
  assert.strictEqual(S.normalizePhone('(555) 123-4567'), '5551234567');
  assert.strictEqual(S.normalizePhone('+1 555 123 4567'), '5551234567');
  assert.strictEqual(S.normalizePhone('12345'), null);
  assert.strictEqual(S.normalizeDomain('https://www.Acme.com/contact'), 'acme.com');
});

test('findDuplicate — domain precedence', async () => {
  const db = makeDb((ops) => {
    if (ops.table === 'leads' && hasEq(ops, 'domain', 'acme.com')) return [{ id: 'L1', company_name: 'Acme' }];
    return [];
  });
  const hit = await S.findDuplicate(db, 'T1', { website: 'https://acme.com', company: 'Acme', phone: '5551234567' });
  assert.ok(hit && hit.matched_on === 'domain' && hit.id === 'L1');
});

test('findDuplicate — phone when no domain match', async () => {
  const db = makeDb((ops) => {
    if (ops.table === 'leads' && ops.filters.some((f) => f[0] === 'ilike')) return [{ id: 'L2', phone: '555-123-4567' }];
    return [];
  });
  const hit = await S.findDuplicate(db, 'T1', { company: 'NoSite Co', phone: '(555) 123-4567' });
  assert.ok(hit && hit.matched_on === 'phone' && hit.id === 'L2');
});

test('findDuplicate — company fallback, else null', async () => {
  const db = makeDb((ops) => {
    if (ops.table === 'leads' && hasEq(ops, 'company_name', 'Onlyname LLC')) return [{ id: 'L3' }];
    return [];
  });
  assert.strictEqual((await S.findDuplicate(db, 'T1', { company: 'Onlyname LLC' })).matched_on, 'company_name');
  const none = await S.findDuplicate(makeDb(() => []), 'T1', { company: 'Ghost' });
  assert.strictEqual(none, null);
});

test('isSuppressed — unions central, drip, customers', async () => {
  // central lead_suppressions hit
  let db = makeDb((ops) => (ops.table === 'lead_suppressions' ? [{ reason: 'competitor', channel: 'all', source: 'owner_ui' }] : []));
  let r = await S.isSuppressed(db, 'T1', { email: 'x@y.com' });
  assert.ok(r.suppressed && r.reason === 'competitor');

  // drip_suppressions hit (central empty)
  db = makeDb((ops) => (ops.table === 'drip_suppressions' ? [{ reason: 'bounce' }] : []));
  r = await S.isSuppressed(db, 'T1', { email: 'x@y.com', channel: 'email' });
  assert.ok(r.suppressed && r.source === 'drip_suppressions');

  // customers do_not_contact flag
  db = makeDb((ops) => (ops.table === 'customers' ? [{ do_not_contact: true }] : []));
  r = await S.isSuppressed(db, 'T1', { email: 'x@y.com' });
  assert.ok(r.suppressed && r.reason === 'do_not_contact');

  // nothing
  r = await S.isSuppressed(makeDb(() => []), 'T1', { email: 'x@y.com', phone: '5551234567' });
  assert.strictEqual(r.suppressed, false);
});

test('hasActiveEnrollment — drip enrollment blocks', async () => {
  const db = makeDb((ops) => (ops.table === 'drip_enrollments' ? [{ id: 'E1', status: 'active' }] : []));
  const r = await S.hasActiveEnrollment(db, 'T1', 'L1');
  assert.ok(r.enrolled && r.source === 'drip_enrollments');
  assert.strictEqual((await S.hasActiveEnrollment(makeDb(() => []), 'T1', 'L1')).enrolled, false);
});

test('canEnroll — terminal status / suppressed / clean', async () => {
  const clean = makeDb(() => []);
  assert.strictEqual((await S.canEnroll(clean, 'T1', { id: 'L1', status: 'won' })).ok, false);
  assert.strictEqual((await S.canEnroll(clean, 'T1', { id: 'L1', status: 'new_lead', email: 'a@b.com' })).ok, true);
  const supp = makeDb((ops) => (ops.table === 'lead_suppressions' ? [{ reason: 'do_not_contact', channel: 'all' }] : []));
  assert.strictEqual((await S.canEnroll(supp, 'T1', { id: 'L1', status: 'new_lead', email: 'a@b.com' })).ok, false);
});
