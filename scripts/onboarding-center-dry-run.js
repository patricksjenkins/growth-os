/**
 * End-to-end dry run through the ONBOARDING CENTER'S OWN ROUTES.
 *
 *   node scripts/onboarding-center-dry-run.js
 *
 * scripts/onboarding-dry-run.js exercises the engine directly. This drives the
 * route handlers Patrick's clicks actually hit — GET .../preview and
 * POST .../run — because that wiring (step lookup by id, dependency passing,
 * the preview/run split) is the part no test covers and the part a mistake
 * would reach a customer through.
 *
 * Emails are stubbed at the integration boundary: nothing is delivered.
 * Stripe runs FOR REAL against test mode, because the money steps are exactly
 * where a wiring error costs something, and every object created is deleted at
 * the end.
 */
require('dotenv').config();

const { getServiceClient } = require('../db/client');
const onboarding = require('../core/onboarding');
const emailMod = require('../integrations/email');
const { keysForProducts } = require('../core/module-registry');

// --- nothing real is delivered --------------------------------------------
let emailsSent = [];
for (const k of Object.keys(emailMod)) {
  if (typeof emailMod[k] === 'function' && /^send/.test(k)) {
    const name = k;
    emailMod[k] = async (to, subject) => {
      emailsSent.push({ fn: name, to, subject });
      return { id: 'dry-run', status: 'sent' };
    };
  }
}

const db = getServiceClient();
const SLUG = 'zz-center-' + Math.random().toString(36).slice(2, 8);
const EMAIL = `${SLUG}@dryrun.invalid`;
let tenantId = null;
const results = [];
const ok = (cond, msg) => results.push({ ok: !!cond, msg });

// --- call the real route handlers -----------------------------------------
const adminRouter = require('../api/routes/admin');
function handler(method, routePath) {
  const layer = adminRouter.stack.find(
    (l) => l.route && l.route.path === routePath && l.route.methods[method],
  );
  if (!layer) throw new Error(`route not registered: ${method.toUpperCase()} ${routePath}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}
function res() {
  const r = {
    statusCode: 200, body: null,
    status(c) { r.statusCode = c; return r; },
    json(b) { r.body = b; return r; },
  };
  return r;
}
async function call(method, routePath, { params = {}, body = {} } = {}) {
  const r = res();
  await handler(method, routePath)({ params, body, headers: {} }, r);
  return r;
}

async function cleanup() {
  // The welcome step now runs the REAL account plumbing (auth user +
  // membership + magic link) — that is the point of driving the actual route.
  // So a scratch auth user exists and has to go, or every dry run leaves one.
  try {
    const { data } = await db.auth.admin.listUsers({ page: 1, perPage: 200 });
    const ghost = (data?.users || []).find((u) => u.email === EMAIL);
    if (ghost) await db.auth.admin.deleteUser(ghost.id);
  } catch (_) { /* best effort */ }

  // Stripe first — those objects live outside our database.
  try {
    const { data: cfg } = await db.from('tenant_config').select('key, value').eq('tenant_id', tenantId);
    const map = Object.fromEntries((cfg || []).map((c) => [c.key, c.value]));
    if (process.env.STRIPE_SECRET_KEY) {
      const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
      if (map.checkout_session_id) await stripe.checkout.sessions.expire(map.checkout_session_id).catch(() => {});
      if (map.stripe_subscription_id) await stripe.subscriptions.cancel(map.stripe_subscription_id).catch(() => {});
      if (map.setup_invoice_id) await stripe.invoices.voidInvoice(map.setup_invoice_id).catch(() => {});
      if (map.stripe_customer_id) await stripe.customers.del(map.stripe_customer_id).catch(() => {});
    }
  } catch (_) { /* best effort */ }

  if (!tenantId) return;
  for (const t of ['onboarding_steps', 'onboarding_workflows', 'leads', 'agent_jobs',
                   'tenant_config', 'tenant_modules', 'tenant_integrations', 'activity_log']) {
    await db.from(t).delete().eq('tenant_id', tenantId);
  }
  await db.from('tenants').delete().eq('id', tenantId);
}

(async () => {
  try {
    const { data: tenant, error } = await db.from('tenants').insert({
      name: 'ZZ Center Dry Run', slug: SLUG, owner_email: EMAIL,
      status: 'onboarding', vertical: 'home_services', is_demo: false,
    }).select().single();
    if (error) throw error;
    tenantId = tenant.id;
    console.log(`scratch tenant ${SLUG} (${tenantId})\n`);

    const modules = keysForProducts(['content_engine', 'content_approval', 'lead_capture']);
    await db.from('tenant_modules').insert(modules.map((m) => ({ tenant_id: tenantId, module: m, enabled: true })));
    await db.from('tenant_config').upsert([
      { tenant_id: tenantId, key: 'owner_email', value: EMAIL },
      { tenant_id: tenantId, key: 'business_name', value: 'ZZ Center Dry Run' },
      { tenant_id: tenantId, key: 'tier', value: 'growth' },
    ], { onConflict: 'tenant_id,key' });

    await onboarding.startOnboarding(db, tenantId, {
      owner_name: 'Dry Run', business_name: 'ZZ Center Dry Run', email: EMAIL,
      tier: 'growth', vertical: 'home_services', modules, welcomeAlreadySent: false,
    });
    ok(emailsSent.length === 0, `seeding sent nothing (${emailsSent.length} emails)`);

    // --- the workflow route ------------------------------------------------
    let r = await call('get', '/onboarding/workflow/:tenantId', { params: { tenantId } });
    ok(r.statusCode === 200 && r.body.success, 'workflow route answers');
    const wf = r.body.workflow;
    ok(wf && Array.isArray(wf.steps) && wf.steps.length > 0, `returns ${wf?.steps?.length} steps`);
    ok(wf.steps.every((s) => s.dayLabel), 'every step is grouped under a day');
    ok(wf.steps.some((s) => s.step === 'send_payment_link'), 'the combined payment step is on the checklist');
    ok(Array.isArray(wf.intake), 'and it reports what the customer still owes');
    // The chase list is module-filtered. This tenant has content + lead
    // capture but NO review_request and NO referral/follow_up, so a Google
    // review link and a customer list are not owed and must not be listed —
    // a chase list with things nobody owes teaches its reader to ignore it.
    {
      const labels = wf.intake.map((f) => f.label);
      ok(!labels.includes('Google review link'),
        'no review-link chase without the review module');
      ok(!labels.includes('Customer list'),
        'no customer-list chase without referral/follow-up modules');
      ok(labels.includes('Logo'), 'while genuinely-owed fields stay listed');
    }

    // --- preview must send nothing ----------------------------------------
    const emailStep = wf.steps.find((s) => s.isEmail);
    const before = emailsSent.length;
    r = await call('get', '/onboarding/step/:stepId/preview', { params: { stepId: emailStep.id } });
    ok(r.statusCode === 200 && r.body.success, 'preview route answers');
    ok(r.body.preview.kind === 'email' && r.body.preview.html?.length > 100, 'renders the real body');
    ok(r.body.preview.subject && !/growth os/i.test(r.body.preview.subject), 'subject is on-brand');
    ok(emailsSent.length === before, 'PREVIEW SENT NOTHING');

    // --- run is what sends -------------------------------------------------
    r = await call('post', '/onboarding/step/:stepId/run', { params: { stepId: emailStep.id }, body: {} });
    ok(r.statusCode === 200 && r.body.status === 'completed', `run completed (${r.body.detail})`);
    ok(emailsSent.length === before + 1, 'run sent exactly one email');
    ok(emailsSent[emailsSent.length - 1].to === EMAIL, 'to the right customer');

    // --- a second click must not resend ------------------------------------
    const afterFirst = emailsSent.length;
    r = await call('post', '/onboarding/step/:stepId/run', { params: { stepId: emailStep.id }, body: {} });
    ok(emailsSent.length === afterFirst, 'a second click sent nothing');

    // --- an edit is what goes out -----------------------------------------
    const second = wf.steps.filter((s) => s.isEmail && s.id !== emailStep.id)[0];
    if (second) {
      r = await call('post', '/onboarding/step/:stepId/run', {
        params: { stepId: second.id },
        body: { subject: 'Edited by the dry run' },
      });
      const last = emailsSent[emailsSent.length - 1];
      ok(last.subject === 'Edited by the dry run', 'an edited subject is what sends');
    }

    // --- the money step, for real, in test mode ----------------------------
    //
    // ONE checkout now carries the whole deal (Patrick, 2026-08-05): setup fee
    // + subscription + 14-day trial in a single Stripe Checkout, like the
    // public Payment Links. Sessions are INERT until the customer pays, so
    // creating one against test mode is safe; it is expired in cleanup.
    const payStep = wf.steps.find((s) => s.step === 'send_payment_link');
    ok(Boolean(payStep), 'the combined payment step is on the checklist');
    ok(!wf.steps.some((s) => s.step === 'send_setup_invoice'),
      'no separate invoice step — the checkout carries the fee');
    ok(!wf.steps.some((s) => s.step === 'start_subscription'),
      'no separate subscription step — the checkout starts it');

    if (process.env.STRIPE_SECRET_KEY && payStep) {
      r = await call('get', '/onboarding/step/:stepId/preview', { params: { stepId: payStep.id } });
      const pw = (r.body.preview.warnings || []).join(' ') + ' ' + (r.body.preview.description || '');
      ok(/\$199/.test(pw) && /\$249/.test(pw) && /14-day/.test(pw),
        'the preview names BOTH amounts and the trial before the click');

      const before2 = emailsSent.length;
      r = await call('post', '/onboarding/step/:stepId/run', { params: { stepId: payStep.id }, body: {} });
      ok(r.body.status === 'completed', `payment step ran (${(r.body.detail || '').slice(0, 60)})`);
      ok(emailsSent.length === before2 + 1, 'exactly one payment email');

      const { data: cfg } = await db.from('tenant_config').select('key, value').eq('tenant_id', tenantId);
      const map = Object.fromEntries((cfg || []).map((c) => [c.key, c.value]));
      ok(Boolean(map.checkout_session_id), 'the session id is recorded');

      // Verify against Stripe itself: one session, BOTH line items, the trial.
      const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
      const session = await stripe.checkout.sessions.retrieve(map.checkout_session_id);
      ok(session.mode === 'subscription', 'checkout is in subscription mode (card captured for day 15)');
      const items = await stripe.checkout.sessions.listLineItems(map.checkout_session_id, { limit: 10 });
      ok(items.data.length === 2, `both products on ONE page (${items.data.length} line items)`);
      const setupItem = items.data.find((i) => !i.price?.recurring);
      const monthlyItem = items.data.find((i) => i.price?.recurring);
      ok(setupItem?.amount_total === 19900, 'the $199 setup fee is due today');
      ok(monthlyItem?.price?.unit_amount === 24900, 'the $249 monthly is on it');
      // amount_total 0 on the recurring line IS the trial: nothing due on the
      // monthly today, first charge on day 15.
      ok(monthlyItem?.amount_total === 0, 'and the trial means $0 of it is due today');

      // A retry must reuse the SAME session — two live checkouts can both be
      // paid, which is the double-subscribe this design closes.
      const wf2 = (await call('get', '/onboarding/workflow/:tenantId', { params: { tenantId } })).body.workflow;
      const pay2 = wf2.steps.find((s) => s.step === 'send_payment_link');
      r = await call('post', '/onboarding/step/:stepId/run', {
        params: { stepId: pay2.id }, body: { force: true },
      });
      const { data: cfg2 } = await db.from('tenant_config').select('key, value').eq('tenant_id', tenantId);
      const map2 = Object.fromEntries((cfg2 || []).map((c) => [c.key, c.value]));
      ok(map2.checkout_session_id === map.checkout_session_id,
        'a re-run reuses the SAME checkout session — no rival link exists');
    } else {
      console.log('  (skipping the Stripe steps — no STRIPE_SECRET_KEY)\n');
    }

    // --- a human step is ticked, not executed ------------------------------
    const human = wf.steps.find((s) => s.owedBy === 'founder');
    if (human) {
      const n = emailsSent.length;
      r = await call('post', '/onboarding/step/:stepId/run', { params: { stepId: human.id }, body: {} });
      ok(r.body.status === 'completed' && emailsSent.length === n,
        'a founder step is ticked off without sending');
    }

    // --- final state -------------------------------------------------------
    const { data: finalSteps } = await db.from('onboarding_steps')
      .select('step_name, status, last_error').eq('tenant_id', tenantId).order('day');
    console.log('\n  step states after the run:');
    for (const s of finalSteps) {
      console.log(`    ${s.status.padEnd(10)} ${s.step_name}${s.last_error ? '  — ' + s.last_error.slice(0, 60) : ''}`);
    }
    console.log(`\n  emails "sent" (all stubbed): ${emailsSent.length}`);
    emailsSent.forEach((e) => console.log(`    ${e.to}  "${e.subject}"`));

  } catch (e) {
    ok(false, `THREW: ${e.message}`);
    console.error(e.stack);
  } finally {
    await cleanup();
    console.log('\n--- results ---');
    let bad = 0;
    for (const r of results) { if (!r.ok) bad += 1; console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.msg}`); }
    console.log(`\n${results.length - bad}/${results.length} passed. Scratch tenant and Stripe objects deleted.`);
    process.exit(bad ? 1 : 0);
  }
})();
