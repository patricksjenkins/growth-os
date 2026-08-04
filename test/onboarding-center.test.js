'use strict';

/**
 * The Onboarding Center: manual, with assistance.
 *
 * THE RULE (Patrick, 2026-08-02): nothing goes out on its own. Every step is
 * staged and waits for a click. If a customer received something, he sent it.
 *
 * The tests that matter most here are the negative ones — that previewing an
 * email sends nothing, and that creating a tenant sends nothing. Those are the
 * promises that would be quietly broken by a refactor, and a customer would be
 * the one to find out.
 */

const { test } = require('node:test');
const assert = require('node:assert');

// integrations/stripe.js constructs its client at module load, so requiring it
// without a key throws before any test runs. Nothing here ever reaches Stripe
// — every call that would touch a customer's card is stubbed and asserted on —
// but the module still has to be loadable to stub it.
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder_for_tests';

const center = require('../core/onboarding-center');
const onboarding = require('../core/onboarding');

// --- lazy fake Supabase (same contract as the engine tests) ----------------

function fakeDb(seed = {}) {
  const tables = {
    tenants: seed.tenants || [],
    onboarding_workflows: [],
    onboarding_steps: [],
    tenant_config: seed.tenant_config || [],
    tenant_modules: seed.tenant_modules || [],
    tenant_integrations: [],
    activity_log: [],
    scheduled_emails: [],
    leads: [],
    agent_jobs: [],
  };
  let idSeq = 0;
  function make(name) {
    const filters = [];
    let patch = null;
    let inserted = null;
    const matching = (src) => src.filter((r) => filters.every((f) => f(r)));
    function run() {
      if (inserted) return { data: inserted, error: null };
      if (patch) {
        const hit = matching(tables[name]);
        hit.forEach((r) => Object.assign(r, patch));
        return { data: hit, error: null };
      }
      return { data: matching(tables[name]), error: null };
    }
    const api = {
      select: () => api, order: () => api, limit: () => api,
      eq(c, v) { filters.push((r) => r[c] === v); return api; },
      in(c, v) { filters.push((r) => v.includes(r[c])); return api; },
      // The claim's stale-takeover condition. NULL never satisfies a
      // comparison in Postgres, and the fake has to agree or a test would pass
      // against behaviour the database does not have.
      lt(c, v) { filters.push((r) => r[c] != null && r[c] < v); return api; },
      neq(c, v) { filters.push((r) => r[c] !== v); return api; },
      insert(p) {
        const list = Array.isArray(p) ? p : [p];
        inserted = list.map((r) => ({ id: `${name}-${++idSeq}`, ...r }));
        tables[name].push(...inserted);
        return api;
      },
      upsert(p) { return api.insert(p); },
      update(p) { patch = p; return api; },
      single() { const r = run(); return Promise.resolve({ data: r.data[0] || null, error: r.error }); },
      maybeSingle() { const r = run(); return Promise.resolve({ data: r.data[0] || null, error: r.error }); },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    return api;
  }
  return { from: make, _tables: tables };
}

const TENANT = 'tenant-1';
const seed = () => ({
  tenants: [{ id: TENANT, slug: 'acme', status: 'onboarding', is_demo: false }],
  tenant_modules: [{ tenant_id: TENANT, module: 'lead_capture', enabled: true }],
  tenant_config: [{ tenant_id: TENANT, key: 'owner_email', value: 'owner@acme.test' }],
});

/** Count every email the integration is asked to send, from any path. */
function countSends(fn) {
  const mod = require('../integrations/email');
  const originals = {};
  let sends = 0;
  for (const k of Object.keys(mod)) {
    if (typeof mod[k] === 'function' && /^send/.test(k)) {
      originals[k] = mod[k];
      mod[k] = async () => { sends += 1; return { status: 'counted' }; };
    }
  }
  return Promise.resolve(fn()).finally(() => Object.assign(mod, originals)).then((r) => ({ sends, result: r }));
}

const deps = () => ({
  ctxLoader: onboarding.loadCenterContext,
  executeHandler: onboarding._internals._executeStepHandler,
  NotImplementedStep: onboarding.NotImplementedStep,
  WaitingOnPerson: onboarding.WaitingOnPerson,
  AlreadySettled: onboarding.AlreadySettled,
});

// --- the promise: nothing fires by itself ----------------------------------

test('creating the workflow sends NOTHING', async () => {
  const db = fakeDb(seed());
  const { sends } = await countSends(() =>
    onboarding.startOnboarding(db, TENANT, {
      business_name: 'Acme', email: 'owner@acme.test', vertical: 'home_services',
      modules: ['lead_capture'],
    }));

  // This used to run the day-0 steps as its last act, so creating a tenant
  // emailed the customer as a side effect.
  assert.strictEqual(sends, 0, 'seeding the checklist must not email anyone');
  const steps = db._tables.onboarding_steps;
  assert.ok(steps.length > 0, 'but it must still seed the checklist');
  assert.ok(steps.every((s) => s.status === 'pending'),
    'every step waits for a click');
});

test('previewing an email sends nothing and changes nothing', async () => {
  const db = fakeDb(seed());
  await onboarding.startOnboarding(db, TENANT, {
    business_name: 'Acme', email: 'owner@acme.test', vertical: 'home_services',
    modules: ['lead_capture'],
  });
  const step = db._tables.onboarding_steps.find((s) => s.step_name === 'send_welcome_email');
  const before = JSON.stringify(step);

  const { sends, result: preview } = await countSends(() =>
    center.previewStep(db, TENANT, step, onboarding.loadCenterContext));

  assert.strictEqual(sends, 0, 'a preview that sends is not a preview');
  assert.strictEqual(JSON.stringify(step), before, 'and it must not touch the step');
  assert.strictEqual(preview.kind, 'email');
  assert.ok(preview.subject, 'it has to show the subject');
  assert.ok(preview.html && preview.html.length > 100, 'and the rendered body');
  assert.strictEqual(preview.to, 'owner@acme.test');
});

test('the preview shows the same subject the send would use', async () => {
  const emailMod = require('../integrations/email');
  const db = fakeDb(seed());
  await onboarding.startOnboarding(db, TENANT, {
    email: 'owner@acme.test', vertical: 'home_services', modules: ['lead_capture'],
  });
  const step = db._tables.onboarding_steps.find((s) => s.step_name === 'send_intake_form');
  const preview = await center.previewStep(db, TENANT, step, onboarding.loadCenterContext);

  // A second copy of the subject map in the preview layer would drift, and the
  // preview would start lying about what goes out.
  assert.strictEqual(preview.subject, 'Next step: your setup form');

  // The welcome is its own email now — the wizard template with the magic
  // login link — and its preview subject must be that template's.
  const welcome = db._tables.onboarding_steps.find((s) => s.step_name === 'send_welcome_email');
  const wPreview = await center.previewStep(db, TENANT, welcome, onboarding.loadCenterContext);
  assert.strictEqual(wPreview.subject, emailMod.subjectFor('welcome-wizard'));
  const { WELCOME_LINK_SENTINEL } = require('../core/welcome-wizard');
  assert.ok(wPreview.html.includes(WELCOME_LINK_SENTINEL),
    'the preview must show where the login link goes');
});

test('no onboarding email carries the retired brand', () => {
  const emailMod = require('../integrations/email');
  for (const template of Object.values(center.EMAIL_STEPS)) {
    assert.doesNotMatch(emailMod.subjectFor(template), /growth os/i,
      `${template} subject still says the old working title`);
  }
});

// --- running is the only thing that sends ----------------------------------

test('running a send step is what actually sends', async () => {
  const db = fakeDb(seed());
  await onboarding.startOnboarding(db, TENANT, {
    email: 'owner@acme.test', vertical: 'home_services', modules: ['lead_capture'],
  });
  const step = db._tables.onboarding_steps.find((s) => s.step_name === 'send_intake_form');

  const { sends, result } = await countSends(() =>
    center.runStep(db, TENANT, step, {}, deps()));

  assert.strictEqual(sends, 1, 'exactly one email');
  assert.strictEqual(result.status, 'completed');
  assert.strictEqual(step.status, 'completed');
  assert.strictEqual(result.evidence.to, 'owner@acme.test');
});

test('an edited subject and body are what get sent', async () => {
  const emailMod = require('../integrations/email');
  const original = emailMod.sendEmail;
  let captured = null;
  emailMod.sendEmail = async (to, subject, html) => { captured = { to, subject, html }; return { id: 'x' }; };
  try {
    const db = fakeDb(seed());
    await onboarding.startOnboarding(db, TENANT, {
      email: 'owner@acme.test', vertical: 'home_services', modules: ['lead_capture'],
    });
    const step = db._tables.onboarding_steps.find((s) => s.step_name === 'send_intake_form');

    await center.runStep(db, TENANT, step, {
      subject: 'Jane — welcome aboard',
      html: '<p>Rewrote this myself.</p>',
    }, deps());

    assert.strictEqual(captured.subject, 'Jane — welcome aboard');
    assert.strictEqual(captured.html, '<p>Rewrote this myself.</p>');
  } finally {
    emailMod.sendEmail = original;
  }
});

test('re-clicking a finished step does not send a second time', async () => {
  const db = fakeDb(seed());
  await onboarding.startOnboarding(db, TENANT, {
    email: 'owner@acme.test', vertical: 'home_services', modules: ['lead_capture'],
  });
  const step = db._tables.onboarding_steps.find((s) => s.step_name === 'send_intake_form');

  await countSends(() => center.runStep(db, TENANT, step, {}, deps()));
  const { sends } = await countSends(() => center.runStep(db, TENANT, step, {}, deps()));

  assert.strictEqual(sends, 0, 'a double-click must not email the customer twice');
});

/*
 * THE RACE THE PREVIOUS TEST MISSED.
 *
 * "re-clicking a finished step" above passes the SAME step object to both
 * calls. By the second call that object has already been mutated to
 * 'completed', so it only ever exercises the completed-early-return — the
 * claim is never reached. The suite was green while two overlapping requests
 * sent two emails.
 *
 * A real second request re-reads the row from the database. When it reads
 * AFTER the first request has claimed, it sees status='in_progress' — and the
 * claim used to be conditioned on the status the caller had read, so
 * in_progress -> in_progress matched and it sent again.
 */
test('a second request that reads the step mid-run does not send again', async () => {
  const db = fakeDb(seed());
  await onboarding.startOnboarding(db, TENANT, {
    email: 'owner@acme.test', vertical: 'home_services', modules: ['lead_capture'],
  });
  const row = () => db._tables.onboarding_steps.find((s) => s.step_name === 'send_intake_form');

  // Request A claims the step. Snapshot it the way a route handler would —
  // a plain copy, not the live row.
  const a = { ...row() };
  await db.from('onboarding_steps')
    .update({ status: 'in_progress', claimed_at: new Date().toISOString() })
    .eq('id', a.id);

  // Request B now reads the row. It sees in_progress, because A holds it.
  const b = { ...row() };
  assert.strictEqual(b.status, 'in_progress', 'B must observe the claim, or this proves nothing');

  const { sends, result } = await countSends(() => center.runStep(db, TENANT, b, {}, deps()));

  assert.strictEqual(sends, 0, 'a request arriving mid-run must not send a second email');
  assert.notStrictEqual(result.status, 'completed',
    'and it must not report success for something it did not do');
});

test('a claim abandoned by a crashed process can be taken over', async () => {
  // The other side of the same coin: refusing every in_progress claim would
  // strand a step whose process died mid-send, unclickable forever.
  const db = fakeDb(seed());
  await onboarding.startOnboarding(db, TENANT, {
    email: 'owner@acme.test', vertical: 'home_services', modules: ['lead_capture'],
  });
  const row = () => db._tables.onboarding_steps.find((s) => s.step_name === 'send_intake_form');

  const longAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // an hour
  await db.from('onboarding_steps')
    .update({ status: 'in_progress', claimed_at: longAgo })
    .eq('id', row().id);

  const { sends, result } = await countSends(() =>
    center.runStep(db, TENANT, { ...row() }, {}, deps()));

  assert.strictEqual(sends, 1, 'a dead claim must be recoverable');
  assert.strictEqual(result.status, 'completed');
});

test('two callers racing a stale claim: only one takes it', async () => {
  const db = fakeDb(seed());
  await onboarding.startOnboarding(db, TENANT, {
    email: 'owner@acme.test', vertical: 'home_services', modules: ['lead_capture'],
  });
  const row = () => db._tables.onboarding_steps.find((s) => s.step_name === 'send_intake_form');

  const longAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  await db.from('onboarding_steps')
    .update({ status: 'in_progress', claimed_at: longAgo })
    .eq('id', row().id);

  // Both read the same stale row, then both try to recover it.
  const one = { ...row() };
  const two = { ...row() };
  const { sends } = await countSends(() => Promise.all([
    center.runStep(db, TENANT, one, {}, deps()),
    center.runStep(db, TENANT, two, {}, deps()),
  ]));

  assert.strictEqual(sends, 1, 'recovery must be exclusive too, or it just moves the race');
});

/*
 * THE DOUBLE-BILL, THROUGH THE REAL HANDLER.
 *
 * test/stripe-reconcile.test.js proves the reconciliation reads Stripe
 * correctly. This proves the money steps actually CONSULT it — the reconcile
 * module could be perfect and still never be called.
 *
 * The customer here bought through a Payment Link, so Stripe has their $199
 * and their subscription, and tenant_config has neither.
 */
function withStripeStubs({ alreadyBilled = false, alreadySubscribed = false }, fn) {
  const reconcile = require('../core/stripe-reconcile');
  const stripeInt = require('../integrations/stripe');
  const saved = {
    setupFeeAlreadyBilled: reconcile.setupFeeAlreadyBilled,
    subscriptionAlreadyExists: reconcile.subscriptionAlreadyExists,
    sendSetupFeeInvoice: stripeInt.sendSetupFeeInvoice,
    startTrialSubscription: stripeInt.startTrialSubscription,
    createCustomer: stripeInt.createCustomer,
  };
  const charged = [];

  reconcile.setupFeeAlreadyBilled = async () => (alreadyBilled
    ? { billed: true, evidence: { source: 'stripe_checkout', session_id: 'cs_1', amount_usd: 199, created: '2026-07-30T00:00:00.000Z' } }
    : { billed: false, evidence: null });
  reconcile.subscriptionAlreadyExists = async () => (alreadySubscribed
    ? { exists: true, subscription: { subscription_id: 'sub_live', status: 'trialing', first_charge_date: '2026-08-13', monthly_usd: 249, created: '2026-07-30T00:00:00.000Z' } }
    : { exists: false, subscription: null });

  // Anything that would REACH the customer's card records itself loudly.
  stripeInt.sendSetupFeeInvoice = async () => {
    charged.push('setup_invoice');
    return { invoice_id: 'in_new', hosted_url: 'https://x', amount_usd: 199, status: 'open' };
  };
  stripeInt.startTrialSubscription = async () => {
    charged.push('subscription');
    return { subscription_id: 'sub_new', monthly_usd: 249, first_charge_date: '2026-08-20' };
  };
  stripeInt.createCustomer = async () => ({ id: 'cus_1' });

  return Promise.resolve(fn(charged)).finally(() => Object.assign(reconcile, {
    setupFeeAlreadyBilled: saved.setupFeeAlreadyBilled,
    subscriptionAlreadyExists: saved.subscriptionAlreadyExists,
  }) && Object.assign(stripeInt, {
    sendSetupFeeInvoice: saved.sendSetupFeeInvoice,
    startTrialSubscription: saved.startTrialSubscription,
    createCustomer: saved.createCustomer,
  }));
}

async function centerWithCustomer() {
  const db = fakeDb(seed());
  await onboarding.startOnboarding(db, TENANT, {
    email: 'owner@acme.test', vertical: 'home_services', modules: ['lead_capture'],
  });
  // They came in through the pricing page, so we know their Stripe customer.
  db._tables.tenant_config.push(
    { tenant_id: TENANT, key: 'stripe_customer_id', value: 'cus_1' },
    { tenant_id: TENANT, key: 'tier', value: 'growth' },
  );
  return db;
}

test('a customer who paid at checkout is NOT invoiced a second $199', async () => {
  const db = await centerWithCustomer();
  const step = db._tables.onboarding_steps.find((s) => s.step_name === 'send_setup_invoice');

  await withStripeStubs({ alreadyBilled: true }, async (charged) => {
    const result = await center.runStep(db, TENANT, step, {}, deps());
    assert.deepStrictEqual(charged, [], 'NOTHING may be invoiced — they already paid');
    assert.strictEqual(result.status, 'completed',
      'and it must read as done, not failed: a red money step invites a re-click');
    assert.match(result.detail, /already paid/i);
  });
});

test('a customer who subscribed at checkout does NOT get a second subscription', async () => {
  const db = await centerWithCustomer();
  const step = db._tables.onboarding_steps.find((s) => s.step_name === 'start_subscription');

  await withStripeStubs({ alreadySubscribed: true }, async (charged) => {
    const result = await center.runStep(db, TENANT, step, {}, deps());
    assert.deepStrictEqual(charged, [],
      'a duplicate subscription bills them every month, forever');
    assert.strictEqual(result.status, 'completed');

    // It ADOPTS the existing one, so the tenant now points at the real
    // subscription rather than at nothing.
    const cfg = Object.fromEntries(
      db._tables.tenant_config.filter((c) => c.tenant_id === TENANT).map((c) => [c.key, c.value]),
    );
    assert.strictEqual(cfg.stripe_subscription_id, 'sub_live');
    assert.strictEqual(cfg.subscription_first_charge, '2026-08-13');
  });
});

test('a customer who has paid nothing IS invoiced', async () => {
  // The guard must not be so broad it stops the normal path.
  const db = await centerWithCustomer();
  const step = db._tables.onboarding_steps.find((s) => s.step_name === 'send_setup_invoice');

  await withStripeStubs({ alreadyBilled: false }, async (charged) => {
    const result = await center.runStep(db, TENANT, step, {}, deps());
    assert.deepStrictEqual(charged, ['setup_invoice'], 'a real new client still gets their invoice');
    assert.strictEqual(result.status, 'completed');
  });
});

test('a human step is ticked off, not executed', async () => {
  const db = fakeDb(seed());
  await onboarding.startOnboarding(db, TENANT, {
    email: 'owner@acme.test', vertical: 'home_services', modules: ['content_engine'],
  });
  const step = db._tables.onboarding_steps.find((s) => s.step_name === 'founder_video_call');
  assert.strictEqual(step.kind, 'founder');

  const { sends, result } = await countSends(() => center.runStep(db, TENANT, step, {}, deps()));
  assert.strictEqual(sends, 0);
  assert.strictEqual(result.status, 'completed');
});

// --- warnings inform, they do not refuse -----------------------------------

test('going live with nothing enabled warns but is still allowed', () => {
  const w = center.warningsFor('go_live', { config: {}, modules: new Set() });
  assert.ok(w.some((x) => /no modules/i.test(x)), 'it has to say what is missing');
  // The 923A shape.
  const w2 = center.warningsFor('go_live', {
    config: { preflight_passed_at: 'x' },
    modules: new Set(['content_engine']),
  });
  assert.ok(w2.some((x) => /never publish/i.test(x)));
});

test('the one step that causes a later send says so', () => {
  const w = center.warningsFor('schedule_checkins', {});
  assert.ok(w.some((x) => /on their own/i.test(x)),
    'queuing the check-ins is the only thing that sends without another click — say it');
});

test('warnings are advisory — nothing here refuses', () => {
  // Every warning is a string. There is no blocking flag to accidentally
  // start honouring.
  for (const stepName of ['go_live', 'generate_content', 'provision_phone_number']) {
    const w = center.warningsFor(stepName, { config: {}, modules: new Set() });
    assert.ok(Array.isArray(w) && w.every((x) => typeof x === 'string'));
  }
});

// --- the money steps -------------------------------------------------------

/*
 * Stripe invoicing existed as library code with no callers until 2026-08-02 —
 * built, tested against live Stripe, and reachable by nobody. These assert it
 * is actually a step Patrick can run, and that the guards around real money
 * hold.
 */

test('the invoice and subscription are steps on the checklist', () => {
  const names = onboarding.resolveWorkflowSteps(['lead_capture']).map((s) => s.stepName);
  assert.ok(names.includes('send_setup_invoice'), 'invoicing must be runnable, not library code');
  assert.ok(names.includes('start_subscription'));
  // Order matters: a trial needs a card, and they only get one by paying.
  assert.ok(names.indexOf('send_setup_invoice') < names.indexOf('start_subscription'));
});

test('both money steps say what they will do before you click', () => {
  for (const k of ['send_setup_invoice', 'start_subscription']) {
    const d = center.ACTION_DESCRIPTIONS[k];
    assert.ok(d && d.length > 40, `${k} must describe itself`);
  }
  assert.match(center.ACTION_DESCRIPTIONS.send_setup_invoice, /\$199/);
  assert.match(center.ACTION_DESCRIPTIONS.send_setup_invoice, /monthly is NOT on it|14-day/i);
  assert.match(center.ACTION_DESCRIPTIONS.start_subscription, /day 15/);
});

test('the invoice step warns that it sends real money movement', () => {
  const w = center.warningsFor('send_setup_invoice', { config: {}, modules: new Set() });
  assert.ok(w.some((x) => /real invoice/i.test(x)), 'spending real money deserves saying so');
  assert.ok(w.some((x) => /nobody to invoice/i.test(x)), 'and no email means no invoice');
});

test('the subscription step warns what it will start billing', () => {
  const growth = center.warningsFor('start_subscription', { config: { tier: 'growth' }, modules: new Set() });
  assert.ok(growth.some((x) => /\$249\/mo/.test(x)));
  const scale = center.warningsFor('start_subscription', { config: { tier: 'scale' }, modules: new Set() });
  assert.ok(scale.some((x) => /\$399\/mo/.test(x)));
  // And that it cannot work before the invoice.
  assert.ok(growth.some((x) => /send the setup invoice first/i.test(x)));
});

test('an already-sent invoice warns rather than silently re-billing', () => {
  const w = center.warningsFor('send_setup_invoice', {
    config: { setup_invoice_id: 'in_123', owner_email: 'o@x.test' }, modules: new Set(),
  });
  assert.ok(w.some((x) => /already been sent/i.test(x)));
});

test('the retired chargers refuse rather than bill from archived prices', async () => {
  // integrations/stripe builds its client at require time, so it needs a key
  // present. Nothing here reaches Stripe: both functions throw before any API
  // call, which is the point.
  const prev = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = prev || 'sk_test_placeholder_for_module_load';
  try {
    const stripe = require('../integrations/stripe');
    // These read STRIPE_PRICE_* env vars that pointed at archived prices with
    // the wrong amounts ($1,000 setup against a published $199). They are
    // still exported, so they must refuse rather than charge.
    await assert.rejects(() => stripe.createSetupFeeCharge('cus_x'), /retired/);
    await assert.rejects(() => stripe.createSubscription('cus_x', 'growth'), /retired/);
  } finally {
    if (prev === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = prev;
  }
});

/*
 * THE WELCOME, THROUGH THE CENTER — the fix for "Onboard this client sends".
 *
 * Provisioning no longer sends anything. The welcome step in the Center is
 * the one and only sender of the email that creates the customer's login,
 * and it goes through sendWelcomeFromCenter (auth user + membership + fresh
 * magic link) rather than the generic template path.
 */

test('the welcome step sends through sendWelcomeFromCenter, once', async () => {
  const db = fakeDb(seed());
  await onboarding.startOnboarding(db, TENANT, {
    email: 'owner@acme.test', owner_name: 'Jane', business_name: 'Acme',
    vertical: 'home_services', modules: ['lead_capture'],
  });
  const step = db._tables.onboarding_steps.find((s) => s.step_name === 'send_welcome_email');
  assert.ok(step, 'admin provisioning must leave the welcome step on the checklist');

  const calls = [];
  const result = await center.runStep(db, TENANT, step, {}, {
    ...deps(),
    sendWelcome: async (supabase, args) => { calls.push(args); return { delivered: true, emailResult: { id: 'em_1' } }; },
  });

  assert.strictEqual(calls.length, 1, 'exactly one welcome');
  assert.strictEqual(calls[0].email, 'owner@acme.test');
  assert.strictEqual(result.status, 'completed');
});

test('a second click on a delivered welcome does not resend', async () => {
  // The crash-retry shape: provider accepted, then the completion mark failed.
  // The step row says failed; the evidence says delivered. Evidence wins.
  const db = fakeDb(seed());
  await onboarding.startOnboarding(db, TENANT, {
    email: 'owner@acme.test', vertical: 'home_services', modules: ['lead_capture'],
  });
  const step = db._tables.onboarding_steps.find((s) => s.step_name === 'send_welcome_email');

  db._tables.tenant_config.push({
    tenant_id: TENANT, key: 'email_evidence_send_welcome_email',
    value: { to: 'owner@acme.test', id: 'em_1', at: '2026-08-03T00:00:00.000Z' },
  });
  step.status = 'failed'; // the mark never landed

  const calls = [];
  const result = await center.runStep(db, TENANT, { ...step }, {}, {
    ...deps(),
    sendWelcome: async () => { calls.push(1); return { delivered: true, emailResult: { id: 'em_2' } }; },
  });

  assert.strictEqual(calls.length, 0, 'the customer already has this email — do not send it twice');
  assert.strictEqual(result.status, 'completed');
  assert.match(result.detail, /not resending/i);
});

test('force IS a deliberate resend and bypasses the evidence', async () => {
  const db = fakeDb(seed());
  await onboarding.startOnboarding(db, TENANT, {
    email: 'owner@acme.test', vertical: 'home_services', modules: ['lead_capture'],
  });
  const step = db._tables.onboarding_steps.find((s) => s.step_name === 'send_welcome_email');
  db._tables.tenant_config.push({
    tenant_id: TENANT, key: 'email_evidence_send_welcome_email',
    value: { to: 'owner@acme.test', id: 'em_1', at: '2026-08-03T00:00:00.000Z' },
  });

  const calls = [];
  await center.runStep(db, TENANT, { ...step }, { force: true }, {
    ...deps(),
    sendWelcome: async () => { calls.push(1); return { delivered: true, emailResult: { id: 'em_2' } }; },
  });
  assert.strictEqual(calls.length, 1, 'force means Patrick asked for the resend');
});

test('a generic email step also refuses to resend after a failed completion mark', async () => {
  const db = fakeDb(seed());
  await onboarding.startOnboarding(db, TENANT, {
    email: 'owner@acme.test', vertical: 'home_services', modules: ['lead_capture'],
  });
  const step = db._tables.onboarding_steps.find((s) => s.step_name === 'send_intake_form');
  db._tables.tenant_config.push({
    tenant_id: TENANT, key: 'email_evidence_send_intake_form',
    value: { to: 'owner@acme.test', id: 'em_9', at: '2026-08-03T00:00:00.000Z' },
  });
  step.status = 'failed';

  const { sends, result } = await countSends(() =>
    center.runStep(db, TENANT, { ...step }, {}, deps()));
  assert.strictEqual(sends, 0, 'retry after a send-then-mark-failure must not double-send');
  assert.strictEqual(result.status, 'completed');
});

test('a successful send records its evidence before completing', async () => {
  const db = fakeDb(seed());
  await onboarding.startOnboarding(db, TENANT, {
    email: 'owner@acme.test', vertical: 'home_services', modules: ['lead_capture'],
  });
  const step = db._tables.onboarding_steps.find((s) => s.step_name === 'send_intake_form');
  await countSends(() => center.runStep(db, TENANT, step, {}, deps()));

  const ev = db._tables.tenant_config.find((c) => c.key === 'email_evidence_send_intake_form');
  assert.ok(ev, 'the delivery must leave durable evidence');
  assert.strictEqual(ev.value.to, 'owner@acme.test');
});
