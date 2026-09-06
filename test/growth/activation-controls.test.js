'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { desiredValues, valuesFrom, KEYS } = require('../../scripts/set-fga-growth-sending');
const { EXPECTED_PROBES } = require('../../scripts/apply-growth-overhaul-migration');

test('activation pause modes contain both first-touch and follow-up sending', () => {
  assert.deepEqual(desiredValues('--pause-all'), {
    autosend_paused: 'true',
    drip_campaign_enabled: 'false',
    drip_sends_paused: 'true',
  });
  assert.deepEqual(desiredValues('--monitor-only'), {
    autosend_paused: 'true',
    drip_campaign_enabled: 'true',
    drip_sends_paused: 'true',
  });
});

test('resume is explicit and enables both outbound paths', () => {
  assert.deepEqual(desiredValues('--resume'), {
    autosend_paused: 'false',
    drip_campaign_enabled: 'true',
    drip_sends_paused: 'false',
  });
});

test('send state parsing never includes unrelated tenant configuration', () => {
  const state = valuesFrom([
    { key: 'autosend_paused', value: true },
    { key: 'secret_key', value: 'must-not-appear' },
  ]);
  assert.deepEqual(Object.keys(state), KEYS);
  assert.equal(state.autosend_paused, 'true');
  assert.equal(JSON.stringify(state).includes('must-not-appear'), false);
});

test('migration utility is pinned to additive migration 106 and explicit confirmation', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../scripts/apply-growth-overhaul-migration.js'), 'utf8');
  assert.match(source, /106_growth_pipeline_overhaul\.sql/);
  assert.match(source, /--confirm-fga-production/);
  assert.doesNotMatch(source, /106_growth_pipeline_overhaul_rollback/);
  assert.deepEqual(Object.keys(EXPECTED_PROBES).sort(), [
    'drip_campaigns', 'drip_inbound', 'email_connections', 'email_events',
    'growth_events', 'growth_restart_batches', 'growth_restart_candidates',
    'growth_stage_state', 'leads',
  ]);
});
