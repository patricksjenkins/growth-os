#!/usr/bin/env node
'use strict';

/**
 * Apply additive migration 108 through the reviewed exec_sql boundary.
 * Default mode performs a non-mutating version probe. The migration replaces
 * one source-period validation predicate and never changes tenant data or any
 * production authority control.
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
  '108_chief_of_staff_reliability_period_alignment.sql',
);

async function installedVersion(db) {
  const { data, error } = await db.rpc('cos_report_period_alignment_version');
  if (error && ['PGRST202', '42883'].includes(String(error.code || ''))) return null;
  if (error) throw error;
  return Number(data || 0) || null;
}

async function main() {
  const db = getServiceClient();
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  const fingerprint = crypto.createHash('sha256').update(sql).digest('hex');
  const before = await installedVersion(db);
  if (!APPLY) {
    console.log(JSON.stringify({
      migration: 108,
      fingerprint,
      mode: 'status',
      installed_version: before,
      authority_controls_changed: false,
      customer_rows_rewritten: false,
    }, null, 2));
    return;
  }
  if (!CONFIRMED) {
    throw new Error('--confirm-fga-production is required to apply migration 108');
  }
  const { error } = await db.rpc('exec_sql', { query: sql });
  if (error) throw new Error(`Migration 108 failed: ${error.message}`);
  const { error: reloadError } = await db.rpc('exec_sql', {
    query: "NOTIFY pgrst, 'reload schema'",
  });
  if (reloadError) throw new Error(`Migration applied but schema reload failed: ${reloadError.message}`);
  let version = await installedVersion(db);
  if (version !== 108) {
    await new Promise(resolve => setTimeout(resolve, 1500));
    version = await installedVersion(db);
  }
  if (version !== 108) throw new Error('Migration applied but period alignment version is unavailable');

  const { error: auditError } = await db.from('activity_log').insert({
    tenant_id: FGA_TENANT_ID,
    agent: 'codex:chief-of-staff-period-alignment',
    action: 'migration_108_applied',
    entity_type: 'schema_migration',
    entity_id: FGA_TENANT_ID,
    level: 'info',
    metadata: {
      migration: 108,
      fingerprint,
      installed_version: version,
      authority_controls_changed: false,
      customer_rows_rewritten: false,
    },
  });
  if (auditError) throw new Error(`Migration applied but audit receipt failed: ${auditError.message}`);
  console.log(JSON.stringify({
    migration: 108,
    fingerprint,
    mode: 'applied',
    installed_version: version,
    authority_controls_changed: false,
    customer_rows_rewritten: false,
  }, null, 2));
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { installedVersion };

