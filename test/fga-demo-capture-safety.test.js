'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { isReproducedAutomationPattern } = require('../scripts/quarantine-fga-automated-demo-captures');

const root = path.join(__dirname, '..');
const source = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('the public route applies the stricter contract only to FGA demo capture', () => {
  const route = source('api/routes/leads-capture.js');
  assert.match(route, /tenant_id === FGA_TENANT_ID/);
  assert.match(route, /requestedSource === 'website_demo_request'/);
  assert.match(route, /assessFgaDemoCapture\(body\)/);
  assert.match(route, /if \(!contactAllowed\)/);
  assert.match(route, /if \(contactAllowed\) \{\s*notifyOwnerNewLead/);
});

test('every agent enqueued by capture honors the shared no-contact contract', () => {
  for (const file of [
    'worker/agents/speed-to-lead.js',
    'worker/agents/enrichment.js',
    'worker/agents/scoring.js',
    'worker/agents/follow-up.js',
  ]) {
    const agent = source(file);
    assert.match(agent, /automatedContactAllowed/,
      `${file} must honor quarantined intake before acting`);
  }
});

test('the cleanup targets only the reproduced numeric free-text pattern', () => {
  assert.equal(isReproducedAutomationPattern({
    lead_source: 'website_demo_request',
    notes: 'Business type: Service · Company: Example · Message: 1234567890',
  }), true);
  assert.equal(isReproducedAutomationPattern({
    lead_source: 'website_demo_request',
    notes: 'Business type: Service · Company: Example · Message: Please call me',
  }), false);
  assert.equal(isReproducedAutomationPattern({
    lead_source: 'prospecting_agent', notes: 'Message: 1234567890',
  }), false);
});

test('the cleanup is non-destructive, FGA-scoped, and confirmation-gated', () => {
  const script = source('scripts/quarantine-fga-automated-demo-captures.js');
  assert.match(script, /\.eq\('tenant_id', FGA_TENANT_ID\)/);
  assert.match(script, /CONFIRM_FGA_TENANT_ID === FGA_TENANT_ID/);
  assert.doesNotMatch(script, /\.delete\(/);
});
