'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { getSchedule } = require('../../worker/scheduler/cron');
const { SALES_DEPARTMENT } = require('../../core/revenue/sales-department');
const { deriveNextActions } = require('../../core/growth/orchestrator');
const { FGA_TENANT_ID } = require('../../core/config');
const { _test: enrichmentInternals } = require('../../worker/agents/enrichment');

test('FGA gets daily bounded contact recovery while legacy tenant Facebook behavior stays isolated', async () => {
  const schedule = getSchedule();
  const recovery = schedule.find((job) => (
    job.agent === 'enrichment' && job.payload?.recovery_priority === 'contact'
  ));
  assert.ok(recovery);
  assert.deepEqual(recovery.payload, {
    evidence_recovery: true,
    recovery_priority: 'contact',
    limit: 5,
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
  assert.equal(enrichmentInternals.resolveEnrichmentWorkload(FGA_TENANT_ID, {
    evidence_recovery: true,
    recovery_priority: 'contact',
  }, {}).evidenceRecovery, true);
  assert.equal(enrichmentInternals.resolveEnrichmentWorkload('customer-tenant', {
    evidence_recovery: true,
    recovery_priority: 'contact',
  }, {}).evidenceRecovery, false);
});

test('bounded enrichment concurrency applies only to exact-FGA evidence recovery', () => {
  assert.equal(enrichmentInternals.enrichmentConcurrency(FGA_TENANT_ID, true, undefined), 3);
  assert.equal(enrichmentInternals.enrichmentConcurrency(FGA_TENANT_ID, true, '5'), 5);
  assert.equal(enrichmentInternals.enrichmentConcurrency(FGA_TENANT_ID, true, '99'), 5);
  assert.equal(enrichmentInternals.enrichmentConcurrency(FGA_TENANT_ID, true, '0'), 1);
  assert.equal(enrichmentInternals.enrichmentConcurrency(FGA_TENANT_ID, true, 'bad'), 3);
  assert.equal(enrichmentInternals.enrichmentConcurrency(FGA_TENANT_ID, false, '5'), 1);
  assert.equal(enrichmentInternals.enrichmentConcurrency('customer-tenant', true, '5'), 1);
});

test('FGA contact recovery retains deep contact sources while headcount recovery stays lean', () => {
  const allowed = enrichmentInternals.deepContactSourcesAllowed;
  assert.equal(allowed(FGA_TENANT_ID, {}), true, 'ordinary FGA enrichment is unchanged');
  assert.equal(allowed('customer-tenant', {}), true, 'ordinary customer enrichment is unchanged');
  assert.equal(allowed(FGA_TENANT_ID, {
    evidenceRecovery: true,
    recoveryPriority: 'contact',
  }), true, 'the email-recovery sweep may use the existing own-site and Facebook sources');
  assert.equal(allowed(FGA_TENANT_ID, {
    evidenceRecovery: true,
    recoveryPriority: 'general',
  }), false, 'general employee-evidence recovery keeps the bounded source set');
  assert.equal(allowed(FGA_TENANT_ID, {
    evidenceRecovery: true,
    recoveryPriority: 'restart_ready',
  }), false, 'restart-ready employee-evidence recovery keeps the bounded source set');
  assert.equal(allowed('customer-tenant', {
    evidenceRecovery: true,
    recoveryPriority: 'contact',
  }), false, 'a customer tenant cannot opt into FGA contact recovery');
});

test('provider-backed headcount recovery skips paid contact research only for exact FGA rows with email', () => {
  const eligible = enrichmentInternals.providerOnlyRecoveryEligible;
  const evidence = { count: 7, provider: 'apify', method: 'provider_estimate' };
  assert.equal(eligible(FGA_TENANT_ID, { email: 'owner@smallbiz.test' }, {
    evidenceRecovery: true,
  }, evidence), true);
  assert.equal(eligible(FGA_TENANT_ID, { email: null }, {
    evidenceRecovery: true,
  }, evidence), false);
  assert.equal(eligible('customer-tenant', { email: 'owner@smallbiz.test' }, {
    evidenceRecovery: true,
  }, evidence), false);
  assert.equal(eligible(FGA_TENANT_ID, { email: 'owner@smallbiz.test' }, {}, evidence), false);
});

test('contact recovery forwards its exact mode and records privacy-safe source receipts', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'worker', 'agents', 'enrichment.js'), 'utf8');
  assert.match(source, /recoveryPriority,\s*\n\s*suppressOutreachEnqueue: true/);
  assert.match(source, /contact_source_receipts: contactSourceReceipts/);
  assert.match(source, /own_site_attempted/);
  assert.match(source, /facebook_about_attempted/);
  assert.deepEqual(enrichmentInternals.emptyContactSourceReceipts(), {
    own_site_attempted: false,
    own_site_email_found: false,
    facebook_about_attempted: false,
    facebook_about_email_found: false,
  }, 'source receipts contain only aggregate booleans, never prospect identity or contact data');
});

test('validated FGA source emails survive a model omission without changing customer tenants', () => {
  assert.equal(enrichmentInternals.publicContactEmail(' Owner@SmallBiz.test '), 'owner@smallbiz.test');
  assert.equal(enrichmentInternals.publicContactEmail(['bad', 'team@smallbiz.test']), 'team@smallbiz.test');
  for (const value of [
    'not-an-email',
    'noreply@example.com',
    'do-not-reply@example.com',
    'logo@2x.png',
    'person@yourdomain.com',
  ]) assert.equal(enrichmentInternals.publicContactEmail(value), null);

  assert.deepEqual(enrichmentInternals.resolveContactEmail(FGA_TENANT_ID, {
    facebookAboutEmail: 'owner@smallbiz.test',
  }), { email: 'owner@smallbiz.test', source: 'facebook_about' });
  assert.deepEqual(enrichmentInternals.resolveContactEmail(FGA_TENANT_ID, {
    ownSiteEmail: 'hello@smallbiz.test',
    facebookAboutEmail: 'owner@smallbiz.test',
  }), { email: 'hello@smallbiz.test', source: 'owned_website' });
  assert.deepEqual(enrichmentInternals.resolveContactEmail(FGA_TENANT_ID, {
    extractedEmail: 'model@smallbiz.test',
    ownSiteEmail: 'hello@smallbiz.test',
  }), { email: 'model@smallbiz.test', source: 'search_extraction' });
  assert.deepEqual(enrichmentInternals.resolveContactEmail('customer-tenant', {
    facebookAboutEmail: 'owner@smallbiz.test',
  }), { email: null, source: null }, 'customer enrichment cannot adopt the FGA-only fallback');
});

test('direct-source evidence stores only source and time, never the email address', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'worker', 'agents', 'enrichment.js'), 'utf8');
  const marker = source.indexOf('contact_email_evidence:');
  assert.ok(marker > 0);
  const evidenceBlock = source.slice(marker, marker + 260);
  assert.match(evidenceBlock, /source: resolvedContactEmail[.]source/);
  assert.match(evidenceBlock, /verified_at:/);
  assert.doesNotMatch(evidenceBlock, /email:/);
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
