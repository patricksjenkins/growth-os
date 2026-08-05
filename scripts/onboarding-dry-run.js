/**
 * End-to-end onboarding dry run against the REAL database.
 *
 *   node scripts/onboarding-dry-run.js
 *
 * Run this before onboarding a real client, and after any change to
 * core/onboarding.js. It is the only check that proves the whole timeline
 * works — unit tests run against a fake Supabase, and the reason this engine
 * sat broken for months is that everything looked fine except reality.
 *
 * Creates a scratch tenant, runs every step handler, asserts on what actually
 * happened, then deletes everything it made. No emails are sent
 * (send_welcome/intake are stubbed at the integration boundary) and no phone
 * number is bought (the tenant gets no SMS modules).
 *
 * WHAT THIS DOES AND DOES NOT DRIVE (2026-08-03)
 * It used to walk the days through advanceOnboarding(). That is the retired
 * scheduler: the onboarding cron was removed and worker/agents/
 * onboarding-advance.js is no longer registered (verified live — the agent
 * count went 66 -> 65). Nothing in production calls it.
 *
 * Worse, it deadlocks. advanceOnboarding refuses to move past an unresolved
 * day, but a day's automated steps only run AFTER an advance — so once
 * startOnboarding stopped running anything, day 0 could never resolve and the
 * walk stalled at "4 step(s) unresolved for day 0" forever. This script sat
 * reporting 6 failures that said nothing about the live product.
 *
 * The HANDLERS are still live: the Onboarding Center runs the same
 * _executeStepHandler per click. So the day loop now invokes the handlers
 * directly, which is what these assertions were ever really about. The route
 * handlers Patrick's clicks hit are covered by
 * scripts/onboarding-center-dry-run.js.
 */
require('dotenv').config();
const { getServiceClient } = require('../db/client');
const onb = require('../core/onboarding');
const emailMod = require('../integrations/email');

// Never send a real email from a dry run.
for (const k of Object.keys(emailMod)) {
  if (typeof emailMod[k] === 'function' && /^send/.test(k)) {
    emailMod[k] = async () => ({ status: 'dry_run_stubbed' });
  }
}

const db = getServiceClient();
const SLUG = 'zz-dryrun-' + Math.random().toString(36).slice(2, 8);
let tenantId = null;
const results = [];
const ok = (cond, msg) => results.push({ ok: !!cond, msg });

async function cleanup() {
  // Stripe FIRST — those objects live outside our database, so a failure here
  // leaves real (test-mode) customers and invoices behind rather than rows.
  try {
    if (tenantId && process.env.STRIPE_SECRET_KEY) {
      const { data: cfg } = await db.from('tenant_config')
        .select('key, value').eq('tenant_id', tenantId);
      const map = Object.fromEntries((cfg || []).map((c) => [c.key, c.value]));
      const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
      if (map.stripe_subscription_id) await stripe.subscriptions.cancel(map.stripe_subscription_id).catch(() => {});
      if (map.setup_invoice_id) await stripe.invoices.voidInvoice(map.setup_invoice_id).catch(() => {});
      if (map.stripe_customer_id) await stripe.customers.del(map.stripe_customer_id).catch(() => {});
    }
  } catch (_) { /* best effort — never block the row cleanup below */ }

  if (!tenantId) return;
  for (const t of ['onboarding_steps', 'onboarding_workflows', 'leads', 'agent_jobs',
                   'tenant_config', 'tenant_modules', 'tenant_integrations', 'activity_log']) {
    await db.from(t).delete().eq('tenant_id', tenantId);
  }
  await db.from('tenants').delete().eq('id', tenantId);
}

(async () => {
  try {
    // --- create a scratch tenant the way the admin route does --------------
    const { data: tenant, error } = await db.from('tenants').insert({
      name: 'ZZ Dry Run', slug: SLUG, owner_email: `${SLUG}@dryrun.invalid`,
      status: 'onboarding', vertical: 'home_services', is_demo: false,
    }).select().single();
    if (error) throw error;
    tenantId = tenant.id;
    console.log(`scratch tenant ${SLUG} (${tenantId})\n`);

    // Growth-ish pick, no SMS modules so nothing buys a phone number.
    const { keysForProducts } = require('../core/module-registry');
    const modules = keysForProducts(['content_engine', 'content_approval', 'lead_capture']);
    await db.from('tenant_modules').insert(
      modules.map((m) => ({ tenant_id: tenantId, module: m, enabled: true })),
    );

    // --- start the workflow ------------------------------------------------
    const wf = await onb.startOnboarding(db, tenantId, {
      owner_name: 'Dry Run', business_name: 'ZZ Dry Run',
      email: `${SLUG}@dryrun.invalid`, tier: 'growth', vertical: 'home_services',
      modules, welcomeAlreadySent: true,
    });
    ok(wf && wf.id, 'a workflow row was created');

    let st = await onb.getOnboardingStatus(db, tenantId);
    ok(st.totalSteps > 0 && st.totalSteps < 23,
      `seeded a gated subset: ${st.totalSteps} steps (not all 23)`);
    ok(!st.completed.concat(st.pending).some((s) => s.step_name === 'provision_phone_number'),
      'no phone-number step for a client with no SMS modules');

    // --- walk the 7 days ---------------------------------------------------
    for (let day = 0; day < 8; day += 1) {
      const before = await onb.getOnboardingStatus(db, tenantId);
      if (!before) break;

      // Clear whatever a human owes us, the way Patrick / the customer would.
      for (const s of before.blocking) {
        if (s.kind === 'founder' || s.kind === 'customer') {
          await onb.completeStep(db, tenantId, s.id);
        }
      }
      // Supply the wizard answers the waiting steps are asking for.
      await db.from('tenant_config').upsert([
        // The handlers read the recipient from tenant_config, not from the
        // tenants row. Without this, send_setup_invoice failed with "no client
        // email" every run — so the money handler was never actually
        // exercised here, and the failure looked like a code defect.
        { tenant_id: tenantId, key: 'owner_email', value: `${SLUG}@dryrun.invalid` },
        { tenant_id: tenantId, key: 'business_name', value: 'ZZ Dry Run' },
        { tenant_id: tenantId, key: 'tier', value: 'growth' },
        { tenant_id: tenantId, key: 'logo_url', value: 'https://example.invalid/logo.png' },
        { tenant_id: tenantId, key: 'color_primary', value: '#2C5AA0' },
        { tenant_id: tenantId, key: 'brand_voice', value: ['Plain spoken.', 'Local.', 'Reliable.'] },
        { tenant_id: tenantId, key: 'key_services', value: ['Tree removal'] },
        { tenant_id: tenantId, key: 'customers', value: [] },
        { tenant_id: tenantId, key: 'onboarding_steps_completed', value: ['customers'] },
        { tenant_id: tenantId, key: 'facebook_url', value: 'https://facebook.com/zzdryrun' },
        { tenant_id: tenantId, key: 'instagram_url', value: 'https://instagram.com/zzdryrun' },
        { tenant_id: tenantId, key: 'google_review_url', value: 'https://g.page/r/zzdryrun/review' },
      ], { onConflict: 'tenant_id,key' });

      // Patrick's founder task: connect their socials inside FGA's Buffer.
      const { data: hasBuf } = await db.from('tenant_integrations')
        .select('service').eq('tenant_id', tenantId).eq('service', 'buffer').maybeSingle();
      if (!hasBuf) {
        await db.from('tenant_integrations').insert({
          tenant_id: tenantId, service: 'buffer',
          config: { profile_ids: ['dryrun-profile'] }, credentials: {}, status: 'active',
        });
      }

      // Run this day's automated steps the way the Onboarding Center does —
      // by executing the handlers — rather than through the retired scheduler.
      // See the header: advanceOnboarding deadlocks on day 0 and nothing in
      // production calls it.
      const r = await onb._internals
        ._runAutomatedSteps(db, tenantId, before.workflowId, day)
        .then(() => ({ advanced: true }))
        .catch((e) => ({ error: e.message }));

      // Keep the workflow's own day pointer moving so the status view and the
      // completion check see the same progress a real run would.
      await db.from('onboarding_workflows')
        .update({ current_day: day }).eq('id', before.workflowId);

      const after = await onb.getOnboardingStatus(db, tenantId);
      const day_ = after ? after.currentDay : 'done';
      console.log(`  day ${day} -> ${day_}  ${r.advanced ? 'ran' : (r.message || r.error || 'complete')}`);
      if (after && after.blocking.length) {
        for (const b of after.blocking.slice(0, 4)) {
          console.log(`        ${b.status.padEnd(9)} ${b.step_name}  ${b.last_error || ''}`);
        }
      }
      if (!after) break;
    }

    // --- what actually happened -------------------------------------------
    const { data: finalTenant } = await db.from('tenants')
      .select('status').eq('id', tenantId).maybeSingle();
    const final = await onb.getOnboardingStatus(db, tenantId);
    const { data: allSteps } = await db.from('onboarding_steps')
      .select('step_name, status, last_error').eq('tenant_id', tenantId).order('day');

    console.log('\n  final step states:');
    for (const s of allSteps) {
      console.log(`    ${s.status.padEnd(10)} ${s.step_name}${s.last_error ? '  — ' + s.last_error.slice(0, 70) : ''}`);
    }

    // The single-checkout redesign: no separate subscription step exists for
    // a standard monthly client. The whole deal — setup + subscription +
    // trial — rides one Checkout the customer pays; nothing on the checklist
    // waits for a card anymore, so a fully-worked workflow CLOSES.
    ok(!allSteps.some((s) => s.step_name === 'start_subscription'),
      'no separate subscription step — the combined checkout carries it');
    ok(allSteps.some((s) => s.step_name === 'send_payment_link'),
      'the combined payment step is seeded instead');

    const stuck = allSteps.filter((s) => !['completed', 'skipped'].includes(s.status));
    ok(stuck.length === 0,
      `every step resolved (${stuck.length} stuck${stuck.length ? ': ' + stuck.map((s) => s.step_name).join(', ') : ''})`);
    ok(finalTenant?.status === 'active',
      `tenant went live: status=${finalTenant?.status}`);
    ok(final === null, 'workflow closed itself out');

    const { data: cfg } = await db.from('tenant_config')
      .select('key').eq('tenant_id', tenantId);
    const keys = new Set((cfg || []).map((c) => c.key));
    ok(keys.has('preflight_passed_at'), 'pre-go-live checks ran and passed');
    ok(keys.has('publishing_schedule'), 'publishing schedule was written');
    // configure_messaging is gated on SMS modules (follow_up / missed_call /
    // speed_to_lead), which this scenario deliberately does not buy so that
    // nothing purchases a phone number. Its absence is correct.
    ok(!keys.has('messaging_configured_at'),
      'no messaging config for a client with no SMS modules (correctly not seeded)');

    const { data: jobs } = await db.from('agent_jobs')
      .select('agent_name').eq('tenant_id', tenantId);
    ok((jobs || []).some((j) => j.agent_name === 'content-generation'),
      'a first content batch was queued');

  } catch (e) {
    ok(false, `THREW: ${e.message}`);
    console.error(e.stack);
  } finally {
    await cleanup();
    console.log('\n--- results ---');
    let bad = 0;
    for (const r of results) {
      if (!r.ok) bad += 1;
      console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.msg}`);
    }
    console.log(`\n${results.length - bad}/${results.length} passed. scratch tenant deleted.`);
    process.exit(bad ? 1 : 0);
  }
})();
