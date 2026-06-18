/**
 * integrations/supabase-923a.js — cross-project client for 923A's FRONT-DOOR Supabase.
 *
 * 923A Coins runs as its own Vercel site backed by a SEPARATE Supabase project from
 * the growth-os platform DB. The commercial-discovery worker (which lives here in
 * growth-os, reusing Serper/Apify/callClaude + AI-safety) writes the opportunities,
 * sources, run audit, and budget it discovers INTO that 923A project so the 923A
 * Command Center reads them natively.
 *
 * Credentials (set in growth-os Railway env — server-side only, never client):
 *   SUPABASE_923A_URL                — 923A front-door project URL
 *   SUPABASE_923A_SERVICE_ROLE_KEY   — 923A service-role key (bypasses RLS)
 *   SUPABASE_923A_TENANT_ID          — optional; defaults to the known 923A tenant id
 *
 * If the env isn't set, isConfigured() returns false and the agent stays idle —
 * it never throws into the scheduler. Tables live in the 923A project
 * (supabase/commercial_opportunities.sql + supabase/commercial_discovery.sql).
 */

const { createClient } = require('@supabase/supabase-js');

const URL = process.env.SUPABASE_923A_URL;
const KEY = process.env.SUPABASE_923A_SERVICE_ROLE_KEY;
const TENANT = process.env.SUPABASE_923A_TENANT_ID || 'bd2deab7-c870-4565-bf8d-93d6511f2d09';

let _client = null;
function isConfigured() { return !!(URL && KEY); }
function client() {
  if (!isConfigured()) throw new Error('923A Supabase not configured (set SUPABASE_923A_URL + SUPABASE_923A_SERVICE_ROLE_KEY)');
  if (!_client) _client = createClient(URL, KEY, { auth: { persistSession: false } });
  return _client;
}
function tenantId() { return TENANT; }

// ---- Opportunities ----------------------------------------------------------
async function findByDedupe(key) {
  if (!key) return null;
  const { data, error } = await client().from('commercial_opportunities')
    .select('*').eq('tenant_id', TENANT).eq('dedupe_key', key).limit(1);
  if (error) throw new Error(`923A findByDedupe: ${error.message}`);
  return (data && data[0]) || null;
}
async function findBySeries(key) {
  if (!key) return [];
  const { data, error } = await client().from('commercial_opportunities')
    .select('id,event_date,stage,series_key').eq('tenant_id', TENANT).eq('series_key', key);
  if (error) return [];
  return data || [];
}
async function insertOpportunity(row) {
  const { data, error } = await client().from('commercial_opportunities')
    .insert({ tenant_id: TENANT, ...row }).select('*').limit(1);
  if (error) throw new Error(`923A insertOpportunity: ${error.message}`);
  return (data && data[0]) || null;
}
async function updateOpportunity(id, patch) {
  const { data, error } = await client().from('commercial_opportunities')
    .update(patch).eq('tenant_id', TENANT).eq('id', id).select('*').limit(1);
  if (error) throw new Error(`923A updateOpportunity: ${error.message}`);
  return (data && data[0]) || null;
}
// Opportunities the daily monitor should refresh (active, not archived).
async function listActiveOpportunities(limit = 500) {
  const { data, error } = await client().from('commercial_opportunities')
    .select('*').eq('tenant_id', TENANT).eq('archived', false).limit(limit);
  if (error) throw new Error(`923A listActiveOpportunities: ${error.message}`);
  return data || [];
}

// ---- Sources (evidence per opportunity) ------------------------------------
async function insertSource(row) {
  const { error } = await client().from('commercial_sources').insert({ tenant_id: TENANT, ...row });
  if (error && !/relation|does not exist/i.test(error.message)) throw new Error(`923A insertSource: ${error.message}`);
}
async function sourceSeen(canonicalUrl) {
  if (!canonicalUrl) return false;
  const { data } = await client().from('commercial_sources')
    .select('id').eq('tenant_id', TENANT).eq('canonical_url', canonicalUrl).limit(1);
  return !!(data && data.length);
}

// ---- Event series ----------------------------------------------------------
async function upsertSeries(row) {
  const { data, error } = await client().from('commercial_event_series')
    .upsert({ tenant_id: TENANT, ...row }, { onConflict: 'tenant_id,series_key' })
    .select('id').limit(1);
  if (error) { if (/relation|does not exist/i.test(error.message)) return null; throw new Error(`923A upsertSeries: ${error.message}`); }
  return (data && data[0] && data[0].id) || null;
}

// ---- Discovery runs (audit) ------------------------------------------------
async function startRun(row) {
  const { data, error } = await client().from('commercial_discovery_runs')
    .insert({ tenant_id: TENANT, status: 'running', ...row }).select('id').limit(1);
  if (error) throw new Error(`923A startRun: ${error.message}`);
  return (data && data[0] && data[0].id) || null;
}
async function finishRun(id, patch) {
  if (!id) return;
  const { error } = await client().from('commercial_discovery_runs')
    .update({ completed_at: new Date().toISOString(), ...patch }).eq('tenant_id', TENANT).eq('id', id);
  if (error) throw new Error(`923A finishRun: ${error.message}`);
}
async function activeRunExists() {
  const { data } = await client().from('commercial_discovery_runs')
    .select('id,started_at').eq('tenant_id', TENANT).eq('status', 'running')
    .order('started_at', { ascending: false }).limit(1);
  // Treat a "running" row older than 30 min as stale (worker crash) — not a lock.
  if (data && data[0]) {
    const age = Date.now() - new Date(data[0].started_at).getTime();
    return age < 30 * 60000;
  }
  return false;
}
async function lastRun() {
  const { data } = await client().from('commercial_discovery_runs')
    .select('*').eq('tenant_id', TENANT).order('started_at', { ascending: false }).limit(1);
  return (data && data[0]) || null;
}

// ---- Search-query history (avoid repeats) ----------------------------------
async function recordQuery(row) {
  const { error } = await client().from('commercial_search_queries').insert({ tenant_id: TENANT, ...row });
  if (error && !/relation|does not exist/i.test(error.message)) { /* best-effort */ }
}
async function recentQueries(profile, sinceDays = 14) {
  const since = new Date(Date.now() - sinceDays * 86400000).toISOString();
  const { data } = await client().from('commercial_search_queries')
    .select('query').eq('tenant_id', TENANT).eq('profile', profile).gte('created_at', since).limit(200);
  return (data || []).map((r) => r.query);
}

// ---- Targeted-search queue --------------------------------------------------
async function claimSearchRequest() {
  // Atomically claim one queued request (oldest first).
  const { data } = await client().from('commercial_search_requests')
    .select('*').eq('tenant_id', TENANT).eq('status', 'queued')
    .neq('query', '__agent_paused__').order('created_at', { ascending: true }).limit(1);
  const req = data && data[0];
  if (!req) return null;
  const { data: claimed } = await client().from('commercial_search_requests')
    .update({ status: 'searching' }).eq('id', req.id).eq('status', 'queued').select('*').limit(1);
  return (claimed && claimed[0]) || null;
}
async function updateSearchRequest(id, patch) {
  const { error } = await client().from('commercial_search_requests').update(patch).eq('tenant_id', TENANT).eq('id', id);
  if (error) throw new Error(`923A updateSearchRequest: ${error.message}`);
}

// ---- Budget + config --------------------------------------------------------
function monthKey() { return new Date().toISOString().slice(0, 7); }
async function getConfig() {
  const { data } = await client().from('commercial_discovery_config').select('*').eq('tenant_id', TENANT).limit(1);
  const row = (data && data[0]) || {};
  return {
    enabled: row.enabled !== false,
    paused: !!row.paused,
    monthly_budget_usd: Number(row.monthly_budget_usd != null ? row.monthly_budget_usd : 15),
    warn_percent: Number(row.warn_percent || 70),
    hardstop_percent: Number(row.hardstop_percent || 100),
  };
}
async function getMonthBudget() {
  const month = monthKey();
  const { data } = await client().from('commercial_discovery_budget')
    .select('*').eq('tenant_id', TENANT).eq('month', month).limit(1);
  const row = (data && data[0]) || { month, total_cost_usd: 0, serper_calls: 0, apify_calls: 0, claude_calls: 0 };
  return row;
}
async function addSpend({ serper = 0, apify = 0, claude = 0, costUsd = 0 }) {
  const month = monthKey();
  // Read-modify-write (single worker, low contention). Upsert the month row.
  const cur = await getMonthBudget();
  const next = {
    tenant_id: TENANT, month,
    serper_calls: (cur.serper_calls || 0) + serper,
    apify_calls: (cur.apify_calls || 0) + apify,
    claude_calls: (cur.claude_calls || 0) + claude,
    total_cost_usd: Number(((cur.total_cost_usd || 0) + costUsd).toFixed(4)),
    updated_at: new Date().toISOString(),
  };
  const { error } = await client().from('commercial_discovery_budget')
    .upsert(next, { onConflict: 'tenant_id,month' });
  if (error && !/relation|does not exist/i.test(error.message)) { /* best-effort */ }
  return next;
}

// ---- Owner notification (writes a row the site surfaces) --------------------
async function notifyOwner(title, body, meta = {}) {
  // Best-effort: 923A may have a notifications table; if not, no-op.
  const { error } = await client().from('commercial_discovery_runs')
    .update({ owner_notified: true }).eq('tenant_id', TENANT).eq('id', meta.runId || '00000000-0000-0000-0000-000000000000');
  return !error;
}

module.exports = {
  isConfigured, client, tenantId, monthKey,
  findByDedupe, findBySeries, insertOpportunity, updateOpportunity, listActiveOpportunities,
  insertSource, sourceSeen, upsertSeries,
  startRun, finishRun, activeRunExists, lastRun,
  recordQuery, recentQueries,
  claimSearchRequest, updateSearchRequest,
  getConfig, getMonthBudget, addSpend, notifyOwner,
};
