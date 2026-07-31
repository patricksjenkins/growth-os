/**
 * Growth OS — Onboarding Workflow Engine
 * Manages the 7-day automated client onboarding process.
 *
 * Day 0:  Contract signed  → create tenant, apply preset, send welcome email, send intake form link
 * Day 1-2: Process intake  → configure branding, provision Telnyx, configure Buffer, import contacts
 * Day 3-4: Content gen     → initial content batch, publishing schedule, follow-ups, review triggers
 * Day 5-6: Activation      → founder video call, client uploads photos, test automations, activate modules
 * Day 7:  Go live          → activate all systems, send "you're live" email, schedule 2-week check-in
 */

const { createLogger } = require('./logger');
const crypto = require('crypto');
const email = require('../integrations/email');
const { FGA_KNOWLEDGE } = require('./fga-knowledge');
const log = createLogger('onboarding');

// Pricing comes from core/fga-knowledge.js — the single source of truth.
// These strings feed customer-facing onboarding email templates; this file
// once hardcoded a superseded pricing generation and showed customers wrong
// numbers (guarded by test/pricing-single-source.test.js).
const TIER_PRICE = {
  growth: String(FGA_KNOWLEDGE.pricing.growth_tier.amount),
  scale: String(FGA_KNOWLEDGE.pricing.scale_tier.amount),
};

/**
 * Thrown by a step that has no real implementation yet.
 *
 * The point is that it THROWS. Until 2026-07-30 fourteen of these handlers
 * were a `log.info(...)` and a `break`, which the runner read as success — so
 * `provision_phone_number` "succeeded" without buying a number, `activate_modules`
 * "succeeded" without activating anything, and `go_live` "succeeded" without
 * going live. Every one of those is a claim to the customer that the system
 * cannot back up.
 *
 * A step that is not built yet parks at status='blocked' with this reason
 * attached, blocks the workflow, and shows up in the tracker as work someone
 * has to do. That is the honest state. Delete the throw when the handler does
 * the real thing.
 */
/**
 * Every email step used to be wrapped in `if (clientEmail) { ... }` with no
 * else. A workflow whose intake carried no email address therefore marked
 * send_welcome_email, send_intake_form, send_building_email,
 * send_content_ready, send_app_ready and send_golive_email all COMPLETED
 * having sent nothing at all — six green steps, zero emails, and a customer
 * wondering why they never heard from us.
 *
 * A step that cannot reach the customer has not done its job.
 */
function requireRecipient(addr, stepName) {
  if (!addr) {
    throw new Error(
      `${stepName} has no client email on the workflow — nothing was sent`,
    );
  }
}

class NotImplementedStep extends Error {
  constructor(stepName, detail) {
    super(`${stepName} is not automated yet — ${detail}`);
    this.name = 'NotImplementedStep';
  }
}

// ---------------------------------------------------------------------------
// createClientAccount — creates Supabase auth + sends welcome email
// ---------------------------------------------------------------------------

async function createClientAccount(supabase, { email, ownerName, businessName, tier }) {
  // Generate a readable temporary password
  const tempPassword = crypto.randomBytes(4).toString('hex') + crypto.randomInt(10, 99);
  // e.g. "a3f8b21c42"

  log.info(`Creating client account for ${email} (${businessName})`);

  // 1. Create Supabase auth user with temporary password
  const { data: authData, error: authErr } = await supabase.auth.admin.createUser({
    email,
    password: tempPassword,
    email_confirm: true, // skip email verification — we trust our own onboarding flow
    user_metadata: {
      owner_name: ownerName,
      business_name: businessName,
      tier,
      role: 'client_owner',
    },
  });

  if (authErr) throw new Error(`Failed to create auth account: ${authErr.message}`);

  // 2. pipeline_prospects retired (2026-07-21, Patrick-approved): the table
  // never existed in production (migration 006 was never applied), so this
  // update failed with a warn on every onboarding since day one. `leads` is
  // the pipeline source of truth; the auth linkage below is recorded in
  // activity_log instead so onboarding keeps an audit trail.
  const client = null;
  const { FGA_TENANT_ID } = require('./config');
  await supabase.from('activity_log').insert({
    tenant_id: FGA_TENANT_ID,
    agent: 'onboarding',
    action: 'client_account_created',
    level: 'info',
    metadata: { auth_user_id: authData.user.id, email, business_name: businessName },
  }).then(() => {}, () => {});

  // 3. Build welcome email with credentials
  const tierName = tier === 'scale' ? 'Scale' : 'Growth';
  const tierPrice = tier === 'scale' ? TIER_PRICE.scale : TIER_PRICE.growth;
  const moduleCount = tier === 'scale' ? '15' : '7';
  const onboardingUrl = 'https://firstgenautomate.com/onboarding';

  const emailVars = {
    owner_name: ownerName,
    business_name: businessName,
    client_email: email,
    temp_password: tempPassword,
    tier_name: tierName,
    tier_price: tierPrice,
    module_count: moduleCount,
    onboarding_url: onboardingUrl,
  };

  log.info(`Client account created for ${email}. Temp password: ${tempPassword}`);

  return {
    userId: authData.user.id,
    email,
    tempPassword,
    emailVars,
    client: client || null,
  };
}

// ---------------------------------------------------------------------------
// Step definitions — the canonical 7-day checklist
// ---------------------------------------------------------------------------

/**
 * The 7-day checklist.
 *
 * `requiresModules` — seed this step only if the client bought at least one of
 * these. Omitted means every tenant gets it. Patrick picks the modules; a
 * client who did not buy Review Requests should not have a review-trigger step
 * sitting pending forever, blocking their go-live. Same contract as
 * core/onboarding-step-resolver.js, which already does this for the customer
 * wizard — the backend workflow just never did.
 *
 * `kind` — who clears it:
 *   automated — the engine does it
 *   founder   — Patrick does it (the Day-5 call)
 *   customer  — the client does it (their photos)
 * The old `automated` boolean could not tell the last two apart, and neither
 * had a handler, so both fell through to a warn.
 */
const ONBOARDING_STEPS = [
  // Day 0
  { day: 0, stepName: 'create_tenant',       description: 'Create tenant in the platform',                     kind: 'automated' },
  { day: 0, stepName: 'apply_preset',        description: 'Apply vertical preset to tenant',                   kind: 'automated' },
  { day: 0, stepName: 'send_welcome_email',  description: 'Send welcome email with timeline',                  kind: 'automated' },
  { day: 0, stepName: 'send_intake_form',    description: 'Send intake form link to client',                   kind: 'automated' },

  // Day 1-2
  { day: 1, stepName: 'configure_branding',  description: 'Configure branding from intake data (logo, colors, appearance)', kind: 'automated' },
  // Telnyx is the carrier. This step key was `provision_twilio` — a leftover
  // from the carrier we replaced, kept on the theory that live workflows
  // depended on it. There were never any live workflows (the engine had zero
  // rows in production), so there was nothing to stay compatible with and the
  // name was pure misdirection. Provider-neutral now so swapping carriers
  // again does not leave a third stale name behind.
  // Only worth a number if something actually sends SMS.
  { day: 1, stepName: 'provision_phone_number', description: 'Provision Telnyx number for the tenant',         kind: 'automated',
    requiresModules: ['missed_call', 'speed_to_lead', 'follow_up', 'review_request'] },
  { day: 1, stepName: 'configure_buffer',    description: 'Configure Buffer connection for social publishing', kind: 'automated',
    requiresModules: ['publishing'] },
  { day: 2, stepName: 'import_contacts',     description: 'Import existing contacts/leads from intake form',   kind: 'automated',
    requiresModules: ['lead_capture'] },
  { day: 2, stepName: 'configure_messaging', description: 'Configure messaging templates with client tone',    kind: 'automated',
    requiresModules: ['follow_up', 'missed_call', 'speed_to_lead'] },
  { day: 2, stepName: 'send_building_email', description: 'Send "we\'re building your system" status email',   kind: 'automated' },

  // Day 3-4
  { day: 3, stepName: 'generate_content',    description: 'Generate initial content batch from intake photos', kind: 'automated',
    requiresModules: ['content_engine'] },
  { day: 3, stepName: 'setup_schedule',      description: 'Set up social publishing schedule',                 kind: 'automated',
    requiresModules: ['publishing'] },
  { day: 4, stepName: 'configure_followups', description: 'Configure follow-up sequences',                     kind: 'automated',
    requiresModules: ['follow_up'] },
  { day: 4, stepName: 'setup_review_triggers', description: 'Set up review request triggers',                  kind: 'automated',
    requiresModules: ['review_request'] },
  { day: 4, stepName: 'send_content_ready',  description: 'Send "your content is ready" email',                kind: 'automated',
    requiresModules: ['content_engine'] },

  // Day 5-6
  { day: 5, stepName: 'send_app_ready',      description: 'Send "your app is ready" email with call details',  kind: 'automated',
    requiresModules: ['branded_app'] },
  { day: 5, stepName: 'founder_video_call',  description: 'Founder video call walkthrough with client',        kind: 'founder' },
  { day: 6, stepName: 'client_photo_upload', description: 'Client uploads first batch of photos',              kind: 'customer',
    requiresModules: ['content_engine'] },
  { day: 6, stepName: 'test_automations',    description: 'Test all automations end-to-end',                   kind: 'automated' },
  { day: 6, stepName: 'activate_modules',    description: 'Activate all tenant modules',                       kind: 'automated' },

  // Day 7
  { day: 7, stepName: 'go_live',             description: 'Activate all systems for production',               kind: 'automated' },
  { day: 7, stepName: 'send_golive_email',   description: 'Send "you\'re live" email',                         kind: 'automated' },
  { day: 7, stepName: 'schedule_checkins',   description: 'Schedule 2-week, 30-day, and 60-day check-in emails', kind: 'automated' },
];

/**
 * Which steps this tenant actually gets, given what they bought.
 *
 * @param {string[]} moduleKeys enabled module keys
 * @param {Object}   [opts]
 * @param {boolean}  [opts.welcomeAlreadySent] the magic-link welcome email has
 *   already gone out (the admin flow sends it via core/welcome-wizard before
 *   the workflow starts). Without this the day-0 step sends a SECOND welcome
 *   email to the same person within seconds of the first.
 * @returns {typeof ONBOARDING_STEPS}
 */
function resolveWorkflowSteps(moduleKeys = [], opts = {}) {
  const owned = new Set(moduleKeys);
  return ONBOARDING_STEPS.filter((s) => {
    if (opts.welcomeAlreadySent && s.stepName === 'send_welcome_email') return false;
    if (!s.requiresModules) return true;
    return s.requiresModules.some((m) => owned.has(m));
  });
}

// ---------------------------------------------------------------------------
// startOnboarding — kicks off day 0 tasks
// ---------------------------------------------------------------------------

async function startOnboarding(supabase, tenantId, intakeData = {}) {
  log.info(`Starting onboarding for tenant ${tenantId}`);

  // 1. Create workflow record
  const { data: workflow, error: wfErr } = await supabase
    .from('onboarding_workflows')
    .insert({
      tenant_id: tenantId,
      status: 'active',
      started_at: new Date().toISOString(),
      current_day: 0,
      intake_data: intakeData,
    })
    .select()
    .single();

  if (wfErr) throw new Error(`Failed to create onboarding workflow: ${wfErr.message}`);

  // 2. Seed only the steps this client's modules call for.
  //
  // Seeding all 23 regardless is what would deadlock a workflow: a client who
  // did not buy Review Requests would have `setup_review_triggers` sitting
  // pending on day 4 forever, and advanceOnboarding refuses to move while any
  // step for the current day is pending. They would never reach go-live.
  const steps = resolveWorkflowSteps(intakeData.modules || [], {
    welcomeAlreadySent: intakeData.welcomeAlreadySent === true,
  });
  const stepRows = steps.map((s) => ({
    tenant_id: tenantId,
    workflow_id: workflow.id,
    day: s.day,
    step_name: s.stepName,
    description: s.description,
    status: 'pending',
    kind: s.kind,
    automated: s.kind === 'automated',
  }));

  const { error: stepsErr } = await supabase
    .from('onboarding_steps')
    .insert(stepRows);

  if (stepsErr) throw new Error(`Failed to seed onboarding steps: ${stepsErr.message}`);

  // 3. Auto-complete day 0 automated steps
  await _runAutomatedSteps(supabase, tenantId, workflow.id, 0);

  log.info(`Onboarding started — workflow ${workflow.id}`);
  return workflow;
}

// ---------------------------------------------------------------------------
// getOnboardingStatus — returns current day, completed steps, pending steps
// ---------------------------------------------------------------------------

async function getOnboardingStatus(supabase, tenantId) {
  const { data: workflow, error } = await supabase
    .from('onboarding_workflows')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (error || !workflow) return null;

  const { data: steps, error: stepsErr } = await supabase
    .from('onboarding_steps')
    .select('*')
    .eq('workflow_id', workflow.id)
    .order('day', { ascending: true });

  // A read failure used to leave `steps` null, which made every count zero —
  // and zero pending is indistinguishable from "all done", so the workflow
  // would complete itself on a transient database error. Fail instead.
  if (stepsErr) throw new Error(`Failed to read onboarding steps: ${stepsErr.message}`);

  const all = steps || [];
  const completed  = all.filter((s) => s.status === 'completed');
  const pending    = all.filter((s) => s.status === 'pending');
  const inProgress = all.filter((s) => s.status === 'in_progress');
  const failed     = all.filter((s) => s.status === 'failed');
  const blocked    = all.filter((s) => s.status === 'blocked');
  const skipped    = all.filter((s) => s.status === 'skipped');

  // Anything that is not finished and not deliberately skipped holds the
  // workflow. This is the set advanceOnboarding and completion check against.
  const blocking = all.filter(
    (s) => s.status !== 'completed' && s.status !== 'skipped',
  );

  return {
    workflowId: workflow.id,
    tenantId: workflow.tenant_id,
    status: workflow.status,
    currentDay: workflow.current_day,
    startedAt: workflow.started_at,
    completedAt: workflow.completed_at,
    totalSteps: all.length,
    completedCount: completed.length,
    pendingCount: pending.length,
    inProgressCount: inProgress.length,
    failedCount: failed.length,
    blockedCount: blocked.length,
    blockingCount: blocking.length,
    completed,
    pending,
    inProgress,
    failed,
    blocked,
    skipped,
    blocking,
  };
}

// ---------------------------------------------------------------------------
// advanceOnboarding — process next steps based on current day
// ---------------------------------------------------------------------------

async function advanceOnboarding(supabase, tenantId) {
  const status = await getOnboardingStatus(supabase, tenantId);
  if (!status) throw new Error(`No active onboarding for tenant ${tenantId}`);

  const nextDay = status.currentDay + 1;
  if (nextDay > 7) {
    // Onboarding complete
    await _completeWorkflow(supabase, status.workflowId);
    return { advanced: false, message: 'Onboarding already complete' };
  }

  // Check that every step up to today is genuinely resolved.
  //
  // This used to look at `status.pending` alone. A step that failed sat at
  // 'in_progress' and was invisible to this check, so the workflow walked
  // straight past broken steps to go-live. Anything not completed or
  // deliberately skipped blocks.
  const unresolved = status.blocking.filter((s) => s.day <= status.currentDay);
  if (unresolved.length > 0) {
    return {
      advanced: false,
      message: `Cannot advance — ${unresolved.length} step(s) unresolved for day ${status.currentDay}`,
      pendingSteps: unresolved.map((s) => s.step_name),
      blockedBy: unresolved.map((s) => ({
        step: s.step_name,
        status: s.status,
        kind: s.kind,
        error: s.last_error || null,
      })),
    };
  }

  // Advance the day
  const { error: dayErr } = await supabase
    .from('onboarding_workflows')
    .update({ current_day: nextDay })
    .eq('id', status.workflowId);
  // Unchecked, a failure here returned {advanced:true, currentDay:nextDay} to
  // a caller while the stored day never moved.
  if (dayErr) throw new Error(`Failed to advance to day ${nextDay}: ${dayErr.message}`);

  // Run automated steps for the new day
  await _runAutomatedSteps(supabase, tenantId, status.workflowId, nextDay);

  log.info(`Advanced onboarding for tenant ${tenantId} to day ${nextDay}`);

  // If we just hit day 7 and all steps are done, complete
  if (nextDay === 7) {
    const refreshed = await getOnboardingStatus(supabase, tenantId);
    // `pendingCount === 0` was the old test, and it ignored failed, blocked,
    // and in-progress steps — the exact states a broken onboarding sits in.
    if (refreshed && refreshed.blockingCount === 0) {
      await _completeWorkflow(supabase, status.workflowId);
    }
  }

  return { advanced: true, currentDay: nextDay };
}

// ---------------------------------------------------------------------------
// completeStep — mark a specific step done
// ---------------------------------------------------------------------------

async function completeStep(supabase, tenantId, stepId) {
  const { data, error } = await supabase
    .from('onboarding_steps')
    .update({
      status: 'completed',
      completed_at: new Date().toISOString(),
    })
    .eq('id', stepId)
    .eq('tenant_id', tenantId)
    .select()
    .single();

  if (error) throw new Error(`Failed to complete step: ${error.message}`);

  log.info(`Step ${data.step_name} completed for tenant ${tenantId}`);

  // Check if the entire workflow is now done
  const status = await getOnboardingStatus(supabase, tenantId);
  if (status && status.blockingCount === 0) {
    await _completeWorkflow(supabase, status.workflowId);
  }

  return data;
}

/**
 * Mark a step deliberately not-applicable. Distinct from 'completed' — nothing
 * was done — and distinct from 'failed', because nobody needs to fix it.
 * Skipped steps do not block the workflow.
 */
async function skipStep(supabase, tenantId, stepId, reason) {
  const { data, error } = await supabase
    .from('onboarding_steps')
    .update({ status: 'skipped', last_error: reason || 'skipped by operator' })
    .eq('id', stepId)
    .eq('tenant_id', tenantId)
    .select()
    .single();

  if (error) throw new Error(`Failed to skip step: ${error.message}`);

  const status = await getOnboardingStatus(supabase, tenantId);
  if (status && status.blockingCount === 0) {
    await _completeWorkflow(supabase, status.workflowId);
  }
  return data;
}

// ---------------------------------------------------------------------------
// getOnboardingChecklist — full checklist grouped by day
// ---------------------------------------------------------------------------

async function getOnboardingChecklist(supabase, tenantId) {
  const status = await getOnboardingStatus(supabase, tenantId);
  if (!status) return null;

  const allSteps = [...status.completed, ...status.pending, ...status.inProgress];
  allSteps.sort((a, b) => a.day - b.day || a.created_at.localeCompare(b.created_at));

  const checklist = {};
  for (const step of allSteps) {
    const label = _dayLabel(step.day);
    if (!checklist[label]) checklist[label] = [];
    checklist[label].push({
      id: step.id,
      stepName: step.step_name,
      description: step.description,
      status: step.status,
      automated: step.automated,
      completedAt: step.completed_at,
    });
  }

  return {
    workflowId: status.workflowId,
    currentDay: status.currentDay,
    status: status.status,
    startedAt: status.startedAt,
    completedAt: status.completedAt,
    progress: `${status.completedCount}/${status.totalSteps}`,
    checklist,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function _runAutomatedSteps(supabase, tenantId, workflowId, day) {
  const { data: steps } = await supabase
    .from('onboarding_steps')
    .select('*')
    .eq('workflow_id', workflowId)
    .eq('day', day)
    .eq('automated', true)
    .eq('status', 'pending');

  if (!steps || steps.length === 0) return;

  for (const step of steps) {
    try {
      log.info(`Running automated step: ${step.step_name} (day ${day})`);
      await supabase
        .from('onboarding_steps')
        .update({ status: 'in_progress', attempts: (step.attempts || 0) + 1 })
        .eq('id', step.id);

      // A handler either did the work, or it throws. There is no third option
      // — see NotImplementedStep and _executeStepHandler's default branch.
      await _executeStepHandler(supabase, tenantId, step);

      const { error: doneErr } = await supabase
        .from('onboarding_steps')
        .update({ status: 'completed', completed_at: new Date().toISOString(), last_error: null })
        .eq('id', step.id);
      // If we cannot record that it completed, it did not complete as far as
      // anyone can tell. Say so rather than moving on.
      if (doneErr) throw new Error(`step ran but could not be marked complete: ${doneErr.message}`);

    } catch (err) {
      // WHY THIS IS 'failed' AND NOT 'in_progress' (2026-07-30)
      // This used to log the error and leave the row at 'in_progress'.
      // advanceOnboarding only counted 'pending' as blocking, and the day-7
      // completion check only looked at pendingCount — so a step could fail
      // outright and the workflow would still advance, day after day, and
      // mark itself complete. The customer's number was never provisioned and
      // the record said "go_live: completed".
      //
      // 'failed' is counted as blocking, and the reason is persisted so the
      // tracker can show it and a retry has something to act on.
      const blocked = err instanceof NotImplementedStep;
      log.error(`Failed automated step ${step.step_name}: ${err.message}`);
      await supabase
        .from('onboarding_steps')
        .update({
          status: blocked ? 'blocked' : 'failed',
          last_error: err.message,
        })
        .eq('id', step.id);
    }
  }
}

async function _getOnboardingContext(supabase, tenantId) {
  // Fetch the workflow intake data + tenant info for email variable rendering
  const { data: workflow } = await supabase
    .from('onboarding_workflows')
    .select('intake_data')
    .eq('tenant_id', tenantId)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  const intake = workflow?.intake_data || {};

  return {
    owner_name: intake.owner_name || 'there',
    business_name: intake.business_name || '',
    client_email: intake.email || '',
    temp_password: intake.temp_password || '',
    tier_name: intake.tier === 'scale' ? 'Scale' : 'Growth',
    tier_price: intake.tier === 'scale' ? TIER_PRICE.scale : TIER_PRICE.growth,
    module_count: intake.tier === 'scale' ? '15' : '7',
    onboarding_url: 'https://firstgenautomate.com/onboarding',
    portal_url: 'https://firstgenautomate.com/login',
    app_store_url: intake.app_store_url || 'https://apps.apple.com',
    support_email: 'patrick@firstgenautomate.com',
    // Stats for check-in emails (populated later from real data)
    leads_captured: intake.leads_captured || '0',
    follow_ups_sent: intake.follow_ups_sent || '0',
    reviews_requested: intake.reviews_requested || '0',
    posts_published: intake.posts_published || '0',
    ...intake, // allow intake data to override defaults
  };
}

/**
 * HONESTY NOTE (2026-07-10 audit): this step engine drives the 7-day
 * TIMELINE and the email sequence, but several "automated" provisioning
 * handlers below are log-only stubs (preset apply, branding, phone number,
 * Buffer). Real provisioning happens in the `app-asset-pipeline` agent
 * (enqueued at wizard completion) plus founder-run steps (TestFlight build,
 * Day-5 call). The customer-facing 7-day promise is delivered by that
 * combination — do not describe THIS engine as fully automated in docs.
 */
async function _executeStepHandler(supabase, tenantId, step) {
  const ctx = await _getOnboardingContext(supabase, tenantId);
  const clientEmail = ctx.client_email;

  switch (step.step_name) {
    // --- Day 0 ---
    case 'create_tenant': {
      // The tenant is created before the workflow starts, so this step is a
      // verification, not a creation. It used to log and pass unconditionally,
      // which meant it "succeeded" even for a tenant id that did not exist.
      const { data: t, error } = await supabase
        .from('tenants').select('id, slug, status, is_demo').eq('id', tenantId).maybeSingle();
      if (error) throw new Error(`could not verify tenant: ${error.message}`);
      if (!t) throw new Error(`tenant ${tenantId} does not exist`);
      if (t.is_demo) throw new Error(`tenant ${t.slug} is a demo — refusing to onboard it`);
      log.info(`Tenant ${t.slug} verified (status=${t.status})`);
      break;
    }
    case 'apply_preset': {
      // Real: core/config.js already ships the vertical presets. This was a
      // TODO that reported success, so every tenant since day one has been
      // onboarded with no preset applied.
      const { getPreset } = require('./config');
      const vertical = ctx.vertical || ctx.industry;
      if (!vertical) throw new Error('no vertical on the workflow — cannot pick a preset');
      const preset = getPreset(vertical);
      if (!preset) throw new Error(`no preset exists for vertical "${vertical}"`);
      const rows = Object.entries(preset)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([key, value]) => ({ tenant_id: tenantId, key: `preset_${key}`, value }));
      if (rows.length) {
        const { error } = await supabase
          .from('tenant_config').upsert(rows, { onConflict: 'tenant_id,key' });
        if (error) throw new Error(`failed to write preset: ${error.message}`);
      }
      log.info(`Applied "${vertical}" preset (${rows.length} settings) to ${tenantId}`);
      break;
    }
    case 'send_welcome_email':
      requireRecipient(clientEmail, 'send_welcome_email');
      await email.sendWelcomeEmail(clientEmail, ctx);
      log.info(`Welcome email sent to ${clientEmail}`);
      break;
    case 'send_intake_form':
      requireRecipient(clientEmail, 'send_intake_form');
      await email.sendTemplateEmail(clientEmail, 'welcome', {
        ...ctx,
        subject_override: 'Next Step: Complete Your Intake Form',
      }, { subject: 'Next Step: Complete Your Intake Form' });
      log.info(`Intake form link sent to ${clientEmail}`);
      break;

    // --- Day 1-2 ---
    case 'configure_branding':
      throw new NotImplementedStep('configure_branding',
        'logo and colours come from the wizard; the app-asset-pipeline agent '
        + 'consumes them. Nothing writes tenant branding from here yet.');
    case 'provision_phone_number':
      // integrations/telnyx.js provisionLocalNumber() is real and BUYS A
      // NUMBER (real money, and the 10DLC campaign has to be attached).
      // Wiring it is deliberate work, not a line to slip in — leave it
      // blocked so it is done on purpose.
      throw new NotImplementedStep('provision_phone_number',
        'telnyx.provisionLocalNumber() exists but is not wired here — it spends '
        + 'money and needs the messaging profile attached. Provision by hand for now.');
    case 'configure_buffer':
      throw new NotImplementedStep('configure_buffer',
        'Buffer needs the customer to authorise their own social accounts — '
        + 'this cannot be automated end-to-end. Confirm with buffer.isBufferConfigured().');
    case 'import_contacts':
      throw new NotImplementedStep('import_contacts',
        'the wizard collects a customer CSV; no importer reads it into leads yet.');
    case 'configure_messaging':
      throw new NotImplementedStep('configure_messaging',
        'message templates are not yet generated from the tenant brand voice.');
    case 'send_building_email':
      requireRecipient(clientEmail, 'send_building_email');
      await email.sendBuildingEmail(clientEmail, ctx);
      log.info(`System building email sent to ${clientEmail}`);
      break;

    // --- Day 3-4 ---
    case 'generate_content':
      throw new NotImplementedStep('generate_content',
        'the content-generation agent runs on its own cron once the tenant is '
        + 'active; this step does not enqueue a first batch yet.');
    case 'setup_schedule':
      throw new NotImplementedStep('setup_schedule',
        'publishing cadence is not written from here yet.');
    case 'configure_followups':
      throw new NotImplementedStep('configure_followups',
        'follow-up sequences are not seeded from here yet.');
    case 'setup_review_triggers':
      throw new NotImplementedStep('setup_review_triggers',
        'review triggers are not configured from here yet.');
    case 'send_content_ready':
      requireRecipient(clientEmail, 'send_content_ready');
      await email.sendContentReadyEmail(clientEmail, ctx);
      log.info(`Content ready email sent to ${clientEmail}`);
      break;

    // --- Day 5-6 ---
    case 'send_app_ready':
      requireRecipient(clientEmail, 'send_app_ready');
      await email.sendAppReadyEmail(clientEmail, ctx);
      log.info(`App ready email sent to ${clientEmail}`);
      break;
    case 'test_automations':
      throw new NotImplementedStep('test_automations',
        'no end-to-end smoke test exists yet; verify by hand before go-live');
    case 'activate_modules': {
      // Verification, not activation: the modules were enabled at tenant
      // creation. What this catches is a tenant that reached day 6 with none.
      const { data: mods, error } = await supabase
        .from('tenant_modules').select('module, enabled').eq('tenant_id', tenantId);
      if (error) throw new Error(`could not read modules: ${error.message}`);
      const on = (mods || []).filter((m) => m.enabled);
      if (!on.length) throw new Error('tenant has no enabled modules — nothing to go live with');
      log.info(`${on.length} module(s) active for ${tenantId}: ${on.map((m) => m.module).join(', ')}`);
      break;
    }

    // --- Day 7 ---
    case 'go_live': {
      // THE step. Until now it logged "Going live" and changed nothing.
      //
      // This flip is what the whole timeline is for: the scheduler only
      // iterates tenants at status='active', so a tenant that never flips
      // gets zero scheduled agent runs — no content, no follow-ups, no review
      // requests. It is the same root cause that kept 923A's agents from ever
      // running until their status was corrected by hand.
      const { data: t, error: readErr } = await supabase
        .from('tenants').select('status, slug').eq('id', tenantId).maybeSingle();
      if (readErr) throw new Error(`could not read tenant: ${readErr.message}`);
      if (!t) throw new Error(`tenant ${tenantId} does not exist`);

      if (t.status === 'active') {
        log.info(`Tenant ${t.slug} already active`);
        break;
      }

      const { error: flipErr } = await supabase
        .from('tenants').update({ status: 'active' }).eq('id', tenantId);
      if (flipErr) throw new Error(`failed to activate tenant: ${flipErr.message}`);

      // Read it back. An update that matched no rows does not error.
      const { data: after, error: verifyErr } = await supabase
        .from('tenants').select('status').eq('id', tenantId).maybeSingle();
      if (verifyErr) throw new Error(`could not verify activation: ${verifyErr.message}`);
      if (after?.status !== 'active') {
        throw new Error(`activation did not stick — status is still "${after?.status}"`);
      }
      log.success(`Tenant ${t.slug} is live (${t.status} -> active)`);
      break;
    }
    case 'send_golive_email':
      requireRecipient(clientEmail, 'send_golive_email');
      await email.sendGoLiveEmail(clientEmail, ctx);
      log.info(`Go-live email sent to ${clientEmail}`);
      break;
    case 'schedule_checkins':
      requireRecipient(clientEmail, 'schedule_checkins');
      log.info(`Scheduling check-in emails for tenant ${tenantId}`);
      // Store check-in schedule in the database for the worker to pick up
      const now = new Date();
      const checkins = [
        { template: 'check-in-2week', days: 21 },
        { template: 'check-in-30day', days: 37 },
        { template: 'check-in-60day', days: 67 },
      ];
      for (const ci of checkins) {
        const sendAt = new Date(now.getTime() + ci.days * 24 * 60 * 60 * 1000);
        await supabase.from('scheduled_emails').insert({
          tenant_id: tenantId,
          to_email: clientEmail,
          template_name: ci.template,
          template_vars: ctx,
          send_at: sendAt.toISOString(),
          status: 'pending',
        }).then(({ error }) => {
          if (error) log.warn(`Could not schedule ${ci.template}: ${error.message}`);
          else log.info(`Scheduled ${ci.template} for ${sendAt.toISOString()}`);
        });
      }
      break;

    // founder / customer steps have no handler by design — a human clears
    // them via completeStep. They are never routed here (_runAutomatedSteps
    // filters on automated=true), so reaching this branch means the step was
    // seeded with the wrong kind.
    default:
      throw new NotImplementedStep(step.step_name,
        'no handler is registered for this step name');
  }
}

async function _completeWorkflow(supabase, workflowId) {
  await supabase
    .from('onboarding_workflows')
    .update({
      status: 'completed',
      completed_at: new Date().toISOString(),
    })
    .eq('id', workflowId);

  log.info(`Onboarding workflow ${workflowId} completed`);
}

function _dayLabel(day) {
  switch (day) {
    case 0: return 'Day 0 — Contract Signed';
    case 1: return 'Day 1-2 — System Setup';
    case 2: return 'Day 1-2 — System Setup';
    case 3: return 'Day 3-4 — Content Generation';
    case 4: return 'Day 3-4 — Content Generation';
    case 5: return 'Day 5-6 — Client Activation';
    case 6: return 'Day 5-6 — Client Activation';
    case 7: return 'Day 7 — Go Live';
    default: return `Day ${day}`;
  }
}

module.exports = {
  createClientAccount,
  startOnboarding,
  getOnboardingStatus,
  advanceOnboarding,
  completeStep,
  skipStep,
  getOnboardingChecklist,
  resolveWorkflowSteps,
  ONBOARDING_STEPS,
  NotImplementedStep,
  // Exposed so tests can run individual handlers directly. The handlers are
  // where the false-success bugs lived, so they have to be reachable by a test
  // that asserts on what they wrote — not by grepping the file for a string.
  _internals: { _executeStepHandler, _runAutomatedSteps, _completeWorkflow },
};
