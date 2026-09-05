'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  DEFAULTS,
  BANNED_PHRASES,
  autosendConfig,
  deterministicDraftChecks,
  evaluateLeadForAutoSend,
  validateRestartAuthorization,
  isoWeekStartIso,
  etDayStartIso,
  stripHtml,
} = require('../core/auto-outreach');

// ---------------------------------------------------------------------------
// Minimal chainable Supabase stub: per-table canned responses; every query
// method returns the builder; awaiting it resolves the table's response.
// ---------------------------------------------------------------------------
function stubDb(tableResponses = {}) {
  const METHODS = ['select', 'eq', 'neq', 'in', 'gte', 'lt', 'not', 'or', 'limit', 'order', 'update', 'insert', 'upsert', 'maybeSingle', 'single', 'filter'];
  return {
    from(table) {
      // Default mirrors Supabase semantics: maybeSingle() resolves data:null
      // when no row matches (an empty ARRAY here would read as truthy and,
      // e.g., make every lead look suppressed).
      const resp = tableResponses[table] !== undefined ? tableResponses[table] : { data: null, count: 0, error: null };
      const builder = {};
      for (const m of METHODS) builder[m] = () => builder;
      builder.then = (resolve) => resolve(typeof resp === 'function' ? resp() : resp);
      return builder;
    },
  };
}

const TENANT = {
  id: 'fga-tenant-id',
  slug: 'fga',
  vertical: null,
  config: {
    postal_address: '123 Peachtree St NE, Atlanta, GA 30303',
    autonomous_outreach_enabled: 'true',
  },
};

const GOOD_LEAD = {
  id: 'lead-1',
  email: 'maria@rodriguezlandscaping.com',
  status: 'new_lead',
  lifecycle_stage: 'prospect',
  // Cold outreach is allow-listed to prospect sources (core/lead-sources.js);
  // a lead without one is treated as inbound and hard-blocked.
  lead_source: 'prospecting_agent',
  company_name: 'Rodriguez Landscaping',
  name: 'Maria Rodriguez',
  city: 'Marietta',
  state: 'GA',
  industry: 'Landscaping',
  employee_count: 2,
  employee_count_actual: 2,
  metadata: { employee_count_evidence: { count: 2, source: 'public registry', confidence: 0.9 } },
  lead_score: 78,
};

// Quality verdict pre-cached on the sequence so the Claude judge never runs.
const GOOD_SEQUENCE = {
  id: 'seq-1',
  lead_id: 'lead-1',
  message_subject: 'Quick question about missed calls',
  message_body: 'Hi Maria, quick question about Rodriguez Landscaping...',
  metadata: { autosend_quality: { ok: true, score: 88, problems: [], judged_by: 'claude' } },
};

const CAP_OK = {
  sentToday: 3, sentThisWeek: 40, sent7d: 60, bounces7d: 0, complaints7d: 0,
  bounceRate7d: 0, dailyCap: 20, dailyRemaining: 17, weeklyTarget: 150,
  deliverabilityPaused: false, detail: 'ok',
};

// ---------------------------------------------------------------------------
// Deterministic draft checks
// ---------------------------------------------------------------------------

const GOOD_BODY = 'Hi Maria, I came across Rodriguez Landscaping while looking at businesses in Marietta. When a call comes in while your crew is mid-job, what happens to it? Most owners tell me those calls go to voicemail and half never call back. We deploy a system that answers for you and follows up so nothing slips. Worth a look?';

test('deterministic checks: clean personalized draft passes', () => {
  const problems = deterministicDraftChecks({
    sequence: { message_subject: 'Quick question' },
    lead: GOOD_LEAD,
    bodyText: GOOD_BODY,
  });
  assert.deepStrictEqual(problems, []);
});

test('deterministic checks: missing subject / short body / template artifact / em dash', () => {
  assert.ok(deterministicDraftChecks({ sequence: { message_subject: '' }, lead: GOOD_LEAD, bodyText: GOOD_BODY }).includes('missing_subject'));
  assert.ok(deterministicDraftChecks({ sequence: { message_subject: 'Hi' }, lead: GOOD_LEAD, bodyText: 'too short' }).some((p) => p === 'body_too_short'));
  assert.ok(deterministicDraftChecks({ sequence: { message_subject: 'Hi there' }, lead: GOOD_LEAD, bodyText: GOOD_BODY + ' {{first_name}}' }).includes('template_artifact'));
  assert.ok(deterministicDraftChecks({ sequence: { message_subject: 'Hi there' }, lead: GOOD_LEAD, bodyText: GOOD_BODY + ' — right?' }).includes('em_dash'));
});

test('deterministic checks: overpromise/dispatch claims are banned', () => {
  const withBanned = GOOD_BODY + ' We guarantee results and fill your schedule.';
  const problems = deterministicDraftChecks({ sequence: { message_subject: 'Hi there' }, lead: GOOD_LEAD, bodyText: withBanned });
  assert.ok(problems.some((p) => p.startsWith('banned_phrase:')));
  // The banned list covers the no-dispatch + overpromise + banned-verb rules.
  for (const phrase of ['guarantee', 'fill your schedule', 'dispatch a', 'we install']) {
    assert.ok(BANNED_PHRASES.includes(phrase), `missing banned phrase: ${phrase}`);
  }
});

test('deterministic checks: unpersonalized draft is flagged', () => {
  const generic = 'Hi there, I help small businesses stop missing calls while doing the work. Most owners tell me calls go to voicemail and never come back. We set up a system that answers and follows up so nothing slips through the cracks at all. Worth a quick look this week?';
  const problems = deterministicDraftChecks({ sequence: { message_subject: 'Hi' }, lead: GOOD_LEAD, bodyText: generic });
  assert.ok(problems.includes('missing_personalization'));
});

// ---------------------------------------------------------------------------
// Config + time helpers
// ---------------------------------------------------------------------------

test('autosendConfig: defaults + blocklist parsing', () => {
  const cfg = autosendConfig({ ...TENANT, config: { ...TENANT.config, outreach_blocklist: '["GoHighLevel.com"," HubSpot.com "]' } });
  assert.strictEqual(cfg.enabled, true);
  assert.strictEqual(cfg.dailyCap, DEFAULTS.dailyCap);
  assert.strictEqual(cfg.weeklyTarget, DEFAULTS.weeklyTarget);
  assert.deepStrictEqual(cfg.blocklist, ['gohighlevel.com', 'hubspot.com']);
  assert.ok(cfg.postalAddress.includes('Atlanta'));
});

test('isoWeekStartIso is a Monday; etDayStartIso anchors at 04:00Z', () => {
  const monday = new Date(isoWeekStartIso(new Date('2026-07-03T15:00:00Z')));
  assert.strictEqual(monday.getUTCDay(), 1);
  assert.ok(etDayStartIso(new Date('2026-07-03T15:00:00Z')).endsWith('T04:00:00.000Z'));
});

test('stripHtml flattens markup', () => {
  // Tags become single spaces (so block boundaries never glue words together).
  assert.strictEqual(stripHtml('<p>Hi <b>Maria</b>,</p><p>ok</p>'), 'Hi Maria , ok');
});

// ---------------------------------------------------------------------------
// Gate evaluation (stubbed db)
// ---------------------------------------------------------------------------

test('gates: fully-qualified lead with cached quality -> send', async () => {
  const db = stubDb(); // every lookup returns empty (no suppression/dupes/customers)
  const r = await evaluateLeadForAutoSend(db, { tenant: TENANT, lead: GOOD_LEAD, sequence: GOOD_SEQUENCE, capState: CAP_OK });
  assert.strictEqual(r.decision, 'send');
  assert.strictEqual(r.reason, 'all_gates_passed');
  assert.strictEqual(r.gates.draft_quality.pass, true);
});

test('gates: low score -> needs_review (manual approval stays available)', async () => {
  const r = await evaluateLeadForAutoSend(stubDb(), {
    tenant: TENANT, lead: { ...GOOD_LEAD, lead_score: 40 }, sequence: GOOD_SEQUENCE, capState: CAP_OK,
  });
  assert.strictEqual(r.decision, 'needs_review');
  assert.strictEqual(r.reason, 'score_threshold');
});

test('gates: suppressed email -> blocked', async () => {
  const db = stubDb({
    lead_suppressions: { data: [{ reason: 'unsubscribe_link', channel: 'email', source: 'drip' }], count: 1 },
  });
  const r = await evaluateLeadForAutoSend(db, { tenant: TENANT, lead: GOOD_LEAD, sequence: GOOD_SEQUENCE, capState: CAP_OK });
  assert.strictEqual(r.decision, 'blocked');
  assert.strictEqual(r.reason, 'suppression');
});

test('gate database uncertainty becomes needs_review and never send permission', async () => {
  for (const table of ['customers', 'lead_suppressions', 'leads', 'outreach_sequences', 'drip_enrollments']) {
    const db = stubDb({ [table]: { data: null, count: 0, error: { message: `${table} unavailable` } } });
    const result = await evaluateLeadForAutoSend(db, {
      tenant: TENANT, lead: GOOD_LEAD, sequence: GOOD_SEQUENCE, capState: CAP_OK,
    });
    assert.strictEqual(result.decision, 'needs_review', `${table} read failure must fail closed`);
    assert.strictEqual(result.reason, 'gate_error', `${table} read failure must identify uncertainty`);
  }
});

test('gates: duplicate already-worked email -> blocked', async () => {
  const db = stubDb({
    leads: { data: [{ id: 'other-lead', status: 'contacted' }], count: 1 },
  });
  const r = await evaluateLeadForAutoSend(db, { tenant: TENANT, lead: GOOD_LEAD, sequence: GOOD_SEQUENCE, capState: CAP_OK });
  assert.strictEqual(r.decision, 'blocked');
  assert.strictEqual(r.reason, 'dedupe');
});

test('gates: blocklisted domain -> blocked', async () => {
  const tenant = { ...TENANT, config: { ...TENANT.config, outreach_blocklist: '["rodriguezlandscaping.com"]' } };
  const r = await evaluateLeadForAutoSend(stubDb(), { tenant, lead: GOOD_LEAD, sequence: GOOD_SEQUENCE, capState: CAP_OK });
  assert.strictEqual(r.decision, 'blocked');
  assert.strictEqual(r.reason, 'blocklist');
});

test('gates: missing postal address -> needs_review (compliance)', async () => {
  const tenant = { ...TENANT, config: { autonomous_outreach_enabled: 'true' } };
  const r = await evaluateLeadForAutoSend(stubDb(), { tenant, lead: GOOD_LEAD, sequence: GOOD_SEQUENCE, capState: CAP_OK });
  assert.strictEqual(r.decision, 'needs_review');
  assert.strictEqual(r.reason, 'postal_address_config');
});

test('gates: daily cap exhausted -> skip (transient, no block)', async () => {
  const r = await evaluateLeadForAutoSend(stubDb(), {
    tenant: TENANT, lead: GOOD_LEAD, sequence: GOOD_SEQUENCE,
    capState: { ...CAP_OK, dailyRemaining: 0 },
  });
  assert.strictEqual(r.decision, 'skip');
  assert.strictEqual(r.reason, 'daily_cap');
});

test('gates: deliverability circuit breaker -> skip', async () => {
  const r = await evaluateLeadForAutoSend(stubDb(), {
    tenant: TENANT, lead: GOOD_LEAD, sequence: GOOD_SEQUENCE,
    capState: { ...CAP_OK, deliverabilityPaused: true, detail: 'paused: bounce 6%' },
  });
  assert.strictEqual(r.decision, 'skip');
  assert.strictEqual(r.reason, 'deliverability');
});

test('gates: 10 or more employees -> blocked (exclusive ICP ceiling)', async () => {
  const r = await evaluateLeadForAutoSend(stubDb(), {
    tenant: TENANT, lead: { ...GOOD_LEAD, employee_count: 10, employee_count_actual: 10 }, sequence: GOOD_SEQUENCE, capState: CAP_OK,
  });
  assert.strictEqual(r.decision, 'blocked');
  assert.strictEqual(r.reason, 'icp_fit');
});

test('gates: unknown employee count needs evidence and never auto-sends', async () => {
  const lead = { ...GOOD_LEAD };
  delete lead.employee_count;
  delete lead.employee_count_actual;
  const r = await evaluateLeadForAutoSend(stubDb(), {
    tenant: TENANT, lead, sequence: GOOD_SEQUENCE, capState: CAP_OK,
  });
  assert.strictEqual(r.decision, 'needs_review');
  assert.strictEqual(r.reason, 'employee_evidence');
});

test('restart authority requires a bound, unconsumed candidate and completed tenant batch', async () => {
  const sequence = { id: 'seq-restart', metadata: { restart_batch_id: 'batch-1' } };
  const db = stubDb({
    growth_restart_candidates: {
      data: [{ batch_id: 'batch-1', decision: 'eligible', authorized_at: '2026-09-05T12:00:00Z', first_touch_sequence_id: 'seq-restart', first_touch_sent_at: null }],
      error: null,
    },
    growth_restart_batches: {
      data: [{ id: 'batch-1', status: 'completed', sequence_plan_key: 'wide-net-seven-touch-v1' }],
      error: null,
    },
  });
  const result = await validateRestartAuthorization(db, TENANT.id, GOOD_LEAD.id, sequence);
  assert.strictEqual(result.authorized, true);

  const consumed = await validateRestartAuthorization(stubDb({
    growth_restart_candidates: {
      data: [{ batch_id: 'batch-1', decision: 'eligible', authorized_at: '2026-09-05T12:00:00Z', first_touch_sequence_id: 'seq-restart', first_touch_sent_at: '2026-09-05T13:00:00Z' }],
      error: null,
    },
  }), TENANT.id, GOOD_LEAD.id, sequence);
  assert.strictEqual(consumed.authorized, false);
});

test('gates: already-contacted lead -> skip (first touch only)', async () => {
  const r = await evaluateLeadForAutoSend(stubDb(), {
    tenant: TENANT, lead: { ...GOOD_LEAD, status: 'contacted' }, sequence: GOOD_SEQUENCE, capState: CAP_OK,
  });
  assert.strictEqual(r.decision, 'skip');
  assert.strictEqual(r.reason, 'lead_state');
});

test('gates: inbound lead (website form) -> blocked, never cold-pitched', async () => {
  for (const source of ['website_contact', 'website_contact_form', 'web_chat', 'missed_call', 'voice_receptionist', null, undefined, 'anything_unknown']) {
    const r = await evaluateLeadForAutoSend(stubDb(), {
      tenant: TENANT, lead: { ...GOOD_LEAD, lead_source: source }, sequence: GOOD_SEQUENCE, capState: CAP_OK,
    });
    assert.strictEqual(r.decision, 'blocked', `source=${source} must be blocked`);
    assert.strictEqual(r.reason, 'inbound_lead', `source=${source} must fail the inbound_lead gate`);
  }
});

test('gates: prospect sources pass the inbound gate', async () => {
  for (const source of ['manual', 'prospecting_agent', 'targeted_campaign_agent']) {
    const r = await evaluateLeadForAutoSend(stubDb(), {
      tenant: TENANT, lead: { ...GOOD_LEAD, lead_source: source }, sequence: GOOD_SEQUENCE, capState: CAP_OK,
    });
    assert.notStrictEqual(r.reason, 'inbound_lead', `source=${source} must not be treated as inbound`);
  }
});

test('gates: invalid email -> blocked', async () => {
  const r = await evaluateLeadForAutoSend(stubDb(), {
    tenant: TENANT, lead: { ...GOOD_LEAD, email: 'not-an-email' }, sequence: GOOD_SEQUENCE, capState: CAP_OK,
  });
  assert.strictEqual(r.decision, 'blocked');
  assert.strictEqual(r.reason, 'valid_email');
});

test('gates: weak cached draft quality -> needs_review', async () => {
  const seq = { ...GOOD_SEQUENCE, metadata: { autosend_quality: { ok: false, score: 40, problems: ['generic'], judged_by: 'claude' } } };
  const r = await evaluateLeadForAutoSend(stubDb(), { tenant: TENANT, lead: GOOD_LEAD, sequence: seq, capState: CAP_OK });
  assert.strictEqual(r.decision, 'needs_review');
  assert.strictEqual(r.reason, 'draft_quality');
});
