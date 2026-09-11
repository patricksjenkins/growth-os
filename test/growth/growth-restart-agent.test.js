'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';

const agent = require('../../worker/agents/growth-restart');
const { SALES_DEPARTMENT } = require('../../core/revenue/sales-department');

test('restart agent is FGA-only before it can open a database client', async () => {
  const result = await agent({ id: '00000000-0000-4000-8000-000000000099', slug: 'customer' });
  assert.deepEqual(result, { success: true, skipped: true, reason: 'not_fga_tenant' });
});

test('restart agent is bounded to one 25-prospect daily cohort', () => {
  assert.equal(agent._test.DAILY_LIMIT, 25);
  assert.equal(agent._test.MAX_REVALIDATIONS, 100);
  assert.equal(agent._test.remainingDailyAuthorizationBudget(25, 0), 25);
  assert.equal(agent._test.remainingDailyAuthorizationBudget(25, 10), 15);
  assert.equal(agent._test.remainingDailyAuthorizationBudget(25, 25), 0);
  assert.equal(agent._test.remainingDailyAuthorizationBudget(25, 30), 0);
});

test('restart revalidation ranks the complete manifest before applying its work cap', () => {
  const ranked = agent._test.rankRestartCandidates([
    { id: 'first-by-id', evidence: { priority_score: 10 } },
    { id: 'existing-sweet-spot', evidence: { priority_score: 14500 } },
    { id: 'new-discovery', evidence: { priority_score: 3500 } },
  ], 2);
  assert.deepEqual(ranked.map((row) => row.id), ['existing-sweet-spot', 'new-discovery']);

  const source = fs.readFileSync(require.resolve('../../worker/agents/growth-restart'), 'utf8');
  assert.match(source, /fetchAllRows/);
  assert.match(source, /return rankRestartCandidates\(result[.]data, MAX_REVALIDATIONS\)/);
  assert.doesNotMatch(source, /\.limit\(MAX_REVALIDATIONS\)/);
});

test('restart retries count exact-FGA authorizations inside Eastern-day bounds', () => {
  const source = fs.readFileSync(require.resolve('../../worker/agents/growth-restart'), 'utf8');
  assert.match(source, /etDayRangeIso\(etParts\(new Date\(\)\)\.date\)/);
  assert.match(source, /\.eq\('tenant_id', FGA_TENANT_ID\)[\s\S]*\.gte\('authorized_at', startIso\)[\s\S]*\.lt\('authorized_at', endIso\)/);
  assert.match(source, /daily_authorization_cap_reached/);
});

test('an authorized cohort with no draft owner is recoverable before the cap early-return', () => {
  const missing = agent._test.missingAuthorizedLeadIds(
    [{ lead_id: 'draft-owned' }, { lead_id: 'job-owned' }, { lead_id: 'missing' }],
    [
      { lead_id: 'draft-owned', metadata: { restart_batch_id: 'batch-1' } },
      { lead_id: 'missing', metadata: { restart_batch_id: 'other-batch' } },
    ],
    [{ payload: { lead_id: 'job-owned', restart_batch_id: 'batch-1' } }],
    'batch-1',
  );
  assert.deepEqual(missing, ['missing']);

  const source = fs.readFileSync(require.resolve('../../worker/agents/growth-restart'), 'utf8');
  assert.match(source, /growth_restart_recovery/);
  assert.match(source, /prior_cohort_ownership_recovered/);
  assert.ok(
    source.indexOf("pending_restart_inventory") < source.indexOf('if (dailyRemaining === 0)'),
    'pending authorized work must be recovered before the daily-cap return',
  );
});

test('restart agent prepares drafts and contains no provider dispatch path', () => {
  const source = fs.readFileSync(require.resolve('../../worker/agents/growth-restart'), 'utf8');
  assert.match(source, /skip_send_handoff:\s*true/);
  assert.match(source, /loadProtectedOrganizationIndex/);
  assert.match(source, /first_touch_sent_at/);
  assert.doesNotMatch(source, /resend[.]emails|sendEmail|telnyx|twilio/i);
});

test('Revenue Prospect Supply names the restart agent as accountable work', () => {
  const supply = SALES_DEPARTMENT.teams.find(team => team.name === 'Prospect Supply');
  assert.ok(supply.members.includes('growth-restart'));
});
