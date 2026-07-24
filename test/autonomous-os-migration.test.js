'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(
  path.join(__dirname, '..', 'db', 'migrations', '067_agent_job_outcomes.sql'),
  'utf8'
);

test('outcome migration is additive, tenant-scoped, and does not alter job status behavior', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.agent_job_outcomes/i);
  assert.match(migration, /tenant_id\s+uuid NOT NULL REFERENCES public\.tenants/i);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/i);
  assert.match(migration, /tenant_iso_agent_job_outcomes/i);
  assert.doesNotMatch(migration, /\bDROP\s+(TABLE|COLUMN|POLICY)\b/i);
  assert.doesNotMatch(migration, /ALTER TABLE public\.agent_jobs/i);
});
