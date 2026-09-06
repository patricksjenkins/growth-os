#!/usr/bin/env node
'use strict';

/**
 * FGA-only production containment for Growth Engine sends.
 *
 * Default mode is read-only. Write modes require the explicit production
 * confirmation phrase and update only the canonical FGA tenant's config rows.
 * No customer-tenant row is selected or modified.
 *
 *   node scripts/set-fga-growth-sending.js
 *   node scripts/set-fga-growth-sending.js --pause-all --confirm-fga-production
 *   node scripts/set-fga-growth-sending.js --monitor-only --confirm-fga-production
 *   node scripts/set-fga-growth-sending.js --resume --confirm-fga-production
 */
require('dotenv').config();

const { getServiceClient } = require('../db/client');
const { FGA_TENANT_ID } = require('../core/config');

const CONFIRMED = process.argv.includes('--confirm-fga-production');
const modes = ['--pause-all', '--monitor-only', '--resume'].filter((mode) => process.argv.includes(mode));
const mode = modes[0] || '--status';

const KEYS = ['autosend_paused', 'drip_campaign_enabled', 'drip_sends_paused'];

function desiredValues(selectedMode) {
  if (selectedMode === '--pause-all') {
    // Compatible with the pre-overhaul worker: its older global drip flag is
    // the only way to stop follow-ups until the new worker is deployed.
    return {
      autosend_paused: 'true',
      drip_campaign_enabled: 'false',
      drip_sends_paused: 'true',
    };
  }
  if (selectedMode === '--monitor-only') {
    // New worker: sync replies, but do not send first touches or follow-ups.
    return {
      autosend_paused: 'true',
      drip_campaign_enabled: 'true',
      drip_sends_paused: 'true',
    };
  }
  if (selectedMode === '--resume') {
    return {
      autosend_paused: 'false',
      drip_campaign_enabled: 'true',
      drip_sends_paused: 'false',
    };
  }
  return null;
}

function valuesFrom(rows) {
  return Object.fromEntries(KEYS.map((key) => {
    const row = (rows || []).find((candidate) => candidate.key === key);
    return [key, row ? String(row.value) : null];
  }));
}

async function readState(db) {
  const { data, error } = await db.from('tenant_config')
    .select('key, value')
    .eq('tenant_id', FGA_TENANT_ID)
    .in('key', KEYS);
  if (error) throw new Error(`FGA send-state read failed: ${error.message}`);
  return valuesFrom(data);
}

async function main() {
  if (modes.length > 1) throw new Error('Choose exactly one write mode');
  const db = getServiceClient();
  const before = await readState(db);
  const desired = desiredValues(mode);

  if (!desired) {
    console.log(JSON.stringify({
      tenant_scope: 'FGA_ONLY', mode: 'status', state: before,
      writes_customer_tenants: false, sends_messages: false,
    }, null, 2));
    return;
  }
  if (!CONFIRMED) throw new Error('--confirm-fga-production is required for a write mode');

  const rows = Object.entries(desired).map(([key, value]) => ({
    tenant_id: FGA_TENANT_ID, key, value,
  }));
  const { error } = await db.from('tenant_config').upsert(rows, { onConflict: 'tenant_id,key' });
  if (error) throw new Error(`FGA send-state update failed: ${error.message}`);

  const after = await readState(db);
  for (const [key, value] of Object.entries(desired)) {
    if (after[key] !== value) throw new Error(`FGA send-state verification failed for ${key}`);
  }
  const { error: auditError } = await db.from('activity_log').insert({
    tenant_id: FGA_TENANT_ID,
    agent: 'codex:growth-activation',
    action: `growth_sending_${mode.slice(2).replace(/-/g, '_')}`,
    entity_type: 'tenant_config',
    entity_id: FGA_TENANT_ID,
    level: 'info',
    metadata: { before, after, customer_tenants_modified: 0 },
  });
  if (auditError) throw new Error(`FGA send-state audit write failed: ${auditError.message}`);

  console.log(JSON.stringify({
    tenant_scope: 'FGA_ONLY', mode: mode.slice(2), before, after,
    writes_customer_tenants: false, sends_messages: false,
  }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { desiredValues, valuesFrom, KEYS };
