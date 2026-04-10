/**
 * Growth OS — Health Check Script
 *
 * Verifies all services and integrations are working.
 * Usage: node scripts/health-check.js
 */

require('dotenv').config();
const axios = require('axios');

const API_URL = process.env.API_URL || 'http://localhost:3000';
const WORKER_URL = process.env.WORKER_URL || 'http://localhost:3001';

const checks = [];

function pass(name, detail) {
  checks.push({ name, status: 'PASS', detail });
  console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
}

function fail(name, detail) {
  checks.push({ name, status: 'FAIL', detail });
  console.error(`  ✗ ${name} — ${detail}`);
}

function skip(name, detail) {
  checks.push({ name, status: 'SKIP', detail });
  console.log(`  - ${name} — ${detail}`);
}

async function checkEnvVars() {
  console.log('\n=== Environment Variables ===');
  const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'SUPABASE_ANON_KEY'];
  const optional = ['ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'SERPER_API_KEY', 'APOLLO_API_KEY', 'HUNTER_API_KEY'];

  for (const key of required) {
    if (process.env[key]) pass(key, 'set');
    else fail(key, 'MISSING (required)');
  }

  for (const key of optional) {
    if (process.env[key]) pass(key, 'set');
    else skip(key, 'not set (optional)');
  }
}

async function checkSupabase() {
  console.log('\n=== Supabase Connection ===');
  try {
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // Check tenants table exists
    const { data: tenants, error } = await supabase.from('tenants').select('id, name, slug, status');
    if (error) {
      fail('Supabase query', error.message);
      return;
    }
    pass('Supabase connection', 'connected');
    pass('Tenants table', `${tenants.length} tenants found`);

    for (const t of tenants) {
      console.log(`    → ${t.name} (${t.slug}) — ${t.status}`);
    }

    // Check key tables exist
    const tables = ['leads', 'contacts', 'content_drafts', 'agent_jobs', 'tenant_config', 'tenant_modules'];
    for (const table of tables) {
      const { error: tErr } = await supabase.from(table).select('id').limit(1);
      if (tErr) fail(`Table: ${table}`, tErr.message);
      else pass(`Table: ${table}`, 'exists');
    }

    // Check RLS function
    const { error: rpcErr } = await supabase.rpc('set_tenant_context', { tid: '00000000-0000-0000-0000-000000000000' });
    if (rpcErr) fail('RPC: set_tenant_context', rpcErr.message);
    else pass('RPC: set_tenant_context', 'available');

  } catch (err) {
    fail('Supabase', err.message);
  }
}

async function checkService(name, url) {
  console.log(`\n=== ${name} ===`);
  try {
    const res = await axios.get(`${url}/health`, { timeout: 5000 });
    if (res.status === 200 && res.data?.status === 'ok') {
      pass(`${name} health`, `uptime: ${res.data.uptime}s`);
      if (res.data.lastPoll) pass('Job processor', `last poll: ${res.data.lastPoll}`);
      if (res.data.scheduledJobs) pass('Scheduler', `${res.data.scheduledJobs} jobs registered`);
    } else {
      fail(`${name} health`, `status: ${res.status}`);
    }
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      skip(name, `not running at ${url}`);
    } else {
      fail(name, err.message);
    }
  }
}

async function checkTenantConfig() {
  console.log('\n=== Tenant Configuration ===');
  try {
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    const { data: tenants } = await supabase.from('tenants').select('id, name, slug');
    if (!tenants || tenants.length === 0) {
      skip('Tenant config', 'No tenants seeded yet');
      return;
    }

    for (const tenant of tenants) {
      const { data: config } = await supabase.from('tenant_config').select('key').eq('tenant_id', tenant.id);
      const { data: modules } = await supabase.from('tenant_modules').select('module, enabled').eq('tenant_id', tenant.id);

      const enabledModules = (modules || []).filter(m => m.enabled).length;
      const configKeys = (config || []).length;

      if (configKeys > 0) pass(`${tenant.slug} config`, `${configKeys} keys`);
      else fail(`${tenant.slug} config`, 'no config keys found');

      if (enabledModules > 0) pass(`${tenant.slug} modules`, `${enabledModules} enabled`);
      else fail(`${tenant.slug} modules`, 'no modules enabled');
    }
  } catch (err) {
    fail('Tenant config check', err.message);
  }
}

async function main() {
  console.log('\n╔══════════════════════════════════════╗');
  console.log('║     Growth OS — Health Check         ║');
  console.log('╚══════════════════════════════════════╝');

  await checkEnvVars();
  await checkSupabase();
  await checkService('API Service', API_URL);
  await checkService('Worker Service', WORKER_URL);
  await checkTenantConfig();

  // Summary
  const passed = checks.filter(c => c.status === 'PASS').length;
  const failed = checks.filter(c => c.status === 'FAIL').length;
  const skipped = checks.filter(c => c.status === 'SKIP').length;

  console.log('\n══════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  console.log('══════════════════════════════════════\n');

  if (failed > 0) {
    console.log('Action items:');
    for (const c of checks.filter(c => c.status === 'FAIL')) {
      console.log(`  → Fix: ${c.name} — ${c.detail}`);
    }
    console.log('');
    process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
