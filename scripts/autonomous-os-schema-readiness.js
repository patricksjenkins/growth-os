/**
 * Read-only production/staging schema readiness for migrations 067-092.
 *
 * It performs head-only table probes and emits table names, availability,
 * aggregate row counts, and error codes. It never reads row values, invokes
 * RPCs, or mutates data. A migration is ready only when every table it owns is
 * available; this prevents a partially applied migration from looking green.
 */

'use strict';

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const fs = require('node:fs');
const path = require('node:path');

const MIGRATION_TABLES = Object.freeze({
  '067': ['agent_job_outcomes'],
  '068': ['work_items', 'work_item_events', 'work_item_audit_log'],
  '069': [
    'documents',
    'document_versions',
    'document_chunks',
    'document_links',
    'document_events',
    'document_access_grants',
  ],
  '070': ['scheduling_policies', 'appointment_workflows', 'appointment_events'],
  '071': [],
  '072': [],
  '073': [],
  '074': ['incident_work_item_links', 'incident_reconciliation_events'],
  '075': [],
  '076': [
    'sales_closed_won_events',
    'closed_won_onboarding_handoffs',
    'closed_won_onboarding_events',
  ],
  '077': [],
  '078': [
    'scheduling_automation_controls',
    'appointment_lifecycle_controls',
    'appointment_lifecycle_events',
  ],
  '079': ['billing_identity_mappings', 'finance_attribution_records'],
  '080': ['document_ingestion_controls', 'document_ingestion_receipts'],
  '081': [
    'finance_close_automation_controls',
    'finance_close_cycles',
    'finance_close_exceptions',
    'finance_close_tasks',
    'finance_close_events',
  ],
  '082': [
    'content_delivery_automation_controls',
    'content_artifact_versions',
    'content_quality_rubric_versions',
    'content_quality_calibrations',
    'content_quality_evaluations',
    'content_delivery_receipts',
  ],
  '083': [
    'client_health_automation_controls',
    'client_health_signal_snapshots',
    'client_health_interventions',
    'client_health_intervention_events',
  ],
  '084': [
    'lead_action_automation_controls',
    'lead_actions',
    'lead_action_receipts',
  ],
  '085': [
    'reliability_head_controls',
    'reliability_head_reports',
    'reliability_head_cases',
    'reliability_head_events',
  ],
  '086': [
    'revenue_head_controls',
    'revenue_head_charters',
    'revenue_head_reports',
    'revenue_head_items',
    'revenue_head_events',
  ],
  '087': [
    'cos_supervision_controls',
    'department_report_contracts',
    'department_reports',
    'cos_coordination_cycles',
    'cos_coordination_records',
    'cos_supervised_events',
  ],
  '088': [
    'onboarding_head_controls',
    'onboarding_customer_outcome_receipts',
    'onboarding_head_reports',
    'onboarding_head_cases',
    'onboarding_head_events',
  ],
  '089': [
    'client_success_head_controls',
    'client_success_head_charters',
    'client_success_support_snapshots',
    'client_success_head_reports',
    'client_success_head_items',
    'client_success_head_events',
  ],
  '090': [
    'finance_governance_head_controls',
    'finance_governance_head_reports',
    'finance_governance_report_attributions',
    'finance_governance_head_cases',
    'finance_governance_head_events',
  ],
  '091': [
    'marketing_brand_head_controls',
    'marketing_brand_head_reports',
    'marketing_brand_report_artifacts',
    'marketing_brand_report_quality',
    'marketing_brand_report_deliveries',
    'marketing_brand_head_cases',
    'marketing_brand_head_events',
  ],
  '092': [
    'product_engineering_head_controls',
    'product_engineering_outcome_receipts',
    'product_engineering_head_reports',
    'product_engineering_head_cases',
    'product_engineering_head_events',
  ],
});

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');

function extractMigrationFunctions(migrationsDir = MIGRATIONS_DIR) {
  const result = {};
  for (const migration of Object.keys(MIGRATION_TABLES)) {
    const file = fs.readdirSync(migrationsDir)
      .find((name) => name.startsWith(`${migration}_`) && name.endsWith('.sql'));
    if (!file) throw new Error(`Missing migration file for ${migration}`);
    const source = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    result[migration] = [...new Set(
      [...source.matchAll(
        /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?([a-z0-9_]+)/gi
      )].map((match) => match[1].toLowerCase())
    )].sort();
  }
  return result;
}

const MIGRATION_FUNCTIONS = Object.freeze(extractMigrationFunctions());

function required(env, name) {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function probeTable(db, table) {
  const { count, error } = await db
    .from(table)
    .select('id', { count: 'exact', head: true });
  if (error) {
    return {
      available: false,
      row_count: null,
      error_code: error.code || 'unknown',
    };
  }
  return {
    available: true,
    row_count: Number(count || 0),
    error_code: null,
  };
}

async function fetchExposedFunctions({ url, key, fetchImpl = fetch }) {
  const response = await fetchImpl(`${url.replace(/\/$/, '')}/rest/v1/`, {
    method: 'GET',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: 'application/openapi+json',
    },
  });
  if (!response.ok) {
    const error = new Error('PostgREST OpenAPI schema unavailable');
    error.code = `HTTP_${response.status}`;
    throw error;
  }
  const schema = await response.json();
  return new Set(
    Object.keys(schema.paths || {})
      .filter((entry) => entry.startsWith('/rpc/'))
      .map((entry) => entry.slice('/rpc/'.length).toLowerCase())
  );
}

async function assessSchemaReadiness(db, { exposedFunctions = new Set() } = {}) {
  const tableResults = {};
  for (const table of [...new Set(Object.values(MIGRATION_TABLES).flat())].sort()) {
    tableResults[table] = await probeTable(db, table);
  }

  const migrations = {};
  for (const [migration, tables] of Object.entries(MIGRATION_TABLES)) {
    const functions = MIGRATION_FUNCTIONS[migration];
    const tableReady = tables.length > 0 && tables.every(
      (table) => tableResults[table].available
    );
    const functionReady = functions.length > 0 && functions.every(
      (name) => exposedFunctions.has(name)
    );
    const hasInspectableObjects = tables.length > 0 || functions.length > 0;
    const objectsReady =
      (tables.length === 0 || tableReady)
      && (functions.length === 0 || functionReady);
    migrations[migration] = {
      status: !hasInspectableObjects
        ? 'requires_policy_review'
        : (objectsReady ? 'objects_available' : 'objects_missing_or_partial'),
      table_count: tables.length,
      available_table_count: tables.filter(
        (table) => tableResults[table].available
      ).length,
      function_count: functions.length,
      available_function_count: functions.filter(
        (name) => exposedFunctions.has(name)
      ).length,
    };
  }

  const tableCount = Object.keys(tableResults).length;
  const availableTableCount = Object.values(tableResults)
    .filter((result) => result.available)
    .length;
  const functionNames = [...new Set(Object.values(MIGRATION_FUNCTIONS).flat())].sort();
  const availableFunctionCount = functionNames.filter(
    (name) => exposedFunctions.has(name)
  ).length;
  return {
    schema_version: 1,
    captured_at: new Date().toISOString(),
    summary: {
      migration_count: Object.keys(MIGRATION_TABLES).length,
      table_count: tableCount,
      available_table_count: availableTableCount,
      missing_table_count: tableCount - availableTableCount,
      function_count: functionNames.length,
      available_function_count: availableFunctionCount,
      missing_function_count: functionNames.length - availableFunctionCount,
      fully_object_ready_migration_count: Object.values(migrations)
        .filter((migration) => migration.status === 'objects_available')
        .length,
      policy_review_migration_count: Object.values(migrations)
        .filter((migration) => migration.status === 'requires_policy_review')
        .length,
    },
    migrations,
    tables: tableResults,
    functions: Object.fromEntries(functionNames.map((name) => [
      name,
      { exposed: exposedFunctions.has(name) },
    ])),
  };
}

async function main(env = process.env) {
  const db = createClient(
    required(env, 'SUPABASE_URL'),
    required(env, 'SUPABASE_SERVICE_KEY'),
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
  const exposedFunctions = await fetchExposedFunctions({
    url: required(env, 'SUPABASE_URL'),
    key: required(env, 'SUPABASE_SERVICE_KEY'),
  });
  console.log(JSON.stringify(
    await assessSchemaReadiness(db, { exposedFunctions }),
    null,
    2
  ));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({
      success: false,
      error_code: error.code || error.name || 'schema_readiness_failed',
    }));
    process.exit(1);
  });
}

module.exports = {
  MIGRATION_TABLES,
  MIGRATION_FUNCTIONS,
  assessSchemaReadiness,
  extractMigrationFunctions,
  fetchExposedFunctions,
  probeTable,
};
