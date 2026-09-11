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
