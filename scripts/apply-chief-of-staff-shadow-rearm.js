#!/usr/bin/env node
'use strict';

/**
 * Apply additive migration 107 through the reviewed exec_sql boundary.
 * Default mode performs a non-mutating function probe. Applying the migration
 * does not activate the control; an authenticated FGA owner must invoke the
 * separate shadow activation route afterward.
 */

require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getServiceClient } = require('../db/client');
const { FGA_TENANT_ID } = require('../core/config');

const APPLY = process.argv.includes('--apply');
const CONFIRMED = process.argv.includes('--confirm-fga-production');
const MIGRATION_PATH = path.join(
  __dirname, '..', 'db', 'migrations',
  '107_chief_of_staff_shadow_rearm.sql',
);

async function functionAvailable(db) {
  const { error } = await db.rpc('cos_shadow_activate_rpc', {
    p_tenant_id: null,
    p_actor_id: null,
    p_expected_revision: -1,
    p_evidence: {},
  });
  return !error || !['PGRST202', '42883'].includes(String(error.code || ''));
}

async function main() {
  const db = getServiceClient();
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  const fingerprint = crypto.createHash('sha256').update(sql).digest('hex');
  const before = await functionAvailable(db);
  if (!APPLY) {
    console.log(JSON.stringify({
      migration: 107,
      fingerprint,
      mode: 'status',
      shadow_rearm_rpc_available: before,
      control_activation_requested: false,
      customer_rows_rewritten: false,
    }, null, 2));
    return;
  }
  if (!CONFIRMED) {
    throw new Error('--confirm-fga-production is required to apply migration 107');
  }
  const { error } = await db.rpc('exec_sql', { query: sql });
  if (error) throw new Error(`Migration 107 failed: ${error.message}`);
  const { error: reloadError } = await db.rpc('exec_sql', {
    query: "NOTIFY pgrst, 'reload schema'",
  });
  if (reloadError) throw new Error(`Migration applied but schema reload failed: ${reloadError.message}`);
  let available = await functionAvailable(db);
  if (!available) {
    await new Promise(resolve => setTimeout(resolve, 1500));
    available = await functionAvailable(db);
  }
  if (!available) throw new Error('Migration applied but shadow rearm RPC is unavailable');

  const { error: auditError } = await db.from('activity_log').insert({
    tenant_id: FGA_TENANT_ID,
    agent: 'codex:chief-of-staff-shadow',
    action: 'migration_107_applied',
    entity_type: 'schema_migration',
    entity_id: FGA_TENANT_ID,
    level: 'info',
    metadata: {
      migration: 107,
      fingerprint,
      shadow_rearm_rpc_available: true,
      control_activation_requested: false,
      customer_rows_rewritten: false,
    },
  });
  if (auditError) throw new Error(`Migration applied but audit receipt failed: ${auditError.message}`);
  console.log(JSON.stringify({
    migration: 107,
    fingerprint,
    mode: 'applied',
    shadow_rearm_rpc_available: true,
    control_activation_requested: false,
    customer_rows_rewritten: false,
  }, null, 2));
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { functionAvailable };
