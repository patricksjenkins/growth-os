/**
 * Read-only production/staging baseline for the Autonomous Company OS.
 *
 * Outputs aggregate counts and schema-presence only. It never selects customer
 * content, names, emails, phone numbers, credentials, document bodies, or
 * financial amounts, and it performs no inserts, updates, deletes, or RPCs.
 */

'use strict';

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function count(db, table, configure = query => query) {
  let query = db.from(table).select('id', { count: 'exact', head: true });
  query = configure(query);
  const { count: value, error } = await query;
  if (error) {
    return {
      available: false,
      error_code: error.code || 'unknown',
    };
  }
  return { available: true, count: Number(value || 0) };
}

async function integrationInventory(db) {
  const { data, error } = await db
    .from('tenant_integrations')
    .select('service,status')
    .limit(1000);
  if (error) {
    return { available: false, error_code: error.code || 'unknown' };
  }
  const aggregate = {};
  for (const row of data || []) {
    const service = String(row.service || 'unknown').toLowerCase();
    const status = String(row.status || 'unknown').toLowerCase();
    const key = `${service}:${status}`;
    aggregate[key] = (aggregate[key] || 0) + 1;
  }
  return { available: true, aggregate };
}

async function main() {
  const db = createClient(
    required('SUPABASE_URL'),
    required('SUPABASE_SERVICE_KEY'),
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const checks = {
    captured_at: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'unknown',
    credentials: {
      supabase: true,
      telnyx: Boolean(process.env.TELNYX_API_KEY),
      telnyx_signature: Boolean(process.env.TELNYX_PUBLIC_KEY),
      resend_signature: Boolean(process.env.RESEND_WEBHOOK_SECRET),
      calendly_signature: Boolean(process.env.CALENDLY_WEBHOOK_SECRET),
      google_oauth_client: Boolean(
        process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
      ),
      stripe_signature: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
    },
    counts: {},
  };

  const queries = {
    active_tenants: count(db, 'tenants', query => query.eq('status', 'active')),
    recent_jobs: count(db, 'agent_jobs', query => query.gte('created_at', thirtyDaysAgo)),
    recent_failed_jobs: count(db, 'agent_jobs', query =>
      query.eq('status', 'failed').gte('created_at', thirtyDaysAgo)),
    open_attention: count(db, 'attention_queue', query => query.is('resolved_at', null)),
    open_incidents: count(db, 'ops_incidents', query =>
      query.in('status', ['open', 'remediating', 'awaiting_approval', 'escalated'])),
    recovered_incidents: count(db, 'ops_incidents', query => query.eq('status', 'recovered')),
    onboarding_workflows: count(db, 'onboarding_workflows'),
    onboarding_steps: count(db, 'onboarding_steps'),
    tenant_integrations: count(db, 'tenant_integrations'),
    tenant_integration_inventory: integrationInventory(db),
    scheduling_policies: count(db, 'scheduling_policies'),
    appointment_workflows: count(db, 'appointment_workflows'),
    finance_entries: count(db, 'finance_entries'),
    agent_job_outcomes: count(db, 'agent_job_outcomes'),
  };

  for (const [name, promise] of Object.entries(queries)) {
    checks.counts[name] = await promise;
  }

  console.log(JSON.stringify(checks, null, 2));
}

if (require.main === module) {
  main().catch(error => {
    console.error(JSON.stringify({
      success: false,
      error_code: error.code || error.name || 'baseline_failed',
    }));
    process.exit(1);
  });
}

module.exports = { count };
