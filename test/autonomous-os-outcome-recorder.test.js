'use strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const dbClient = require('../db/client');
const { recordJobOutcome } = require('../core/autonomous-os/outcome-recorder');

const originalGetServiceClient = dbClient.getServiceClient;

afterEach(() => {
  dbClient.getServiceClient = originalGetServiceClient;
  delete process.env.FGA_OS_OUTCOME_OBSERVABILITY_ENABLED;
});

test('missing outcome table never fails an existing job', async () => {
  const builder = {
    upsert() {
      return Promise.resolve({
        error: { code: '42P01', message: 'relation agent_job_outcomes does not exist' },
      });
    },
  };
  dbClient.getServiceClient = () => ({ from: () => builder });

  const result = await recordJobOutcome({
    jobId: 'job-1',
    tenantId: 'tenant-1',
    agentName: 'system-monitor',
    envelope: {
      schema_version: 1,
      contract_source: 'legacy_adapter',
      execution_state: 'completed',
      result_state: 'succeeded',
      output_state: 'unknown',
      quality_state: 'unverified',
      delivery_state: 'unknown',
      business_outcome_state: 'unverified',
      reason_code: 'legacy_result_unverified',
      evidence: {},
      duration_ms: 4,
      observed_at: new Date().toISOString(),
    },
  });

  assert.deepEqual(result, { recorded: false, reason: 'table_missing' });
});

test('outcome recording can be disabled without touching the database', async () => {
  process.env.FGA_OS_OUTCOME_OBSERVABILITY_ENABLED = 'false';
  dbClient.getServiceClient = () => {
    throw new Error('database should not be read');
  };

  const result = await recordJobOutcome({
    jobId: 'job-1',
    tenantId: 'tenant-1',
    agentName: 'system-monitor',
    envelope: {},
  });

  assert.deepEqual(result, { recorded: false, reason: 'disabled' });
});
