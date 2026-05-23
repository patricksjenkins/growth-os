/**
 * Growth OS — CPA Read-Only API
 *
 * Stretch Enhancement #12 of the BI & Financial Sync plan
 * (~/Desktop/FGA/dashboards/bi-sync-strategy.html §8 Tier C).
 *
 * Endpoints exposed under /api/cpa/* that authenticate via the
 * `X-FGA-CPA-Token` header (NOT Supabase JWT). Read-only — exclusively
 * the year-end report bundle + audit log for the scoped tax year.
 *
 * The CPA's accounting tool calls these endpoints directly to pull
 * transaction data — eliminating the email-ZIP-import dance.
 *
 * Auth flow:
 *   1. Patrick issues a token via POST /api/finance/cpa-tokens (Supabase JWT)
 *   2. CPA's tool stores the token securely + includes it on every request
 *   3. Each request is hashed, looked up, validated (not revoked, not expired)
 *   4. The token's scoped tax_year limits which records are returned
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { db } = require('../../db/client');
const { createLogger } = require('../../core/logger');
const log = createLogger('cpa-readonly');

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

/**
 * Middleware that validates the X-FGA-CPA-Token header.
 * On success, sets req.cpaToken = { id, tenant_id, tax_year, label, ... }.
 */
async function cpaTokenMiddleware(req, res, next) {
  const cleartext = req.headers['x-fga-cpa-token'] || req.query.token;
  if (!cleartext || typeof cleartext !== 'string' || cleartext.length !== 64) {
    return res.status(401).json({ success: false, error: 'Missing or malformed X-FGA-CPA-Token header.' });
  }

  const tokenHash = sha256(cleartext);
  const { data, error } = await db
    .from('cpa_api_tokens')
    .select('id, tenant_id, tax_year, label, expires_at, revoked_at')
    .eq('token_hash', tokenHash)
    .maybeSingle();

  if (error || !data) {
    return res.status(401).json({ success: false, error: 'Invalid token.' });
  }
  if (data.revoked_at) {
    return res.status(401).json({ success: false, error: 'Token has been revoked.' });
  }
  if (new Date(data.expires_at).getTime() < Date.now()) {
    return res.status(401).json({ success: false, error: `Token expired ${data.expires_at}.` });
  }

  // Record usage (fire-and-forget — don't block)
  db.from('cpa_api_tokens')
    .update({ last_used_at: new Date().toISOString(), use_count: db.raw ? db.raw('use_count + 1') : undefined })
    .eq('id', data.id)
    .then(() => {})
    .catch(() => {});

  // Supabase doesn't support db.raw — use a manual increment via select then update
  db.from('cpa_api_tokens').select('use_count').eq('id', data.id).maybeSingle().then(({ data: row }) => {
    if (row) {
      db.from('cpa_api_tokens').update({
        last_used_at: new Date().toISOString(),
        use_count: (row.use_count || 0) + 1,
      }).eq('id', data.id).then(() => {});
    }
  });

  req.cpaToken = data;
  req.tenantId = data.tenant_id;  // mirror tenantMiddleware shape so downstream queries work
  next();
}

router.use(cpaTokenMiddleware);

// Helper: enforce the token's tax_year, regardless of any year query param
function scopedYear(req) { return req.cpaToken.tax_year; }

// ============================================================================
// GET /api/cpa/manifest
// Index page describing what's available. CPA's tool can introspect.
// ============================================================================
router.get('/manifest', (req, res) => {
  const year = scopedYear(req);
  res.json({
    success: true,
    tenant_id: req.cpaToken.tenant_id,
    tax_year: year,
    label: req.cpaToken.label,
    expires_at: req.cpaToken.expires_at,
    endpoints: [
      { path: `/api/cpa/transactions?year=${year}`, format: 'CSV',  desc: 'Full transaction list with Schedule C mapping' },
      { path: `/api/cpa/year-end-report?year=${year}`, format: 'HTML', desc: 'Printable P&L statement' },
      { path: `/api/cpa/qbo-export?year=${year}`, format: 'IIF', desc: 'QuickBooks Online import file' },
      { path: `/api/cpa/1099-nec?year=${year}`, format: 'HTML', desc: '1099-NEC worksheet' },
      { path: `/api/cpa/audit-log`, format: 'JSON', desc: 'Full audit-log JSON of every change' },
    ],
  });
});

// ============================================================================
// Thin proxy endpoints — delegate to the existing /api/finance/* handlers.
// This avoids duplicating the report rendering logic.
// ============================================================================
const finance = require('./finance');

// Re-route each CPA-facing path to the finance route's handler. We mutate
// the URL so the existing route matcher in finance.js resolves correctly.
function proxyToFinance(targetPath) {
  return (req, res, next) => {
    req.url = targetPath.replace(':year', String(scopedYear(req)));
    finance.handle(req, res, next);
  };
}

router.get('/transactions',     proxyToFinance('/report/year-end.csv?year=:year'));
router.get('/year-end-report',  proxyToFinance('/report/year-end.html?year=:year'));
router.get('/qbo-export',       proxyToFinance('/report/qbo-export.iif?year=:year'));
router.get('/1099-nec',         proxyToFinance('/report/1099-nec.html?year=:year'));
router.get('/audit-log',        proxyToFinance('/audit-log'));

module.exports = router;
