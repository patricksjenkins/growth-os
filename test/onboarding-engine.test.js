'use strict';

/**
 * The onboarding engine, tested by running it.
 *
 * CONTEXT (2026-07-30). Before this file there were zero behavioural tests of
 * this engine. The one test that mentioned it read `integrations/stripe.js` as
 * a STRING and asserted that the substring "startOnboarding" appeared before
 * the substring "sendWelcomeWizard". That passes whether or not the code runs.
 *
 * It also passed for the entire period in which `onboarding_workflows` had
 * zero rows in production — the engine had never executed, for any tenant,
 * ever, and every test was green.
 *
 * So: everything here calls the real functions against a fake Supabase and
 * asserts on what they actually wrote.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const {
  startOnboarding,
  advanceOnboarding,
  getOnboardingStatus,
  resolveWorkflowSteps,
} = require('../core/onboarding');

// --- a Supabase stand-in that records writes -------------------------------

function fakeDb(seed = {}) {
  const tables = {
    tenants: seed.tenants || [],
    onboarding_workflows: [],
    onboarding_steps: [],
    tenant_config: seed.tenant_config || [],
    tenant_modules: seed.tenant_modules || [],
    activity_log: [],
    scheduled_emails: [],
  };
  let idSeq = 0;

  // A Supabase query builder is LAZY: `.update(patch).eq('id', x)` must not
  // touch anything until it is awaited, because the filter arrives after the
  // patch. An eager fake silently patches every row in the table and makes
  // broken code look correct — which is exactly the kind of false green this
  // file exists to prevent.
  function make(name) {
    const filters = [];
    let pendingPatch = null;
    let inserted = null;

    function matching(source) {
      return source.filter((r) => filters.every((f) => f(r)));
    }

    function run() {
      if (inserted) return { data: inserted, error: null };
      if (pendingPatch) {
        const hit = matching(tables[name]);
        hit.forEach((r) => Object.assign(r, pendingPatch));
        return { data: hit, error: null };
      }
      return { data: matching(tables[name]), error: null };
    }

    const api = {
      select() { return api; },
      order()  { return api; },
      limit()  { return api; },
      eq(col, val)  { filters.push((r) => r[col] === val); return api; },
      in(col, vals) { filters.push((r) => vals.includes(r[col])); return api; },
      insert(payload) {
        const list = Array.isArray(payload) ? payload : [payload];
        inserted = list.map((r) => ({ id: `${name}-${++idSeq}`, ...r }));
        tables[name].push(...inserted);
        return api;
      },
      upsert(payload) { return api.insert(payload); },
      update(patch) { pendingPatch = patch; return api; },
      single()      { const r = run(); return Promise.resolve({ data: r.data[0] || null, error: r.error }); },
      maybeSingle() { const r = run(); return Promise.resolve({ data: r.data[0] || null, error: r.error }); },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    return api;
  }

  return { from: make, _tables: tables };
}

const TENANT = 'tenant-1';
const seedTenant = () => ({
  tenants: [{ id: TENANT, slug: 'acme', status: 'onboarding', is_demo: false }],
  tenant_modules: [{ tenant_id: TENANT, module: 'lead_capture', enabled: true }],
});

// --- module gating ---------------------------------------------------------

test('a client only gets steps for the modules they bought', () => {
  const bought = ['lead_capture', 'follow_up'];
  const names = resolveWorkflowSteps(bought).map((s) => s.stepName);

  assert.ok(names.includes('configure_followups'), 'they bought follow-up');
  assert.ok(names.includes('import_contacts'), 'they bought lead capture');

  // They did NOT buy these. Seeding them would leave steps pending forever on
  // days 3-5, and advanceOnboarding refuses to move past an unresolved day —
  // so the client would never reach go-live.
  assert.ok(!names.includes('setup_review_triggers'), 'no review requests bought');
  assert.ok(!names.includes('generate_content'), 'no content engine bought');
  assert.ok(!names.includes('send_app_ready'), 'no branded app bought');

  // Steps everyone gets are still there.
  assert.ok(names.includes('go_live'));
  assert.ok(names.includes('founder_video_call'));
});

test('the day-0 welcome email is not sent twice', () => {
  const withFlag = resolveWorkflowSteps([], { welcomeAlreadySent: true }).map((s) => s.stepName);
  const without  = resolveWorkflowSteps([]).map((s) => s.stepName);

  assert.ok(!withFlag.includes('send_welcome_email'),
    'the magic-link welcome already went out — a second one lands seconds later');
  assert.ok(without.includes('send_welcome_email'),
    'without the flag the workflow is still responsible for it');
});

test('startOnboarding seeds the gated set, not all 23 steps', async () => {
  const db = fakeDb(seedTenant());
  await startOnboarding(db, TENANT, {
    business_name: 'Acme', email: 'o@acme.test', vertical: 'home_services',
    modules: ['lead_capture'], welcomeAlreadySent: true,
  });

  const seeded = db._tables.onboarding_steps;
  assert.ok(seeded.length > 0, 'a workflow with no steps is not a workflow');
  assert.ok(seeded.length < 23, `expected a gated subset, got all ${seeded.length}`);
  assert.ok(!seeded.some((s) => s.step_name === 'send_welcome_email'));
  assert.ok(!seeded.some((s) => s.step_name === 'setup_review_triggers'));
});

test('every seeded step records who clears it', async () => {
  const db = fakeDb(seedTenant());
  await startOnboarding(db, TENANT, { modules: ['content_engine'], vertical: 'home_services' });

  const byName = Object.fromEntries(db._tables.onboarding_steps.map((s) => [s.step_name, s]));
  assert.strictEqual(byName.founder_video_call.kind, 'founder');
  assert.strictEqual(byName.client_photo_upload.kind, 'customer');
  assert.strictEqual(byName.go_live.kind, 'automated');
});

// --- failure honesty -------------------------------------------------------

test('a step that cannot do its job is NOT marked completed', async () => {
  const db = fakeDb(seedTenant());
  await startOnboarding(db, TENANT, {
    modules: ['lead_capture'], vertical: 'home_services', welcomeAlreadySent: true,
  });

  // Actually RUN the day-2 steps. import_contacts has no importer yet, so it
  // must come out of the runner as blocked with a reason. An earlier version
  // of this test only inspected the seeded row, which is still 'pending' at
  // this point — so it passed no matter what the runner did. Mutation testing
  // caught it: flipping the failure branch to 'completed' broke nothing.
  const { _runAutomatedSteps } = require('../core/onboarding')._internals;
  const wf = db._tables.onboarding_workflows[0];
  await _runAutomatedSteps(db, TENANT, wf.id, 2);

  const imported = db._tables.onboarding_steps.find((s) => s.step_name === 'import_contacts');
  assert.ok(imported, 'import_contacts should be seeded for a lead_capture client');
  assert.notStrictEqual(imported.status, 'completed',
    'a step that did nothing must never report completed');
  assert.strictEqual(imported.status, 'blocked');
  assert.match(imported.last_error, /not automated yet/,
    'and it has to say why, or nobody can act on it');
});

test('a step that throws a real error is recorded as failed, with the reason', async () => {
  const db = fakeDb(seedTenant());

  // Patch BEFORE starting: startOnboarding runs the day-0 steps itself as its
  // last act, so a patch applied afterwards would arrive too late and the test
  // would assert against an already-completed step.
  //
  // send_intake_form is a real handler. Make the send blow up the way a
  // provider outage would, and confirm the failure is persisted rather than
  // swallowed into a green step.
  const emailMod = require('../integrations/email');
  const original = emailMod.sendTemplateEmail;
  emailMod.sendTemplateEmail = async () => { throw new Error('resend refused the send'); };
  try {
    await startOnboarding(db, TENANT, {
      modules: [], vertical: 'home_services', welcomeAlreadySent: true,
      email: 'owner@acme.test',
    });

    const step = db._tables.onboarding_steps.find((s) => s.step_name === 'send_intake_form');
    assert.strictEqual(step.status, 'failed',
      'a provider outage must not leave the step looking successful');
    assert.match(step.last_error, /resend refused the send/);
    assert.strictEqual(step.attempts, 1, 'attempts must be counted for retry');
  } finally {
    emailMod.sendTemplateEmail = original;
  }
});

test('an unresolved step blocks the day from advancing', async () => {
  const db = fakeDb(seedTenant());
  await startOnboarding(db, TENANT, { modules: [], vertical: 'home_services' });

  // Force the exact state the old code walked straight past: a failed step.
  const steps = db._tables.onboarding_steps;
  steps.forEach((s) => { s.status = 'completed'; });
  const victim = steps.find((s) => s.day === 0);
  victim.status = 'failed';
  victim.last_error = 'telnyx said no';

  const out = await advanceOnboarding(db, TENANT);
  assert.strictEqual(out.advanced, false, 'a failed step must stop the timeline');
  assert.ok(out.blockedBy.some((b) => b.error === 'telnyx said no'),
    'and it must say why, or nobody can fix it');
});

test('a skipped step does not block — it is a decision, not a failure', async () => {
  const db = fakeDb(seedTenant());
  await startOnboarding(db, TENANT, { modules: [], vertical: 'home_services' });

  const steps = db._tables.onboarding_steps;
  steps.forEach((s) => { s.status = s.day === 0 ? 'completed' : 'pending'; });
  steps.find((s) => s.day === 0).status = 'skipped';

  const out = await advanceOnboarding(db, TENANT);
  assert.strictEqual(out.advanced, true, 'skipped is resolved; the day should move');
});

test('a database read failure does not read as "all steps done"', async () => {
  const db = fakeDb(seedTenant());
  await startOnboarding(db, TENANT, { modules: [], vertical: 'home_services' });

  // Make the steps read fail the way a transient outage would.
  const realFrom = db.from;
  db.from = (name) => {
    if (name !== 'onboarding_steps') return realFrom(name);
    const q = {
      select: () => q, eq: () => q, order: () => q, limit: () => q,
      then: (res) => Promise.resolve({ data: null, error: { message: 'connection reset' } }).then(res),
    };
    return q;
  };

  // Zero rows read used to make every count zero, and zero pending was
  // indistinguishable from finished — so the workflow completed itself on an
  // outage. It must raise instead.
  await assert.rejects(() => getOnboardingStatus(db, TENANT), /connection reset/);
});

// --- go_live ---------------------------------------------------------------

test('an email step with no recipient fails instead of quietly passing', async () => {
  const db = fakeDb(seedTenant());
  // No `email` on the intake at all — the state a workflow lands in when the
  // owner address never got recorded.
  await startOnboarding(db, TENANT, {
    modules: [], vertical: 'home_services', welcomeAlreadySent: true,
  });

  const { _runAutomatedSteps } = require('../core/onboarding')._internals;
  await _runAutomatedSteps(db, TENANT, db._tables.onboarding_workflows[0].id, 0);

  const step = db._tables.onboarding_steps.find((s) => s.step_name === 'send_intake_form');
  assert.strictEqual(step.status, 'failed',
    'six email steps used to report completed while sending nothing');
  assert.match(step.last_error, /no client email/);
});

test('go_live actually flips the tenant to active', async () => {
  const db = fakeDb(seedTenant());
  await startOnboarding(db, TENANT, { modules: [], vertical: 'home_services' });

  const step = { id: 'x', step_name: 'go_live', tenant_id: TENANT };
  const { _executeStepHandler } = require('../core/onboarding')._internals;
  await _executeStepHandler(db, TENANT, step);

  assert.strictEqual(db._tables.tenants[0].status, 'active',
    'the scheduler only runs agents for active tenants — without this flip the '
    + 'client gets no content, no follow-ups, and no review requests');
});

test('go_live refuses to claim success if the flip did not stick', async () => {
  const db = fakeDb(seedTenant());
  const realFrom = db.from;
  db.from = (name) => {
    if (name !== 'tenants') return realFrom(name);
    const q = {
      _mode: null,
      select() { return q; },
      eq() { return q; },
      update() { q._mode = 'update'; return q; },
      // The update silently affects nothing, and the read-back still says
      // 'onboarding'.
      maybeSingle: () => Promise.resolve({
        data: { status: 'onboarding', slug: 'acme' }, error: null,
      }),
      then: (res) => Promise.resolve({ data: [], error: null }).then(res),
    };
    return q;
  };

  const { _executeStepHandler } = require('../core/onboarding')._internals;
  await assert.rejects(
    () => _executeStepHandler(db, TENANT, { id: 'x', step_name: 'go_live', tenant_id: TENANT }),
    /did not stick/,
    'an update that matched no rows does not error — it must be read back',
  );
});

test('a demo tenant is never onboarded', async () => {
  const db = fakeDb({ tenants: [{ id: TENANT, slug: 'demo-apex', status: 'onboarding', is_demo: true }] });
  const { _executeStepHandler } = require('../core/onboarding')._internals;
  await assert.rejects(
    () => _executeStepHandler(db, TENANT, { id: 'x', step_name: 'create_tenant', tenant_id: TENANT }),
    /demo/,
  );
});
