/**
 * Growth OS Database Client
 * Supabase client factory with tenant-aware support
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

// Service role client (bypasses RLS — used by worker and admin)
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

let serviceClient = null;
if (supabaseUrl && supabaseKey) {
  serviceClient = createClient(supabaseUrl, supabaseKey);
}

// Anon client (respects RLS — used by API after setting tenant context)
let anonClient = null;
function getAnonClient() {
  if (!anonClient) {
    anonClient = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY
    );
  }
  return anonClient;
}

/**
 * Get the service-role client (bypasses RLS)
 * Used by: worker agents, seed scripts, admin operations
 */
function getServiceClient() {
  if (!serviceClient) {
    throw new Error('Supabase not configured. Set SUPABASE_URL and SUPABASE_SERVICE_KEY in .env');
  }
  return serviceClient;
}

/**
 * Set tenant context for RLS-filtered queries
 * Call this in API middleware before any tenant-scoped queries
 */
async function setTenantContext(tenantId) {
  const { error } = await serviceClient.rpc('set_tenant_context', {
    tid: tenantId
  });
  if (error) {
    console.error('Failed to set tenant context:', error.message);
  }
}

/**
 * PostgREST's server-side row ceiling.
 *
 * The API caps every response at this many rows regardless of the `.limit()`
 * we ask for, and it does so SILENTLY — no error, no flag, just fewer rows.
 * `.limit(5000)` on a 1468-row query looks like it worked and returns 1000.
 */
const PAGE_SIZE = 1000;

/**
 * Read every row a query matches, not just the first page.
 *
 * WHY THIS EXISTS (2026-08-10)
 * The Operations Guardian asked agent_jobs for an 8-day window with
 * `.limit(5000)`. FGA had 1468 rows in that window, so it received the newest
 * 1000 — about 5.5 days — and never saw the rest. bookkeeping and
 * clients-manager run WEEKLY, so their last success sat 7 days back, outside
 * the slice that came through. With no success row visible the guardian
 * computed `lastOk = 0` and reported "has not succeeded in 496210h" — 56
 * years, the age of the unix epoch — then paged Patrick at 6am, twice, about
 * two agents that had a 100% success rate.
 *
 * The truncation point MOVES with volume: as agent traffic grows, 1000 rows
 * covers fewer days, so this gets worse on its own and takes out
 * progressively more frequent agents. A monitor whose blind spot expands as
 * the system gets busier is worse than no monitor.
 *
 * @param {function(number, number): object} page  (from, to) → a Supabase
 *   builder for that slice. Called once per page; it must apply the same
 *   filters and a STABLE order every time, or pages will overlap or skip.
 * @param {{cap?: number}} [opts] hard ceiling on total rows, to bound memory
 *   on a runaway query. Reaching it is logged, never silent.
 * @returns {Promise<{data: Array, error: object|null, truncated: boolean}>}
 */
async function fetchAllRows(page, opts = {}) {
  const cap = opts.cap || 100000;
  const out = [];
  for (let from = 0; from < cap; from += PAGE_SIZE) {
    const to = Math.min(from + PAGE_SIZE, cap) - 1;
    const { data, error } = await page(from, to);
    if (error) return { data: out, error, truncated: false };
    const rows = data || [];
    out.push(...rows);
    // A short page means the server had nothing more to give.
    if (rows.length < to - from + 1) return { data: out, error: null, truncated: false };
  }
  // Hit the cap with rows still available. Say so out loud — a silent cap is
  // the exact failure this function exists to end.
  console.warn(`[db] fetchAllRows stopped at the ${cap}-row cap; results are incomplete`);
  return { data: out, error: null, truncated: true };
}

module.exports = {
  db: serviceClient,
  getServiceClient,
  getAnonClient,
  setTenantContext,
  fetchAllRows,
  PAGE_SIZE,
};
