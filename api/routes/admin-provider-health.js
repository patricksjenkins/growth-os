/**
 * Provider identity & health — "what is production ACTUALLY connected to?"
 *
 * Why this exists (2026-07-26): for months growth-os was connected to a Stripe
 * SANDBOX account ("First Gen Automate sandbox", acct_1TMHfjR5THVxupCn) while
 * every real customer paid the LIVE account (acct_1TMHfbJIrkogakNB). The two
 * ids differ by one character. The webhook worked perfectly — it faithfully
 * processed a fake company's test subscriptions and filed real alerts about
 * them, while $775+ of genuine revenue never reached the books at all.
 *
 * Nothing in the system could answer "which account am I talking to?", so
 * nobody could see it. This endpoint answers exactly that, from the deployed
 * process, using the credentials production is really holding.
 *
 * Read-only. Never returns a key or any secret — only the identity a key
 * resolves to, and whether that identity looks like production.
 */

const express = require('express');
const router = express.Router();
const { getServiceClient } = require('../../db/client');
const { FGA_TENANT_ID } = require('../../core/config');
const { createLogger } = require('../../core/logger');

const log = createLogger('admin-provider-health');

/** Live business account. A sandbox/test identity here is a P0. */
const EXPECTED_STRIPE_ACCOUNT = process.env.STRIPE_EXPECTED_ACCOUNT_ID || 'acct_1TMHfbJIrkogakNB';

async function stripeIdentity() {
  const key = process.env.STRIPE_SECRET_KEY || '';
  if (!key) return { ok: false, status: 'missing', detail: 'STRIPE_SECRET_KEY is not set' };
  const mode = key.startsWith('sk_live') ? 'live' : key.startsWith('sk_test') ? 'test' : 'unknown';
  try {
    const res = await fetch('https://api.stripe.com/v1/account', {
      headers: { Authorization: `Bearer ${key}` },
    });
    const acct = await res.json();
    if (acct.error) {
      return { ok: false, status: 'auth_failed', key_mode: mode, detail: acct.error.message };
    }
    const name = acct.settings?.dashboard?.display_name || acct.business_profile?.name || null;
    // Two independent signals, because either alone can mislead: a test key is
    // always wrong in production, and a live-shaped key pointed at the wrong
    // account is just as wrong.
    const looksSandbox = mode === 'test' || /sandbox|test/i.test(name || '');
    const rightAccount = acct.id === EXPECTED_STRIPE_ACCOUNT;
    return {
      ok: rightAccount && !looksSandbox,
      status: rightAccount && !looksSandbox ? 'live' : looksSandbox ? 'SANDBOX' : 'WRONG_ACCOUNT',
      account_id: acct.id,
      expected_account_id: EXPECTED_STRIPE_ACCOUNT,
      display_name: name,
      key_mode: mode,
      charges_enabled: acct.charges_enabled === true,
      detail: rightAccount && !looksSandbox
        ? 'Connected to the live business account.'
        : looksSandbox
          ? `Connected to a SANDBOX/TEST identity (${name || acct.id}). Real payments cannot reach the books.`
          : `Connected to ${acct.id}, expected ${EXPECTED_STRIPE_ACCOUNT}.`,
    };
  } catch (err) {
    return { ok: false, status: 'unreachable', key_mode: mode, detail: err.message };
  }
}

/**
 * Has the webhook ever actually booked money? A configured endpoint proves
 * nothing; a finance_entries row carrying a Stripe provider id proves the
 * whole path works. Zero of these was the tell nobody was reading.
 */
async function webhookEvidence(db) {
  const { data, error } = await db.from('finance_entries')
    .select('date, amount, description, metadata, created_at')
    .eq('tenant_id', FGA_TENANT_ID).eq('entry_type', 'income')
    .order('created_at', { ascending: false }).limit(50);
  if (error) return { ok: false, detail: error.message };
  const webhookBooked = (data || []).filter((r) => {
    const m = r.metadata || {};
    return m.stripe_invoice_id || m.stripe_charge_id || m.source === 'stripe_webhook';
  });
  const last = webhookBooked[0];
  return {
    ok: webhookBooked.length > 0,
    income_rows_total: (data || []).length,
    webhook_booked_rows: webhookBooked.length,
    last_webhook_booking: last ? { date: last.date, amount: last.amount } : null,
    detail: webhookBooked.length
      ? `${webhookBooked.length} income row(s) carry a Stripe provider id.`
      : 'NO income row has ever been created by the Stripe webhook. Every dollar on the books was hand-entered or bank-derived.',
  };
}

/** Every paying tenant should be linked to a provider customer. */
async function linkageGaps(db) {
  const { data: tenants } = await db.from('tenants').select('id, name, status');
  const gaps = [];
  for (const t of tenants || []) {
    const { data: rows } = await db.from('tenant_config').select('key, value').eq('tenant_id', t.id);
    const cfg = {};
    for (const r of rows || []) cfg[r.key] = String(r.value).replace(/^"|"$/g, '');
    const rate = Number(cfg.monthly_rate || cfg.plan_rate || 0);
    if (rate > 0 && String(cfg.is_complimentary) !== 'true' && !cfg.stripe_customer_id) {
      gaps.push({ tenant: t.name, monthly_rate: rate, detail: 'billed but no stripe_customer_id — payments cannot be matched' });
    }
  }
  return { ok: gaps.length === 0, gaps };
}

// GET /api/admin/provider-health
router.get('/', async (req, res) => {
  try {
    const db = getServiceClient();
    const [stripe, webhook, linkage] = await Promise.all([
      stripeIdentity(),
      webhookEvidence(db),
      linkageGaps(db),
    ]);
    const problems = [
      !stripe.ok ? `Stripe: ${stripe.detail}` : null,
      !webhook.ok ? `Webhook: ${webhook.detail}` : null,
      !linkage.ok ? `Linkage: ${linkage.gaps.length} billed tenant(s) unlinked` : null,
    ].filter(Boolean);
    res.json({
      success: true,
      generated_at: new Date().toISOString(),
      // The books are only trustworthy when the provider identity is right AND
      // money has demonstrably flowed through it.
      books_authoritative: stripe.ok && webhook.ok && linkage.ok,
      problems,
      stripe,
      webhook,
      linkage,
    });
  } catch (err) {
    log.error(`provider-health failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
