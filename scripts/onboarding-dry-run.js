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
 * Creates a scratch tenant, runs the whole 7-day timeline, asserts on what
 * actually happened, then deletes everything it made. No emails are sent
 * (send_welcome/intake are stubbed at the integration boundary) and no phone
 * number is bought (the tenant gets no SMS modules).
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

      const r = await onb.advanceOnboarding(db, tenantId).catch((e) => ({ error: e.message }));
      const after = await onb.getOnboardingStatus(db, tenantId);
      const day_ = after ? after.currentDay : 'done';
      console.log(`  day ${day} -> ${day_}  ${r.advanced ? 'advanced' : (r.message || r.error || 'complete')}`);
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

    const stuck = allSteps.filter((s) => !['completed', 'skipped'].includes(s.status));
    ok(stuck.length === 0, `every step resolved (${stuck.length} stuck)`);
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
