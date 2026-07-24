'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  MIGRATION_FUNCTIONS,
  MIGRATION_TABLES,
  assessSchemaReadiness,
  fetchExposedFunctions,
} = require('../scripts/autonomous-os-schema-readiness');

test('readiness register covers every migration from 067 through 092', () => {
  const expected = Array.from({ length: 26 }, (_, index) =>
    String(index + 67).padStart(3, '0'));
  assert.deepEqual(Object.keys(MIGRATION_TABLES), expected);
});

test('schema probe source is read-only and never invokes an RPC', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'autonomous-os-schema-readiness.js'),
    'utf8'
  );
  assert.doesNotMatch(source, /\.insert\s*\(/);
  assert.doesNotMatch(source, /\.update\s*\(/);
  assert.doesNotMatch(source, /\.delete\s*\(/);
  assert.doesNotMatch(source, /\.upsert\s*\(/);
  assert.doesNotMatch(source, /\.rpc\s*\(/);
  assert.match(source, /head:\s*true/);
  assert.match(source, /application\/openapi\+json/);
});

test('a partially available migration is never reported ready', async () => {
  const db = {
    from(table) {
      return {
        select() {
          if (table === 'agent_job_outcomes') {
            return Promise.resolve({ count: 4, error: null });
          }
          return Promise.resolve({
            count: null,
            error: { code: 'PGRST205' },
          });
        },
      };
    },
  };
  const allFunctions = new Set(Object.values(MIGRATION_FUNCTIONS).flat());
  const readiness = await assessSchemaReadiness(db, {
    exposedFunctions: allFunctions,
  });
  assert.equal(readiness.migrations['067'].status, 'objects_available');
  assert.equal(readiness.migrations['068'].status, 'objects_missing_or_partial');
  assert.equal(readiness.summary.available_table_count, 1);
});

test('OpenAPI inspection records function names without invoking them', async () => {
  let request;
  const exposed = await fetchExposedFunctions({
    url: 'https://example.supabase.co',
    key: 'secret-never-output',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        json: async () => ({
          paths: {
            '/rpc/work_item_create_rpc': {},
            '/documents': {},
          },
        }),
      };
    },
  });
  assert.deepEqual([...exposed], ['work_item_create_rpc']);
  assert.equal(request.options.method, 'GET');
  assert.equal(request.url, 'https://example.supabase.co/rest/v1/');
});
