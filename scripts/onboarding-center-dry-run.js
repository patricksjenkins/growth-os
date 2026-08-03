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
  // Stripe first — those objects live outside our database.
  try {
    const { data: cfg } = await db.from('tenant_config').select('key, value').eq('tenant_id', tenantId);
    const map = Object.fromEntries((cfg || []).map((c) => [c.key, c.value]));
    if (process.env.STRIPE_SECRET_KEY) {
      const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
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
    ok(wf.steps.some((s) => s.step === 'send_setup_invoice'), 'the invoice is on the checklist');
    ok(Array.isArray(wf.intake), 'and it reports what the customer still owes');

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

    // --- the money steps, for real, in test mode ---------------------------
    const invoiceStep = wf.steps.find((s) => s.step === 'send_setup_invoice');
    if (process.env.STRIPE_SECRET_KEY && invoiceStep) {
      r = await call('get', '/onboarding/step/:stepId/preview', { params: { stepId: invoiceStep.id } });
      ok(/real invoice/i.test((r.body.preview.warnings || []).join(' ')),
        'the invoice warns before it is clicked');

      r = await call('post', '/onboarding/step/:stepId/run', { params: { stepId: invoiceStep.id }, body: {} });
      ok(r.body.status === 'completed', `invoice step ran (${r.body.detail})`);

      const { data: cfg } = await db.from('tenant_config').select('key, value').eq('tenant_id', tenantId);
      const map = Object.fromEntries((cfg || []).map((c) => [c.key, c.value]));
      ok(map.setup_invoice_amount_usd === 199, `invoice is $${map.setup_invoice_amount_usd} (expect 199)`);
      ok(Boolean(map.setup_invoice_url), 'Stripe hosts a pay page');

      // Verify against Stripe itself, not our own record.
      const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
      const inv = await stripe.invoices.retrieve(map.setup_invoice_id);
      ok(inv.amount_due === 19900, `Stripe says $${inv.amount_due / 100}`);
      const lines = await stripe.invoices.listLineItems(inv.id, { limit: 10 });
      ok(lines.data.length === 1, `one line only — no monthly on the setup invoice`);

      // --- THE DOUBLE-BILL, AGAINST REAL STRIPE --------------------------
      //
      // The website's Payment Links already collect the $199. Such a customer
      // has an invoice in Stripe and NOTHING in tenant_config, because our
      // code never created it — so the local setup_invoice_id guard waves them
      // through and the step bills a second $199.
      //
      // Reproduce exactly that here by deleting the local flag while leaving
      // the real Stripe invoice in place. Only core/stripe-reconcile can save
      // the customer now.
      await db.from('tenant_config').delete()
        .eq('tenant_id', tenantId).eq('key', 'setup_invoice_id');

      // Prove the fixture did what it claims. If the flag is still there, the
      // local guard stops the send and the test passes without ever
      // exercising the Stripe reconciliation it exists to prove.
      const { data: flagRow } = await db.from('tenant_config').select('key')
        .eq('tenant_id', tenantId).eq('key', 'setup_invoice_id').maybeSingle();
      ok(!flagRow, 'the local guard is genuinely gone — only Stripe can stop the second charge');

      const invoicesBefore = await stripe.invoices.list({ customer: map.stripe_customer_id, limit: 20 });
      // Steps are re-read because the row moved to completed on the first run.
      const wf2 = (await call('get', '/onboarding/workflow/:tenantId', { params: { tenantId } })).body.workflow;
      const invStep2 = wf2.steps.find((s) => s.step === 'send_setup_invoice');
      r = await call('post', '/onboarding/step/:stepId/run', {
        params: { stepId: invStep2.id }, body: { force: true },
      });
      const invoicesAfter = await stripe.invoices.list({ customer: map.stripe_customer_id, limit: 20 });

      ok(invoicesAfter.data.length === invoicesBefore.data.length,
        `no second invoice was created (${invoicesBefore.data.length} -> ${invoicesAfter.data.length})`);
      ok(/already paid|already/i.test(r.body.detail || ''),
        `and it says why: "${(r.body.detail || '').slice(0, 60)}"`);

      // Subscription with no card must refuse in plain words.
      const subStep = wf.steps.find((s) => s.step === 'start_subscription');
      r = await call('post', '/onboarding/step/:stepId/run', { params: { stepId: subStep.id }, body: {} });
      ok(r.body.status !== 'completed' && /card|invoice/i.test(r.body.detail || ''),
        `subscription refused without a card: "${(r.body.detail || '').slice(0, 60)}"`);
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
