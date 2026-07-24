'use strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { markProcessing } = require('../db/queries/jobs');

function claimClient(returnedRow) {
  const builder = {
    from() { return this; },
    update() { return this; },
    eq() { return this; },
    select() { return this; },
    maybeSingle() {
      return Promise.resolve({ data: returnedRow, error: null });
    },
  };
  return builder;
}

test('conditional claim returns true only to the worker that changed the row', async () => {
  assert.equal(await markProcessing('job-1', claimClient({ id: 'job-1' })), true);
  assert.equal(await markProcessing('job-1', claimClient(null)), false);
});

test('processor refuses to run a job after a zero-row conditional claim', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'worker', 'jobs', 'processor.js'),
    'utf8'
  );

  assert.match(source, /const claimed = await markProcessing\(job\.id\)/);
  assert.match(source, /if \(!claimed\)[\s\S]*continue;/);
  assert.ok(
    source.indexOf('if (!claimed)') < source.indexOf('await runAgent('),
    'claim gate must occur before handler execution'
  );
});
