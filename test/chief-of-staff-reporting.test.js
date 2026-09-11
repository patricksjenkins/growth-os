'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { _internal } = require('../worker/agents/chief-of-staff');

test('resolved intake automation failures do not remain Chief of Staff risks', () => {
  const jobs = [
    { agent_name: 'speed-to-lead', payload: { lead_id: 'bot' } },
    { agent_name: 'speed-to-lead', payload: { lead_id: 'real' } },
    { agent_name: 'infrastructure', payload: {} },
  ];
  const leads = [
    { id: 'bot', metadata: { intake_safety: { contact_allowed: false } } },
    { id: 'real', metadata: { intake_safety: { contact_allowed: true } } },
  ];
  assert.deepEqual(_internal.excludeQuarantinedIntakeFailures(jobs, leads), [jobs[1], jobs[2]]);
});

test('owner decisions name the failing agent instead of showing an orphaned error count', () => {
  assert.equal(_internal.ownerDecisionTitle({
    agent_name: 'speed-to-lead',
    business_impact: 'Same error repeated 23× in 8d.',
  }), 'speed-to-lead: Same error repeated 23× in 8d.');
});
