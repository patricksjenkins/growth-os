'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { getSchedule } = require('../../worker/scheduler/cron');
const { SALES_DEPARTMENT } = require('../../core/revenue/sales-department');
const { deriveNextActions } = require('../../core/growth/orchestrator');

test('FGA gets daily bounded contact recovery while legacy tenant Facebook behavior stays isolated', async () => {
  const schedule = getSchedule();
  const recovery = schedule.find((job) => (
    job.agent === 'enrichment' && job.payload?.recovery_priority === 'contact'
  ));
  assert.ok(recovery);
  assert.deepEqual(recovery.payload, {
    evidence_recovery: true,
    recovery_priority: 'contact',
    limit: 25,
  });
  assert.equal(await recovery.when({ slug: 'fga' }), true);
  assert.equal(await recovery.when({ slug: 'customer-tenant' }), false);

  const legacyFacebook = schedule.find((job) => (
    job.agent === 'facebook-prospecting' && !job.payload
  ));
  assert.ok(legacyFacebook);
  assert.equal(await legacyFacebook.when({ slug: 'fga' }), false);
  assert.equal(await legacyFacebook.when({ slug: 'customer-tenant' }), true);
});

test('contact recovery is research-only and cannot enqueue outreach directly', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'worker', 'agents', 'enrichment.js'), 'utf8');
  assert.match(source, /recoveryPriority === 'contact'[\s\S]*[.]is\('email', null\)/);
  assert.match(source, /suppressOutreachEnqueue: true/);
  assert.match(source, /payload[.]evidence_recovery === true && tenant[.]id === FGA_TENANT_ID/);
});

test('Revenue department assigns contact recovery to enrichment, not Patrick or a manual Facebook agent', () => {
  const supply = SALES_DEPARTMENT.teams.find((team) => team.name === 'Prospect Supply');
  assert.ok(supply.members.includes('enrichment'));
  assert.ok(!supply.members.includes('facebook-prospecting'));

  const actions = deriveNextActions({
    high_score: 12,
    no_contact: 4,
    fb_only: 9,
    drafts_to_review: 0,
    replies: 0,
  }, { status: 'standing' }, []);
  const byId = Object.fromEntries(actions.map((action) => [action.id, action]));
  assert.match(byId.review_high_score.label, /^Advance /);
  assert.match(byId.review_no_contact.label, /^Recover contact evidence/);
  assert.match(byId.recover_facebook_contacts.label, /^Recover email channels/);
});
