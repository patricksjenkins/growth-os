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
  const step = db._tables.onboarding_steps.find((s) => s.step_name === 'send_welcome_email');
  const preview = await center.previewStep(db, TENANT, step, onboarding.loadCenterContext);

  // A second copy of the subject map in the preview layer would drift, and the
  // preview would start lying about what goes out.
  assert.strictEqual(preview.subject, emailMod.subjectFor('welcome'));
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
  const step = db._tables.onboarding_steps.find((s) => s.step_name === 'send_welcome_email');

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
    const step = db._tables.onboarding_steps.find((s) => s.step_name === 'send_welcome_email');

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
  const step = db._tables.onboarding_steps.find((s) => s.step_name === 'send_welcome_email');

  await countSends(() => center.runStep(db, TENANT, step, {}, deps()));
  const { sends } = await countSends(() => center.runStep(db, TENANT, step, {}, deps()));

  assert.strictEqual(sends, 0, 'a double-click must not email the customer twice');
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
