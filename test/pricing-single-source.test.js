/**
 * Pricing has exactly one source of truth: the `pricing` block in
 * core/fga-knowledge.js (plus the live Stripe price IDs in env).
 *
 * Why this guard exists (2026-07-10 audit): three generations of pricing
 * coexisted in the codebase. integrations/stripe.js still carried a $2,000
 * setup-fee fallback from Gen-1, and core/onboarding.js rendered $299/$499
 * (Gen-2) into customer-facing onboarding email variables — meaning a
 * customer could be shown or even charged numbers from a retired price list.
 * Both now read FGA_KNOWLEDGE.pricing; the stale sync scripts are archived
 * under scripts/archived/*.disabled.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('stripe.js has no hardcoded setup fee and reads the knowledge base', () => {
  const src = read('integrations/stripe.js');
  assert.match(src, /FGA_KNOWLEDGE\.pricing\.setup_fee/, 'setup fee must come from core/fga-knowledge.js');
  for (const stale of ['200000', "'$2,000'", '$2,000', 'amount: 2000,']) {
    assert.ok(!src.includes(stale), `stale Gen-1 figure "${stale}" found in integrations/stripe.js`);
  }
});

test('onboarding.js email vars have no hardcoded tier prices', () => {
  const src = read('core/onboarding.js');
  assert.match(src, /FGA_KNOWLEDGE\.pricing\.(growth|scale)_tier/, 'tier prices must come from core/fga-knowledge.js');
  for (const stale of ["'499'", "'299'", '$499', '$299']) {
    assert.ok(!src.includes(stale), `stale Gen-2 figure "${stale}" found in core/onboarding.js`);
  }
});

test('the knowledge base pricing block is coherent', () => {
  const { FGA_KNOWLEDGE } = require('../core/fga-knowledge');
  const p = FGA_KNOWLEDGE.pricing;
  assert.ok(Number.isInteger(p.setup_fee.amount) && p.setup_fee.amount > 0);
  assert.ok(Number.isInteger(p.growth_tier.amount) && Number.isInteger(p.scale_tier.amount));
  assert.ok(p.scale_tier.amount > p.growth_tier.amount, 'Scale must cost more than Growth');
});

test('no retired pricing generation figures resurface in live code', () => {
  // Gen-1: $497/$997 + $2,000 setup. Gen-2: $299/$499 + $1,000 setup.
  // Scan the directories where a stale figure could reach a customer.
  const SCAN_DIRS = ['core', 'worker', 'api', 'integrations'];
  const STALE = [/\$497\b/, /\$997\b/, /\$2,000\b/, /\bamount:\s*200000\b/, /\btierPrice\s*=\s*.*'499'/];
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', 'archived'].includes(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.js')) {
        const src = fs.readFileSync(full, 'utf8');
        for (const re of STALE) {
          if (re.test(src)) offenders.push(`${path.relative(ROOT, full)} — ${re}`);
        }
      }
    }
  };
  for (const d of SCAN_DIRS) walk(path.join(ROOT, d));
  assert.deepStrictEqual(offenders, [], `Retired pricing found:\n  ${offenders.join('\n  ')}`);
});
