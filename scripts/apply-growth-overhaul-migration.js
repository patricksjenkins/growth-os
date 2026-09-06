#!/usr/bin/env node
'use strict';

/**
 * Apply additive Growth Engine migration 106 through the existing reviewed
 * exec_sql boundary. Default mode performs only schema probes. Write mode
 * requires an explicit production confirmation and records a tenant-scoped
 * audit receipt without printing credentials or SQL contents.
 */
require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getServiceClient } = require('../db/client');
const { FGA_TENANT_ID } = require('../core/config');

const APPLY = process.argv.includes('--apply');
const CONFIRMED = process.argv.includes('--confirm-fga-production');
const MIGRATION_PATH = path.join(__dirname, '..', 'db', 'migrations', '106_growth_pipeline_overhaul.sql');
const EXPECTED_PROBES = {
  growth_events: 'id,tenant_id,lead_id,event_type,stage,source_system,idempotency_key,evidence',
  growth_stage_state: 'tenant_id,lead_id,stage,last_event_id,evidence_status',
  growth_restart_batches: 'id,tenant_id,status,policy_version,sequence_plan_key',
  growth_restart_candidates: 'id,batch_id,tenant_id,lead_id,decision',
  drip_campaigns: 'id,plan_key,total_touches,includes_initial_touch',
  email_events: 'id,provider_event_id',
  drip_inbound: 'id,body_text,intent,routed_at',
  email_connections: 'id,reply_cursor_at',
  leads: 'id,growth_evidence_status,growth_evidence_checked_at,growth_evidence_attempts',
};

async function objectAvailable(db, table, columns) {
  const { error } = await db.from(table).select(columns, { count: 'exact', head: true }).limit(1);
  return !error;
}

async function schemaStatus(db) {
  const entries = await Promise.all(Object.entries(EXPECTED_PROBES)
    .map(async ([table, columns]) => [table, await objectAvailable(db, table, columns)]));
  return Object.fromEntries(entries);
}

async function main() {
  const db = getServiceClient();
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  const fingerprint = crypto.createHash('sha256').update(sql).digest('hex');
  const before = await schemaStatus(db);

  if (!APPLY) {
    console.log(JSON.stringify({
      migration: 106,
      fingerprint,
      mode: 'status',
      schema_objects: before,
      writes_requested: false,
    }, null, 2));
    return;
  }
  if (!CONFIRMED) throw new Error('--confirm-fga-production is required to apply migration 106');

  const { error } = await db.rpc('exec_sql', { query: sql });
  if (error) throw new Error(`Migration 106 failed: ${error.message}`);

  // Ask PostgREST to refresh its schema cache before probing the new objects.
  const { error: reloadError } = await db.rpc('exec_sql', { query: "NOTIFY pgrst, 'reload schema'" });
  if (reloadError) throw new Error(`Migration applied but schema reload failed: ${reloadError.message}`);

  let after = await schemaStatus(db);
  if (Object.values(after).some((available) => !available)) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    after = await schemaStatus(db);
  }
  if (Object.values(after).some((available) => !available)) {
    throw new Error('Migration applied but one or more schema objects are unavailable');
  }

  const { error: auditError } = await db.from('activity_log').insert({
    tenant_id: FGA_TENANT_ID,
    agent: 'codex:growth-activation',
    action: 'migration_106_applied',
    entity_type: 'schema_migration',
    entity_id: FGA_TENANT_ID,
    level: 'info',
    metadata: { migration: 106, fingerprint, schema_objects: after },
  });
  if (auditError) throw new Error(`Migration applied but audit receipt failed: ${auditError.message}`);

  console.log(JSON.stringify({
    migration: 106,
    fingerprint,
    mode: 'applied',
    schema_objects: after,
    customer_rows_rewritten: false,
  }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { EXPECTED_PROBES };
