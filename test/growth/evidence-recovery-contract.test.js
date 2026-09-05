'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const enrichment = fs.readFileSync(path.join(root, 'worker/agents/enrichment.js'), 'utf8');
const cron = fs.readFileSync(path.join(root, 'worker/scheduler/cron.js'), 'utf8');

test('evidence recovery is FGA-only, bounded, retryable, and prioritizes restart-ready leads', () => {
  assert.match(enrichment, /payload\.evidence_recovery === true && tenant\.id === FGA_TENANT_ID/);
  assert.match(enrichment, /growth_evidence_attempts', 5/);
  assert.match(enrichment, /recovery_priority === 'restart_ready'/);
  assert.match(enrichment, /\.gte\('lead_score', 60\)/);
  assert.match(enrichment, /\.eq\('outreach_ready', true\)/);
  assert.match(cron, /recovery_priority: 'restart_ready', limit: 25/);
  assert.match(cron, /recovery_priority: 'general', limit: 25/);
  assert.equal((cron.match(/evidence_recovery: true/g) || []).length, 2);
});
