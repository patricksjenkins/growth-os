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

module.exports = {
  db: serviceClient,
  getServiceClient,
  getAnonClient,
  setTenantContext
};
