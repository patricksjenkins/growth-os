/**
 * Growth OS — Mercury Bank API Integration
 *
 * Phase 4 of the BI & Financial Sync plan
 * (~/Desktop/FGA/dashboards/bi-sync-strategy.html §3 Phase 4).
 *
 * Read-only integration that pulls daily account balance + transactions
 * for FGA's own books. Used by:
 *   - worker/agents/mercury-sync.js (nightly cron)
 *   - api/routes/metrics.js#/runway (cash_balance lookup falls through to
 *     tenant_metrics_snapshots.metadata.cash_balance which this populates)
 *
 * Mercury REST API docs: https://docs.mercury.com
 * Auth: Bearer token in Authorization header. Token issued from
 * mercury.com Settings → API tokens with Read-only permission.
 *
 * Token stored on Railway as MERCURY_API_TOKEN env var. NEVER commit.
 */

const axios = require('axios');
const { createLogger } = require('../core/logger');

const MERCURY_BASE = 'https://api.mercury.com/api/v1';

function _client() {
  const token = process.env.MERCURY_API_TOKEN;
  if (!token) {
    throw new Error('MERCURY_API_TOKEN env var not set. Configure on Railway then redeploy.');
  }
  const base = axios.create({
    baseURL: MERCURY_BASE,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
    timeout: 30_000,
  });
  // V1 hardening (2026-05-24): wrap every method through withRetry so
  // Mercury's occasional 429/503 (their docs warn about rate limits during
  // end-of-month statement generation) doesn't kill the sync job.
  const { withRetry } = require('./_retry');
  const retryOpts = {
    attempts: 3,
    onRetry: (err, attempt, delayMs) =>
      console.warn(`[mercury] retry ${attempt} in ${delayMs}ms: ${err.message}`),
  };
  return {
    get:  (url, cfg) => withRetry(() => base.get(url, cfg), retryOpts),
    post: (url, body, cfg) => withRetry(() => base.post(url, body, cfg), retryOpts),
    put:  (url, body, cfg) => withRetry(() => base.put(url, body, cfg), retryOpts),
  };
}

function isMercuryConfigured() {
  return Boolean(process.env.MERCURY_API_TOKEN);
}

/**
 * Fetch all Mercury accounts (Checking, Savings, Treasury, etc.) with
 * current balances. Returns the raw account list — caller decides how
 * to aggregate.
 *
 * Example response shape per account:
 *   { id, name, accountNumber, routingNumber, status, type,
 *     availableBalance, currentBalance, kind, createdAt }
 */
async function listAccounts() {
  const log = createLogger('mercury');
  try {
    const res = await _client().get('/accounts');
    const accounts = Array.isArray(res.data?.accounts) ? res.data.accounts : (res.data || []);
    log.info(`Fetched ${accounts.length} Mercury account(s)`);
    return accounts;
  } catch (err) {
    log.error(`listAccounts failed: ${err.response?.status || err.message}`);
    throw err;
  }
}

/**
 * Sum available balance across all non-closed accounts. Returns USD
 * decimal. Used to populate cash_balance in the runway snapshot.
 */
async function getTotalAvailableBalance() {
  const accounts = await listAccounts();
  let total = 0;
  for (const a of accounts) {
    if (a.status === 'closed' || a.status === 'archived') continue;
    total += Number(a.availableBalance) || 0;
  }
  return Number(total.toFixed(2));
}

/**
 * Fetch transactions for an account since a given ISO date.
 * Mercury paginates via offset + limit query params; we walk pages
 * up to a hard cap to prevent runaway calls.
 *
 * Example transaction shape:
 *   { id, amount, postedAt, createdAt, status, counterpartyName,
 *     counterpartyId, kind, note, externalMemo, category }
 */
async function getTransactionsSince(accountId, sinceIso) {
  const log = createLogger('mercury');
  const PAGE_SIZE = 100;
  const MAX_PAGES = 20;  // hard cap → 2000 txns/account/sync
  const out = [];

  for (let offset = 0; offset < PAGE_SIZE * MAX_PAGES; offset += PAGE_SIZE) {
    const res = await _client().get(`/account/${accountId}/transactions`, {
      params: { limit: PAGE_SIZE, offset, start: sinceIso },
    });
    const batch = Array.isArray(res.data?.transactions) ? res.data.transactions : (res.data || []);
    out.push(...batch);
    if (batch.length < PAGE_SIZE) break;  // last page
  }

  log.info(`Fetched ${out.length} Mercury transactions for account ${accountId} since ${sinceIso}`);
  return out;
}

/**
 * Convenience: pull transactions across ALL accounts since a date.
 */
async function getAllTransactionsSince(sinceIso) {
  const accounts = await listAccounts();
  const all = [];
  for (const a of accounts) {
    if (a.status === 'closed' || a.status === 'archived') continue;
    const txns = await getTransactionsSince(a.id, sinceIso);
    // Tag each with the source account so we can reconcile against the right bucket
    for (const t of txns) {
      all.push({ ...t, _account_id: a.id, _account_name: a.name });
    }
  }
  return all;
}

module.exports = {
  isMercuryConfigured,
  listAccounts,
  getTotalAvailableBalance,
  getTransactionsSince,
  getAllTransactionsSince,
};
