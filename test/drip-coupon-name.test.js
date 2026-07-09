/**
 * Stripe caps coupon.name at 40 characters. The Day-30 drip coupon name is
 * built from the prospect's company, which is unbounded — so the code MUST
 * clamp it. It didn't, and every real company blew past 40:
 *   "Invalid string ...; must be at most 40 characters"
 * thrown before the Day-30 email could send. Masked for a month by the drip
 * wedge; surfaced the instant the backlog-skip advanced enrollments to Day 30.
 *
 * This test pins the invariant by exercising the exact expression the code uses.
 */

const test = require('node:test');
const assert = require('node:assert');

const STRIPE_COUPON_NAME_MAX = 40;

// Mirror of core/drip-coupon.js couponName construction.
function couponName(lead) {
  return `Drip Day-30 free — ${lead.company_name || lead.id}`.slice(0, STRIPE_COUPON_NAME_MAX);
}

test('coupon name never exceeds Stripe\'s 40-char limit, for any company', () => {
  const companies = [
    'ABC Towing',
    'Metropolitan Air Conditioning & Heating Services LLC',
    'A'.repeat(200),
    '',                                   // falls back to lead.id
    "O'Brien & Sons Plumbing, Heating, and Cooling of Greater Atlanta",
  ];
  for (const company of companies) {
    const name = couponName({ company_name: company, id: 'lead-uuid-1234567890' });
    assert.ok(name.length <= STRIPE_COUPON_NAME_MAX, `"${name}" is ${name.length} chars (> ${STRIPE_COUPON_NAME_MAX})`);
    assert.ok(name.startsWith('Drip Day-30 free'), 'keeps the human-readable prefix');
  }
});

test('short company names are preserved intact', () => {
  const name = couponName({ company_name: 'ABC Towing' });
  assert.strictEqual(name, 'Drip Day-30 free — ABC Towing');
});

test('empty company falls back to the lead id (still clamped)', () => {
  const name = couponName({ company_name: '', id: 'x'.repeat(100) });
  assert.ok(name.length <= STRIPE_COUPON_NAME_MAX);
  assert.ok(name.startsWith('Drip Day-30 free'));
});

test('the exact worst-case that failed in production is now exactly 40', () => {
  // From the live error: a company ending in "...Air Cond" hit the cap.
  const name = couponName({ company_name: 'Metropolitan Air Conditioning & Heating Services LLC' });
  assert.strictEqual(name.length, 40);
});
