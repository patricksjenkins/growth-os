/**
 * Growth OS — per-request Supabase client built from the caller's user JWT.
 *
 * WHY THIS EXISTS
 *   Every route in api/routes/ currently calls `getServiceClient()` which
 *   uses the SUPABASE_SERVICE_KEY (a.k.a. service-role key). The service
 *   role bypasses RLS by Supabase's design — fine for admin and worker
 *   paths that intentionally cross tenants, dangerous for tenant-scoped
 *   paths that must NEVER cross tenants.
 *
 *   This helper creates an alternative Supabase client per request, using
 *   the bearer JWT from the incoming request as the auth context. When
 *   that client queries any table that has an RLS policy keyed on
 *   `auth.jwt() ->> 'tenant_id'` (see db/migrations/035_rls_jwt_policies.sql),
 *   the database itself filters out rows from other tenants. The
 *   application code can still add `eq('tenant_id', req.tenantId)` as a
 *   second defense — but even if it forgets, RLS blocks the leak.
 *
 * WHEN TO USE WHICH CLIENT
 *   - getServiceClient()  -> for /api/admin/* routes that read across
 *                            tenants by design, and for worker agents
 *                            that operate platform-wide.
 *   - getUserClient(req)  -> for /api/tenant/* routes and any route
 *                            that should be scoped to the calling
 *                            tenant. Returns the user-JWT client.
 *
 * STATUS
 *   Drafted 2026-05-26. NOT yet imported by any route. Phase C3 of the
 *   tenant-isolation rollout will switch /api/tenant/* and /api/finance/*
 *   routes from getServiceClient() to getUserClient(req), one route at a
 *   time, with manual verification between each switch. Until that
 *   switch, this file is dead code and has no effect.
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

/**
 * Pulls the bearer token out of an Express `req`. Express does the
 * lowercasing for us, but we still defend against an array (Node's
 * normalisation when the header repeats).
 */
function extractBearerToken(req) {
  const h = req && req.headers && req.headers.authorization;
  if (!h) return null;
  const value = Array.isArray(h) ? h[0] : h;
  if (typeof value !== 'string') return null;
  const m = value.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

/**
 * Build a Supabase client bound to the calling user's JWT.
 *
 * The returned client speaks to Supabase as the authenticated user, so
 * RLS policies (in particular the ones added by migration 035) fire on
 * every query. If the user has no `tenant_id` claim in their JWT, the
 * client effectively sees zero rows from any tenant-scoped table — a
 * fail-closed default.
 *
 * Throws if the env vars are missing OR if the request has no bearer
 * token (which would mean the auth middleware let an unauthenticated
 * request through to a tenant-scoped route — that's a bug worth
 * surfacing loudly).
 */
function getUserClient(req) {
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      'getUserClient(): SUPABASE_URL and SUPABASE_ANON_KEY must be set in env'
    );
  }
  const token = extractBearerToken(req);
  if (!token) {
    throw new Error(
      'getUserClient(): no bearer token on request. ' +
      'This route is tenant-scoped and must be called by an authenticated user.'
    );
  }
  // The anon key is what we sign queries with; the bearer token tells
  // Supabase WHICH user (and therefore which tenant) the call is for.
  // RLS policies in migration 035 use auth.jwt() to read tenant_id off
  // that bearer token.
  return createClient(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: { Authorization: `Bearer ${token}` },
    },
    auth: {
      // We never want this client to refresh tokens or persist sessions —
      // it's a one-shot client scoped to a single API request.
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

module.exports = {
  getUserClient,
  extractBearerToken,
};
