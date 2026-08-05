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
      upsert(p) {
        // Postgres upsert REPLACES on the conflict key. Appending instead
        // makes a promoted record look stuck at its old value.
        const list = Array.isArray(p) ? p : [p];
        for (const row of list) {
          const hit = row.key !== undefined
            ? tables[name].find((r) => r.tenant_id === row.tenant_id && r.key === row.key)
            : null;
          if (hit) Object.assign(hit, row);
          else tables[name].push({ id: `${name}-${++idSeq}`, ...row });
        }
        inserted = list;
        return api;
      },
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
  const emailMod = require('../integrations/email');
  const saved = {
    setupFeeAlreadyBilled: reconcile.setupFeeAlreadyBilled,
    subscriptionAlreadyExists: reconcile.subscriptionAlreadyExists,
    billingState: reconcile.billingState,
    sendSetupFeeInvoice: stripeInt.sendSetupFeeInvoice,
    startTrialSubscription: stripeInt.startTrialSubscription,
    createOnboardingCheckout: stripeInt.createOnboardingCheckout,
    getCheckoutSession: stripeInt.getCheckoutSession,
    createCustomer: stripeInt.createCustomer,
    sendTemplateEmail: emailMod.sendTemplateEmail,
  };
  const charged = [];

  reconcile.setupFeeAlreadyBilled = async () => (alreadyBilled
    ? { billed: true, evidence: { source: 'stripe_checkout', session_id: 'cs_1', amount_usd: 199, created: '2026-07-30T00:00:00.000Z' } }
    : { billed: false, evidence: null });
  reconcile.subscriptionAlreadyExists = async () => (alreadySubscribed
    ? { exists: true, subscription: { subscription_id: 'sub_live', status: 'trialing', first_charge_date: '2026-08-13', monthly_usd: 249, created: '2026-07-30T00:00:00.000Z' } }
    : { exists: false, subscription: null });
  reconcile.billingState = async () => ({
    ok: true,
    setup: await reconcile.setupFeeAlreadyBilled(),
    subscription: await reconcile.subscriptionAlreadyExists(),
  });
  stripeInt.createOnboardingCheckout = async (args) => {
    charged.push('checkout_created');
    return { session_id: 'cs_new', url: 'https://checkout.stripe.com/pay/cs_new', setup_usd: 199, monthly_usd: 249, trial_days: 14 };
  };
  stripeInt.getCheckoutSession = async (id) => ({ id, status: 'open' });
  emailMod.sendTemplateEmail = async (to, template) => {
    charged.push(`email:${template}`);
    return { status: 'sent', id: 'em_pl' };
  };

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

  return Promise.resolve(fn(charged)).finally(() => {
    Object.assign(reconcile, {
      setupFeeAlreadyBilled: saved.setupFeeAlreadyBilled,
      subscriptionAlreadyExists: saved.subscriptionAlreadyExists,
      billingState: saved.billingState,
    });
    Object.assign(stripeInt, {
      sendSetupFeeInvoice: saved.sendSetupFeeInvoice,
      startTrialSubscription: saved.startTrialSubscription,
      createOnboardingCheckout: saved.createOnboardingCheckout,
      getCheckoutSession: saved.getCheckoutSession,
      createCustomer: saved.createCustomer,
    });
    require('../integrations/email').sendTemplateEmail = saved.sendTemplateEmail;
  });
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

test('a customer who already subscribed at checkout is NOT sent another checkout', async () => {
  const db = await centerWithCustomer();
  const step = db._tables.onboarding_steps.find((s) => s.step_name === 'send_payment_link');

  await withStripeStubs({ alreadySubscribed: true }, async (charged) => {
    const result = await center.runStep(db, TENANT, step, {}, deps());
    assert.deepStrictEqual(charged, [],
      'a second checkout can be PAID — that is a duplicate subscription billing forever');
    assert.strictEqual(result.status, 'completed',
      'and it must read as done, not failed: a red money step invites a re-click');
    assert.match(result.detail, /already have a subscription/i);

    const cfg = Object.fromEntries(
      db._tables.tenant_config.filter((c) => c.tenant_id === TENANT).map((c) => [c.key, c.value]),
    );
    assert.strictEqual(cfg.stripe_subscription_id, 'sub_live', 'the existing one is ADOPTED');
  });
});

test('a customer who has paid nothing gets the ONE combined checkout email', async () => {
  // The guard must not be so broad it stops the normal path.
  const db = await centerWithCustomer();
  const step = db._tables.onboarding_steps.find((s) => s.step_name === 'send_payment_link');

  await withStripeStubs({}, async (charged) => {
    const result = await center.runStep(db, TENANT, step, {}, deps());
    assert.deepStrictEqual(charged, ['checkout_created', 'email:payment-link'],
      'one session, one email — the whole deal on one page');
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

test('the single payment checkout is a step on the checklist', () => {
  // One email, one Stripe Checkout: setup + subscription + trial, like the
  // public Payment Links. The two-step split it replaced could strand on
  // day 7 waiting for a card the invoice payment never stored.
  const names = onboarding.resolveWorkflowSteps(['lead_capture']).map((s) => s.stepName);
  assert.ok(names.includes('send_payment_link'), 'billing must be runnable, not library code');
  assert.ok(!names.includes('send_setup_invoice'), 'no separate invoice for standard clients');
  assert.ok(!names.includes('start_subscription'), 'no separate subscription step either');
});

test('the money steps say what they will do before you click', async () => {
  assert.ok(center.ACTION_DESCRIPTIONS.start_subscription.length > 40);
  assert.match(center.ACTION_DESCRIPTIONS.start_subscription, /day 15/);

  // The amounts are computed from THIS tenant's config — the number on
  // screen before an irreversible click must be the number the click
  // produces. previewStep takes the step row directly, so the money steps
  // are described for whatever billing shape the tenant has.
  const db = fakeDb(seed());
  await onboarding.startOnboarding(db, TENANT, {
    email: 'owner@acme.test', vertical: 'home_services', modules: ['lead_capture'],
  });

  const payStep = db._tables.onboarding_steps.find((s) => s.step_name === 'send_payment_link');
  const pay = await center.previewStep(db, TENANT, payStep, onboarding.loadCenterContext);
  assert.match(pay.description, /\$199/);
  assert.match(pay.description, /\$249/);
  assert.match(pay.description, /14-day/);

  db._tables.tenant_config.push({ tenant_id: TENANT, key: 'setup_fee', value: '500' });
  const custom = await center.previewStep(db, TENANT, payStep, onboarding.loadCenterContext);
  assert.match(custom.description, /\$500/,
    'a custom fee must be the number on screen');

  // The invoice step still exists for annual/custom-rate clients and keeps
  // its computed description.
  const invoicePreview = await center.previewStep(db, TENANT,
    { step_name: 'send_setup_invoice', status: 'pending', kind: 'automated' },
    onboarding.loadCenterContext);
  assert.match(invoicePreview.description, /\$500/);
});

test('a complimentary client sees a refusal notice on both money shapes', async () => {
  const db = fakeDb(seed());
  await onboarding.startOnboarding(db, TENANT, {
    email: 'owner@acme.test', vertical: 'home_services', modules: ['lead_capture'],
  });
  db._tables.tenant_config.push({ tenant_id: TENANT, key: 'is_complimentary', value: true });
  const inv = await center.previewStep(db, TENANT,
    { step_name: 'send_setup_invoice', status: 'pending', kind: 'automated' },
    onboarding.loadCenterContext);
  assert.match(inv.description, /COMPLIMENTARY.*refuse/is);
  const pay = await center.previewStep(db, TENANT,
    { step_name: 'send_payment_link', status: 'pending', kind: 'automated' },
    onboarding.loadCenterContext);
  assert.match(pay.description, /COMPLIMENTARY.*refuse/is);
});

test('the invoice step warns that it sends real money movement', () => {
  const w = center.warningsFor('send_setup_invoice', { config: {}, modules: new Set() });
  // The generic "sends a real invoice" line became the computed amount — a
  // stronger version of the same warning, since it names the actual dollars.
  assert.ok(w.some((x) => /Stripe invoice for the \$\d+/i.test(x)),
    'spending real money deserves saying so, with the number');
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
    tenant_id: TENANT, key: `email_evidence_${step.id}`,
    value: { state: 'sent', to: 'owner@acme.test', id: 'em_1', at: '2026-08-03T00:00:00.000Z' },
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
    tenant_id: TENANT, key: `email_evidence_${step.id}`,
    value: { state: 'sent', to: 'owner@acme.test', id: 'em_1', at: '2026-08-03T00:00:00.000Z' },
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
    tenant_id: TENANT, key: `email_evidence_${step.id}`,
    value: { state: 'sent', to: 'owner@acme.test', id: 'em_9', at: '2026-08-03T00:00:00.000Z' },
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

  const ev = db._tables.tenant_config.find((c) => c.key === `email_evidence_${step.id}`);
  assert.ok(ev, 'the delivery must leave durable evidence');
  assert.strictEqual(ev.value.state, 'sent', 'promoted after provider acceptance');
  assert.strictEqual(ev.value.to, 'owner@acme.test');
});

/*
 * THE CRASH WINDOW ITSELF — what the previous evidence tests never simulated.
 *
 * They seeded evidence and retried, proving the read side. They never crashed
 * BEFORE evidence existed, which is exactly where a duplicate send came from:
 * evidence written after the provider send does not close the window, it
 * moves it. The design now is attempt-record BEFORE the send plus a provider
 * idempotency key derived from the step row's id — a retry that cannot know
 * whether the first attempt reached Resend resends with the same key, and the
 * provider returns the original instead of delivering twice.
 */

test('every send is attempted with an idempotency key tied to the step row', async () => {
  const emailMod = require('../integrations/email');
  const original = emailMod.sendEmail;
  let captured = null;
  emailMod.sendEmail = async (to, subject, html, options) => {
    captured = options; return { status: 'sent', id: 'em_1' };
  };
  try {
    const db = fakeDb(seed());
    await onboarding.startOnboarding(db, TENANT, {
      email: 'owner@acme.test', vertical: 'home_services', modules: ['lead_capture'],
    });
    const step = db._tables.onboarding_steps.find((s) => s.step_name === 'send_intake_form');
    await center.runStep(db, TENANT, step, {}, deps());

    assert.ok(captured, 'sendEmail must receive options');
    assert.match(captured.idempotencyKey, new RegExp(`^onb-step-${step.id}-a\\d+$`),
      'the key is what makes a blind retry safe — tied to the step row, unique per deliberate attempt');
  } finally {
    emailMod.sendEmail = original;
  }
});

test('a crash mid-attempt leaves a "sending" record, and the retry uses the SAME key', async () => {
  const emailMod = require('../integrations/email');
  const original = emailMod.sendEmail;
  const keys = [];
  let failFirst = true;
  emailMod.sendEmail = async (to, subject, html, options) => {
    keys.push(options?.idempotencyKey);
    if (failFirst) { failFirst = false; throw new Error('socket hang up'); } // died mid-send
    return { status: 'sent', id: 'em_2' };
  };
  try {
    const db = fakeDb(seed());
    await onboarding.startOnboarding(db, TENANT, {
      email: 'owner@acme.test', vertical: 'home_services', modules: ['lead_capture'],
    });
    const row = () => db._tables.onboarding_steps.find((s) => s.step_name === 'send_intake_form');

    // Attempt 1: provider call dies. We cannot know if it reached Resend.
    const first = await center.runStep(db, TENANT, { ...row() }, {}, deps());
    assert.strictEqual(first.status, 'failed');
    const ev = db._tables.tenant_config.find((c) => c.key === `email_evidence_${row().id}`);
    assert.strictEqual(ev.value.state, 'sending',
      'the attempt record must exist BEFORE the send — that is the whole point');

    // Attempt 2: proceeds — and with the identical key, so if attempt 1 DID
    // reach Resend, the provider returns the original instead of resending.
    const second = await center.runStep(db, TENANT, { ...row() }, {}, deps());
    assert.strictEqual(second.status, 'completed');
    assert.strictEqual(keys.length, 2);
    assert.strictEqual(keys[0], keys[1], 'same step, same key, no double delivery');
  } finally {
    emailMod.sendEmail = original;
  }
});

test('if the attempt record cannot be written, NOTHING is sent', async () => {
  const db = fakeDb(seed());
  await onboarding.startOnboarding(db, TENANT, {
    email: 'owner@acme.test', vertical: 'home_services', modules: ['lead_capture'],
  });
  const step = db._tables.onboarding_steps.find((s) => s.step_name === 'send_intake_form');

  // Make the evidence upsert fail, but nothing else.
  const realFrom = db.from;
  db.from = (name) => {
    const api = realFrom(name);
    if (name === 'tenant_config') {
      const realUpsert = api.upsert;
      api.upsert = (p) => {
        const rows = Array.isArray(p) ? p : [p];
        if (rows.some((r) => String(r.key || '').startsWith('email_evidence_'))) {
          return { then: (res) => Promise.resolve({ error: { message: 'disk full' } }).then(res) };
        }
        return realUpsert(p);
      };
    }
    return api;
  };

  const { sends, result } = await countSends(() =>
    center.runStep(db, TENANT, { ...step }, {}, deps()));
  assert.strictEqual(sends, 0, 'no attempt record, no send');
  assert.strictEqual(result.status, 'failed');
  assert.match(result.detail, /attempt/i);
});

test('if the evidence CHECK fails, nothing is sent either', async () => {
  // "I could not check whether this was already sent" is not permission to
  // send it — the old code ignored the read error and sent blind.
  const db = fakeDb(seed());
  await onboarding.startOnboarding(db, TENANT, {
    email: 'owner@acme.test', vertical: 'home_services', modules: ['lead_capture'],
  });
  const step = db._tables.onboarding_steps.find((s) => s.step_name === 'send_intake_form');

  const realFrom = db.from;
  db.from = (name) => {
    const api = realFrom(name);
    if (name === 'tenant_config') {
      const realMaybe = api.maybeSingle;
      api.maybeSingle = () => Promise.resolve({ data: null, error: { message: 'connection reset' } });
    }
    return api;
  };

  const { sends, result } = await countSends(() =>
    center.runStep(db, TENANT, { ...step }, {}, deps()));
  assert.strictEqual(sends, 0);
  assert.strictEqual(result.status, 'failed');
  assert.match(result.detail, /could not check/i);
});

test('re-onboarding gets a fresh welcome — old evidence does not cross workflows', async () => {
  // The churn-and-return shape: the first workflow delivered its welcome; the
  // tenant comes back with a NEW workflow (new step rows) and a new email
  // address. Keying evidence by step_name would have suppressed this send.
  const db = fakeDb(seed());
  await onboarding.startOnboarding(db, TENANT, {
    email: 'owner@acme.test', vertical: 'home_services', modules: ['lead_capture'],
  });
  const oldStep = db._tables.onboarding_steps.find((s) => s.step_name === 'send_intake_form');
  db._tables.tenant_config.push({
    tenant_id: TENANT, key: `email_evidence_${oldStep.id}`,
    value: { state: 'sent', to: 'old-address@acme.test', id: 'em_old', at: '2026-01-01T00:00:00.000Z' },
  });

  // The new workflow's step: same name, different row.
  const newStep = { ...oldStep, id: 'onboarding_steps-NEW' };
  db._tables.onboarding_steps.push({ ...newStep, status: 'pending' });

  const { sends, result } = await countSends(() =>
    center.runStep(db, TENANT, { ...newStep, status: 'pending' }, {}, deps()));
  assert.strictEqual(sends, 1,
    'the new workflow must send its own email — the customer may have a new address');
  assert.strictEqual(result.status, 'completed');
});

/*
 * RESEND'S REAL IDEMPOTENCY SEMANTICS — the part every earlier mock skipped.
 *
 * Resend does not simply "dedupe": a reused key with the IDENTICAL payload
 * returns the original email; a reused key with a DIFFERENT payload is a 409.
 * The welcome can never reproduce its payload on retry (each attempt mints a
 * fresh magic link), so the naive same-key retry did not dedupe — it failed
 * with a 409, stranding the step. And force reused the original key, so a
 * deliberate resend either no-opped or 409'd instead of resending.
 *
 * This fake implements the provider's actual contract, keyed payloads and
 * all, so the tests fail the way production would.
 */
function resendSemantics() {
  const store = new Map();          // idempotencyKey -> payload fingerprint
  const deliveries = [];
  return {
    deliveries,
    store,
    send(fingerprint, key) {
      if (key && store.has(key)) {
        if (store.get(key) === fingerprint) return { status: 'sent', id: `em_${key}`, replayed: true };
        const err = new Error('Email send failed: invalid_idempotent_request — same idempotency key used with a different payload');
        throw err;
      }
      if (key) store.set(key, fingerprint);
      deliveries.push({ key, fingerprint });
      return { status: 'sent', id: `em_${deliveries.length}` };
    },
  };
}

test('welcome crash-retry: fresh magic link + reused key = 409 = PROOF, not a stuck step', async () => {
  const provider = resendSemantics();
  let linkCounter = 0;
  let dieAfterProvider = true;

  // sendWelcomeFromCenter's real shape: mints a NEW link every attempt, so
  // the payload can never match the stored one for a reused key.
  const sendWelcome = async (supabase, args) => {
    linkCounter += 1;
    const payload = `welcome-with-link-${linkCounter}`;
    const emailResult = provider.send(payload, args.idempotencyKey);
    if (dieAfterProvider) { dieAfterProvider = false; throw new Error('socket hang up'); }
    return { delivered: true, emailResult };
  };

  const db = fakeDb(seed());
  await onboarding.startOnboarding(db, TENANT, {
    email: 'owner@acme.test', vertical: 'home_services', modules: ['lead_capture'],
  });
  const row = () => db._tables.onboarding_steps.find((s) => s.step_name === 'send_welcome_email');

  // Attempt 1: Resend accepted, then the process died before any local write.
  const first = await center.runStep(db, TENANT, { ...row() }, {}, { ...deps(), sendWelcome });
  assert.strictEqual(first.status, 'failed');
  assert.strictEqual(provider.deliveries.length, 1, 'the customer HAS the email');

  // Attempt 2: new link -> different payload -> provider 409s on the reused
  // key. That 409 is proof of delivery, and the step completes.
  const second = await center.runStep(db, TENANT, { ...row() }, {}, { ...deps(), sendWelcome });
  assert.strictEqual(second.status, 'completed',
    'a 409 on a reused key proves the first attempt landed — the step must not strand');
  assert.match(second.detail, /DID reach/i);
  assert.strictEqual(provider.deliveries.length, 1,
    'and the customer must still have exactly ONE welcome email');
});

test('force mints a FRESH key, so a deliberate resend actually resends', async () => {
  const provider = resendSemantics();
  const keys = [];
  const emailMod = require('../integrations/email');
  const original = emailMod.sendEmail;
  emailMod.sendEmail = async (to, subject, html, options) => {
    keys.push(options?.idempotencyKey);
    return provider.send(`${subject}::${html}`, options?.idempotencyKey);
  };
  try {
    const db = fakeDb(seed());
    await onboarding.startOnboarding(db, TENANT, {
      email: 'owner@acme.test', vertical: 'home_services', modules: ['lead_capture'],
    });
    const row = () => db._tables.onboarding_steps.find((s) => s.step_name === 'send_intake_form');

    const first = await center.runStep(db, TENANT, { ...row() }, {}, deps());
    assert.strictEqual(first.status, 'completed');
    assert.strictEqual(provider.deliveries.length, 1);

    // Patrick deliberately resends. With the ORIGINAL key this would replay
    // (same payload) or 409 (edited payload) — either way nothing new reaches
    // the customer, which is not what "force" means.
    const forced = await center.runStep(db, TENANT, { ...row() }, { force: true }, deps());
    assert.strictEqual(forced.status, 'completed');
    assert.strictEqual(provider.deliveries.length, 2, 'force must deliver a second email');
    assert.notStrictEqual(keys[0], keys[1], 'which requires a fresh provider key');
  } finally {
    emailMod.sendEmail = original;
  }
});

test('crash-retry of an UNEDITED template replays the original — one delivery', async () => {
  const provider = resendSemantics();
  const emailMod = require('../integrations/email');
  const original = emailMod.sendEmail;
  let die = true;
  emailMod.sendEmail = async (to, subject, html, options) => {
    const r = provider.send(`${subject}::${html}`, options?.idempotencyKey);
    if (die) { die = false; throw new Error('read ECONNRESET'); }
    return r;
  };
  try {
    const db = fakeDb(seed());
    await onboarding.startOnboarding(db, TENANT, {
      email: 'owner@acme.test', vertical: 'home_services', modules: ['lead_capture'],
    });
    const row = () => db._tables.onboarding_steps.find((s) => s.step_name === 'send_intake_form');

    const first = await center.runStep(db, TENANT, { ...row() }, {}, deps());
    assert.strictEqual(first.status, 'failed');
    const second = await center.runStep(db, TENANT, { ...row() }, {}, deps());
    assert.strictEqual(second.status, 'completed');
    assert.strictEqual(provider.deliveries.length, 1,
      'identical payload + same key = provider replay, not a second delivery');
  } finally {
    emailMod.sendEmail = original;
  }
});

/*
 * ROUND 6 — Resend's error taxonomy has two 409s with opposite meanings, and
 * its keys expire.
 */

test('"still processing" is NOT proof of delivery — the step fails and says retry', async () => {
  // concurrent_idempotent_requests means the ORIGINAL request has not
  // finished. It may yet fail. Marking the step completed off it invents a
  // delivery that might never happen — the exact false-green this whole
  // design exists to prevent.
  const emailMod = require('../integrations/email');
  const original = emailMod.sendEmail;
  emailMod.sendEmail = async () => {
    const e = new Error('Email send failed: [concurrent_idempotent_requests] original request still processing');
    e.providerCode = 'concurrent_idempotent_requests';
    throw e;
  };
  try {
    const db = fakeDb(seed());
    await onboarding.startOnboarding(db, TENANT, {
      email: 'owner@acme.test', vertical: 'home_services', modules: ['lead_capture'],
    });
    const row = () => db._tables.onboarding_steps.find((s) => s.step_name === 'send_intake_form');

    // Simulate a prior interrupted attempt so the proof path is reachable —
    // this is precisely the state where the old /idempoten/i regex would have
    // marked it delivered.
    await center.runStep(db, TENANT, { ...row() }, {}, deps()).catch(() => {});
    const second = await center.runStep(db, TENANT, { ...row() }, {}, deps());

    assert.notStrictEqual(second.status, 'completed',
      'still-processing must never be recorded as delivered');
    assert.match(second.detail, /still processing|wait/i);
  } finally {
    emailMod.sendEmail = original;
  }
});

test('an interrupted attempt older than the provider remembers fails CLOSED', async () => {
  // Resend forgets a key after 24h. Past that, the same-key retry is not a
  // dedupe — it is simply a second delivery. Unknowable from here, so refuse
  // with instructions instead of guessing.
  const db = fakeDb(seed());
  await onboarding.startOnboarding(db, TENANT, {
    email: 'owner@acme.test', vertical: 'home_services', modules: ['lead_capture'],
  });
  const step = db._tables.onboarding_steps.find((s) => s.step_name === 'send_intake_form');
  const twoDaysAgo = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  db._tables.tenant_config.push({
    tenant_id: TENANT, key: `email_evidence_${step.id}`,
    value: { state: 'sending', to: 'owner@acme.test', at: twoDaysAgo, idempotency_key: 'onb-old' },
  });
  step.status = 'failed';

  const { sends, result } = await countSends(() =>
    center.runStep(db, TENANT, { ...step }, {}, deps()));
  assert.strictEqual(sends, 0, 'a blind retry past the TTL could double-deliver');
  assert.strictEqual(result.status, 'failed');
  assert.match(result.detail, /too old|dashboard|Force/i,
    'and it must tell Patrick exactly how to resolve it');
});

test('a stale interrupted attempt CAN be forced — that is the escape hatch', async () => {
  const db = fakeDb(seed());
  await onboarding.startOnboarding(db, TENANT, {
    email: 'owner@acme.test', vertical: 'home_services', modules: ['lead_capture'],
  });
  const step = db._tables.onboarding_steps.find((s) => s.step_name === 'send_intake_form');
  const twoDaysAgo = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  db._tables.tenant_config.push({
    tenant_id: TENANT, key: `email_evidence_${step.id}`,
    value: { state: 'sending', to: 'owner@acme.test', at: twoDaysAgo, idempotency_key: 'onb-old' },
  });
  step.status = 'failed';

  const { sends, result } = await countSends(() =>
    center.runStep(db, TENANT, { ...step }, { force: true }, deps()));
  assert.strictEqual(sends, 1, 'force is the deliberate decision the refusal asks for');
  assert.strictEqual(result.status, 'completed');
});

test('the invoice row itself carries the computed amount — not only the preview', async () => {
  // The preview is optional; the row is what is on screen at the moment of
  // the click. A $500 custom deal must not sit behind a generic label.
  const w = center.warningsFor('send_setup_invoice', {
    config: { owner_email: 'x@y.test', setup_fee: '500' }, modules: new Set(),
  });
  assert.ok(w.some((x) => /\$500/.test(x)), 'the row warnings must state the real amount');
  const std = center.warningsFor('send_setup_invoice', {
    config: { owner_email: 'x@y.test' }, modules: new Set(),
  });
  assert.ok(std.some((x) => /\$199/.test(x)));
});
