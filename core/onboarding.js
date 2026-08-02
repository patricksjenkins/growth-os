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

/**
 * Thrown when a step cannot proceed because a PERSON has not done their part
 * yet — the customer has not finished that wizard step, or Patrick has not run
 * a founder task.
 *
 * This is not a failure and nobody needs to debug it. It parks the step at
 * status='waiting' with a plain-English note about who is being waited on and
 * what they need to do. It still blocks the timeline, because advancing past
 * it would mean going live without the thing.
 *
 * Kept distinct from NotImplementedStep on purpose: "the customer has not
 * uploaded a logo" and "we never built logo handling" look identical in a log
 * and need completely different responses.
 */
class WaitingOnPerson extends Error {
  constructor(who, whatTheyNeedToDo) {
    super(`waiting on ${who}: ${whatTheyNeedToDo}`);
    this.name = 'WaitingOnPerson';
    this.who = who;
  }
}

/** Read a set of tenant_config keys into a plain object. */
async function _config(supabase, tenantId, keys) {
  const { data, error } = await supabase
    .from('tenant_config').select('key, value').eq('tenant_id', tenantId);
  if (error) throw new Error(`could not read tenant config: ${error.message}`);
  const all = Object.fromEntries((data || []).map((r) => [r.key, r.value]));
  if (!keys) return all;
  return Object.fromEntries(keys.map((k) => [k, all[k]]));
}

/** Write tenant_config rows, failing loudly. */
async function _writeConfig(supabase, tenantId, obj) {
  const rows = Object.entries(obj)
    .filter(([, v]) => v !== undefined)
    .map(([key, value]) => ({ tenant_id: tenantId, key, value }));
  if (!rows.length) return;
  const { error } = await supabase
    .from('tenant_config').upsert(rows, { onConflict: 'tenant_id,key' });
  if (error) throw new Error(`could not write tenant config: ${error.message}`);
}

/** Module keys enabled for this tenant. */
async function _enabledModules(supabase, tenantId) {
  const { data, error } = await supabase
    .from('tenant_modules').select('module, enabled').eq('tenant_id', tenantId);
  if (error) throw new Error(`could not read modules: ${error.message}`);
  return new Set((data || []).filter((m) => m.enabled).map((m) => m.module));
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
  // Provider-neutral name so swapping carriers does not strand a stale one.
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

  // Work out the steps BEFORE creating anything.
  //
  // The workflow row used to be inserted first, then the modules validated,
  // then the steps seeded. Any failure after that insert left an ACTIVE,
  // EMPTY workflow: the Center rendered 0/0 with nothing to click, and a
  // replayed Stripe webhook saw an active workflow and refused to retry —
  // so the tenant was permanently stuck in a state nobody could clear.
  //
  // Nothing is written until we know what we are writing.
  let modules = Array.isArray(intakeData.modules) && intakeData.modules.length
    ? intakeData.modules
    : null;
  if (!modules) {
    const { data: mods, error: modErr } = await supabase
      .from('tenant_modules').select('module, enabled').eq('tenant_id', tenantId);
    if (modErr) throw new Error(`could not read tenant modules: ${modErr.message}`);
    modules = (mods || []).filter((m) => m.enabled).map((m) => m.module);
  }
  if (!modules.length) {
    throw new Error('cannot start onboarding: the tenant has no enabled modules');
  }

  const steps = resolveWorkflowSteps(modules, {
    welcomeAlreadySent: intakeData.welcomeAlreadySent === true,
  });
  if (!steps.length) {
    throw new Error('cannot start onboarding: no steps apply to these modules');
  }

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

  // 2. Seed the steps worked out above.
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

  if (stepsErr) {
    // Undo the workflow rather than leave an active one with no steps.
    await supabase.from('onboarding_workflows').delete().eq('id', workflow.id);
    throw new Error(`Failed to seed onboarding steps: ${stepsErr.message}`);
  }

  // 3. Nothing runs. Not even day 0.
  //
  // This used to fire the day-0 steps immediately, which meant creating a
  // tenant sent the customer an email as a side effect. Onboarding is now
  // driven by hand from the Onboarding Center: the steps are seeded ready to
  // go, and each one waits for Patrick to click it.
  //
  // The rule is worth stating plainly because it is the whole design: if the
  // customer received something, he sent it.

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
  const waiting    = all.filter((s) => s.status === 'waiting');
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
    waitingCount: waiting.length,
    blockingCount: blocking.length,
    completed,
    pending,
    inProgress,
    failed,
    blocked,
    waiting,
    skipped,
    blocking,
  };
}

// ---------------------------------------------------------------------------
// advanceOnboarding — process next steps based on current day
// ---------------------------------------------------------------------------

async function advanceOnboarding(supabase, tenantId) {
  let status = await getOnboardingStatus(supabase, tenantId);
  if (!status) throw new Error(`No active onboarding for tenant ${tenantId}`);

  // Retry everything still unresolved from earlier days BEFORE deciding
  // whether we can move.
  //
  // Without this the timeline deadlocks permanently on its most common state.
  // Most day-1/day-2 steps wait on the customer finishing the wizard, so they
  // park at 'waiting' on the first run. The customer then fills the wizard in
  // that evening — and nothing ever looks at those steps again, because the
  // runner only ever picked up status='pending' for the single new day. The
  // client would sit blocked forever on work they had already done.
  await _retryUnresolvedSteps(supabase, tenantId, status);
  status = await getOnboardingStatus(supabase, tenantId);

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

/**
 * Re-run automated steps from earlier days that are still waiting or failed.
 *
 * A 'waiting' step means a person owed us something — almost always a wizard
 * field. Once they provide it the step will succeed, but only if something
 * asks it again. This is that something, and it runs on every daily tick.
 *
 * 'blocked' is not retried: nothing about waiting changes unbuilt code.
 */
async function _retryUnresolvedSteps(supabase, tenantId, status) {
  const retryable = status.blocking.filter(
    (s) => s.automated
      && s.day <= status.currentDay
      && (s.status === 'waiting' || s.status === 'failed'),
  );
  if (!retryable.length) return;

  log.info(`Retrying ${retryable.length} unresolved step(s) for tenant ${tenantId}`);
  for (const step of retryable) {
    // Put it back to pending so the normal runner picks it up, then run that
    // step's day. _runAutomatedSteps is idempotent per step.
    await supabase
      .from('onboarding_steps').update({ status: 'pending' }).eq('id', step.id);
  }
  const days = [...new Set(retryable.map((s) => s.day))].sort((a, b) => a - b);
  for (const day of days) {
    await _runAutomatedSteps(supabase, tenantId, status.workflowId, day);
  }
}

async function _runAutomatedSteps(supabase, tenantId, workflowId, day) {
  const { data: steps, error: readErr } = await supabase
    .from('onboarding_steps')
    .select('*')
    .eq('workflow_id', workflowId)
    .eq('day', day)
    .eq('automated', true)
    .eq('status', 'pending');

  // A read failure here is silent otherwise: no steps found looks exactly like
  // no steps to run, so the day would appear to complete having done nothing.
  if (readErr) throw new Error(`could not read day ${day} steps: ${readErr.message}`);
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
      // Three different situations, three different states, because they need
      // three different responses:
      //   waiting — a person owes us something (customer hasn't finished the
      //             wizard, Patrick hasn't connected Buffer). Not an error.
      //   blocked — we never built it. Engineering work.
      //   failed  — it tried and broke. Someone debugs it.
      // All three hold the timeline; only 'failed' is a fault.
      let status = 'failed';
      if (err instanceof WaitingOnPerson) status = 'waiting';
      else if (err instanceof NotImplementedStep) status = 'blocked';

      if (status === 'waiting') {
        log.info(`Step ${step.step_name} is ${err.message}`);
      } else {
        log.error(`Failed automated step ${step.step_name}: ${err.message}`);
      }
      await supabase
        .from('onboarding_steps')
        .update({ status, last_error: err.message })
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
      if (!preset) {
        // Only three verticals have a preset (tree-service, benefits-consulting,
        // saas-company). Everything else legitimately has none, and the config
        // layer falls through to platform defaults on its own — so there is
        // genuinely nothing to apply and the tenant is correctly configured.
        // Record that explicitly rather than leaving it ambiguous.
        await _writeConfig(supabase, tenantId, {
          preset_applied: `none — no preset exists for "${vertical}", using platform defaults`,
        });
        log.info(`No preset for vertical "${vertical}" — platform defaults apply`);
        break;
      }
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
    case 'configure_branding': {
      // The wizard captures logo + colours; the app-asset-pipeline agent turns
      // them into the app icon and listing. This step's job is to confirm we
      // actually have usable inputs and record that branding is settled — so
      // the timeline stops here if the customer skipped it, rather than
      // building an app with no logo.
      const c = await _config(supabase, tenantId, ['logo_url', 'color_primary', 'color_secondary']);
      const missing = [];
      if (!c.logo_url) missing.push('a logo');
      if (!c.color_primary) missing.push('brand colours');
      if (missing.length) {
        throw new WaitingOnPerson('the customer',
          `finish the wizard — still needs ${missing.join(' and ')}`);
      }
      await _writeConfig(supabase, tenantId, {
        branding_configured_at: new Date().toISOString(),
      });
      log.info(`Branding confirmed for ${tenantId} (logo + ${c.color_primary})`);
      break;
    }

    case 'provision_phone_number': {
      // Buys a real number on the platform Telnyx account and attaches the
      // messaging profile that carries the approved 10DLC campaign. Only
      // reached when the client bought an SMS-using module (see
      // requiresModules on this step), so we are not buying numbers nobody
      // will send from.
      const c = await _config(supabase, tenantId, ['telnyx_phone_number', 'phone', 'business_address']);
      if (c.telnyx_phone_number) {
        // Idempotent: a rerun must not buy a second number.
        log.info(`Tenant ${tenantId} already has ${c.telnyx_phone_number}`);
        break;
      }
      if (!process.env.TELNYX_API_KEY) {
        throw new Error('TELNYX_API_KEY is not set — cannot provision a number');
      }
      if (!process.env.TELNYX_MESSAGING_PROFILE_ID) {
        // Without the profile the number exists but carries no 10DLC campaign,
        // so every SMS from it is rejected. Better to stop than to buy a
        // number that cannot send.
        throw new Error('TELNYX_MESSAGING_PROFILE_ID is not set — a number without '
          + 'the messaging profile cannot send SMS');
      }
      const telnyx = require('../integrations/telnyx');
      // Match the owner's own area code where we know it, so the number looks
      // local to their customers.
      const areaCode = String(c.phone || '').replace(/\D/g, '').replace(/^1/, '').slice(0, 3) || undefined;
      const { data: t } = await supabase
        .from('tenants').select('slug').eq('id', tenantId).maybeSingle();
      const bought = await telnyx.provisionLocalNumber({
        areaCode, tenantSlug: t?.slug, friendlyName: `First Gen Automate — ${t?.slug || tenantId}`,
      });
      if (!bought?.phone_number) throw new Error('Telnyx returned no phone number');
      if (bought.sid) {
        await telnyx.configureNumberWebhooks(bought.sid, {});
      }
      await _writeConfig(supabase, tenantId, {
        telnyx_phone_number: bought.phone_number,
        telnyx_number_provisioned_at: new Date().toISOString(),
      });
      log.success(`Provisioned ${bought.phone_number} for ${t?.slug || tenantId}`);
      break;
    }

    case 'configure_buffer': {
      // FGA owns the Buffer account (CLAUDE.md: customers never touch API
      // keys), so this is not customer OAuth. What it needs is the client's
      // social profiles connected inside our Buffer — a founder task we cannot
      // do from here, but we CAN tell whether it has been done.
      const { data: integ, error } = await supabase
        .from('tenant_integrations').select('service, config')
        .eq('tenant_id', tenantId).eq('service', 'buffer').maybeSingle();
      if (error) throw new Error(`could not read integrations: ${error.message}`);
      if (integ?.config?.profile_ids?.length) {
        log.info(`Buffer already connected for ${tenantId}`);
        break;
      }
      const c = await _config(supabase, tenantId, ['facebook_url', 'instagram_url']);
      if (c.facebook_url || c.instagram_url) {
        throw new WaitingOnPerson('Patrick',
          'connect the client\'s Facebook/Instagram inside FGA\'s Buffer account, '
          + 'then save the profile ids on their buffer integration row');
      }
      throw new WaitingOnPerson('the customer',
        'give us their Facebook/Instagram in the wizard so we can connect Buffer');
    }

    case 'import_contacts': {
      // The wizard's `customers` step collects an existing customer list. An
      // empty list is a legitimate answer — plenty of owners have nothing to
      // import — but a list we never looked at is not.
      const c = await _config(supabase, tenantId, ['customers', 'onboarding_steps_completed']);
      const done = Array.isArray(c.onboarding_steps_completed) ? c.onboarding_steps_completed : [];
      const list = Array.isArray(c.customers) ? c.customers : [];

      if (!list.length) {
        if (!done.includes('customers')) {
          throw new WaitingOnPerson('the customer',
            'complete the customer-list step in the wizard (an empty list is fine, '
            + 'but we need them to say so)');
        }
        log.info(`No contacts to import for ${tenantId} — customer had none`);
        break;
      }

      // Skip anyone already present so a rerun does not duplicate the list.
      const { data: existing, error: exErr } = await supabase
        .from('leads').select('email, phone').eq('tenant_id', tenantId);
      if (exErr) throw new Error(`could not read existing leads: ${exErr.message}`);
      const seen = new Set();
      for (const l of existing || []) {
        if (l.email) seen.add(`e:${String(l.email).toLowerCase()}`);
        if (l.phone) seen.add(`p:${String(l.phone).replace(/\D/g, '')}`);
      }

      const rows = [];
      for (const raw of list) {
        const person = typeof raw === 'string' ? { name: raw } : (raw || {});
        const em = person.email ? String(person.email).toLowerCase().trim() : null;
        const ph = person.phone ? String(person.phone).replace(/\D/g, '') : null;
        if (!em && !ph) continue;                       // nothing to contact them on
        if (em && seen.has(`e:${em}`)) continue;
        if (ph && seen.has(`p:${ph}`)) continue;
        if (em) seen.add(`e:${em}`);
        if (ph) seen.add(`p:${ph}`);
        rows.push({
          tenant_id: tenantId,
          name: person.name || person.full_name || null,
          email: em,
          phone: person.phone || null,
          // Past customers, NOT new prospects — this must never look like a
          // cold list to the outreach side.
          source: 'onboarding_import',
          status: 'past_customer',
        });
      }

      if (rows.length) {
        const { error: insErr } = await supabase.from('leads').insert(rows);
        if (insErr) throw new Error(`contact import failed: ${insErr.message}`);
      }
      log.success(`Imported ${rows.length} contact(s) for ${tenantId} `
        + `(${list.length - rows.length} skipped as duplicate or uncontactable)`);
      break;
    }

    case 'configure_messaging': {
      // The wizard's `brand_voice` step captures three sentences in the
      // owner's own words. Every AI-written message for this tenant is
      // supposed to sound like those. Without them the tenant gets generic
      // copy, which is the thing customers notice first.
      const c = await _config(supabase, tenantId, ['brand_voice', 'key_services', 'business_hours']);
      const voice = Array.isArray(c.brand_voice)
        ? c.brand_voice.filter(Boolean)
        : (c.brand_voice ? [c.brand_voice] : []);
      if (!voice.length) {
        throw new WaitingOnPerson('the customer',
          'write the three brand-voice sentences in the wizard');
      }
      await _writeConfig(supabase, tenantId, {
        messaging_tone: voice.join(' '),
        messaging_configured_at: new Date().toISOString(),
      });
      log.info(`Messaging tone set for ${tenantId} from ${voice.length} sample sentence(s)`);
      break;
    }
    case 'send_building_email':
      requireRecipient(clientEmail, 'send_building_email');
      await email.sendBuildingEmail(clientEmail, ctx);
      log.info(`System building email sent to ${clientEmail}`);
      break;

    // --- Day 3-4 ---
    case 'generate_content': {
      // The content crons only run once the tenant is active, which does not
      // happen until day 7. So the customer would reach their go-live call
      // with an empty approval queue and nothing to look at. Enqueue a first
      // batch now so there is real content waiting for them.
      const c = await _config(supabase, tenantId, ['brand_voice', 'key_services', 'photos']);
      if (!c.key_services) {
        throw new WaitingOnPerson('the customer',
          'list their services in the wizard — content cannot be written without them');
      }
      const { data: already, error: qErr } = await supabase
        .from('agent_jobs').select('id')
        .eq('tenant_id', tenantId).eq('agent_name', 'content-generation')
        .limit(1);
      if (qErr) throw new Error(`could not check existing jobs: ${qErr.message}`);
      if (already?.length) {
        log.info(`Content generation already queued for ${tenantId}`);
        break;
      }
      const { error: jobErr } = await supabase.from('agent_jobs').insert({
        tenant_id: tenantId,
        agent_name: 'content-generation',
        status: 'pending',
        priority: 5,
        payload: { trigger: 'onboarding_day3_first_batch' },
      });
      if (jobErr) throw new Error(`could not queue content generation: ${jobErr.message}`);
      log.success(`Queued the first content batch for ${tenantId}`);
      break;
    }

    case 'setup_schedule': {
      // Publishing cadence. Defaults match the platform's Mon/Thu rhythm
      // (worker/scheduler/cron.js) so what we write here and what actually
      // runs agree.
      const existing = await _config(supabase, tenantId, ['publishing_schedule']);
      if (existing.publishing_schedule) {
        log.info(`Publishing schedule already set for ${tenantId}`);
        break;
      }
      await _writeConfig(supabase, tenantId, {
        publishing_schedule: { days: ['monday', 'thursday'], post_hour_et: 11 },
        publishing_schedule_set_at: new Date().toISOString(),
      });
      log.info(`Publishing schedule set for ${tenantId} (Mon + Thu, 11am ET)`);
      break;
    }

    case 'configure_followups': {
      // Cadence for the follow-up agent. It runs Mon/Wed/Fri; these are the
      // per-tenant knobs it reads.
      const existing = await _config(supabase, tenantId, ['follow_up_config']);
      if (existing.follow_up_config) {
        log.info(`Follow-up config already set for ${tenantId}`);
        break;
      }
      await _writeConfig(supabase, tenantId, {
        follow_up_config: {
          estimate_followup_days: [2, 5, 10],
          past_customer_reengagement_months: 6,
          stop_after_reply: true,
        },
        follow_ups_configured_at: new Date().toISOString(),
      });
      log.info(`Follow-up sequences configured for ${tenantId}`);
      break;
    }

    case 'setup_review_triggers': {
      // The review agent needs somewhere to send people. Without the Google
      // review URL it would ask for a review and give no link, which is worse
      // than not asking.
      const c = await _config(supabase, tenantId, ['google_review_url', 'review_delay_days']);
      if (!c.google_review_url) {
        throw new WaitingOnPerson('the customer',
          'paste their Google Business Profile review link in the wizard — '
          + 'review requests have nowhere to send people without it');
      }
      await _writeConfig(supabase, tenantId, {
        review_delay_days: c.review_delay_days ?? 1,
        review_triggers_configured_at: new Date().toISOString(),
      });
      log.info(`Review triggers configured for ${tenantId}`);
      break;
    }
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
    case 'test_automations': {
      // The last gate before go-live. Checks that each module the client
      // bought has the thing it needs to actually work — because the failure
      // mode we keep hitting is a module that is enabled, looks fine on a
      // dashboard, and silently does nothing.
      const mods = await _enabledModules(supabase, tenantId);
      const c = await _config(supabase, tenantId);
      const problems = [];

      const needsSms = ['missed_call', 'speed_to_lead', 'follow_up', 'review_request']
        .some((m) => mods.has(m));
      if (needsSms && !c.telnyx_phone_number) {
        problems.push('SMS modules are on but the tenant has no phone number');
      }
      if (mods.has('content_engine') && !mods.has('publishing')) {
        // The 923A shape: posts generate every week and reach nobody.
        problems.push('content_engine is on without publishing — posts would '
          + 'generate and never go out');
      }
      if (mods.has('publishing') && !mods.has('approval_queue')) {
        problems.push('publishing is on without approval_queue — content would '
          + 'go out unreviewed');
      }
      if (mods.has('review_request') && !c.google_review_url) {
        problems.push('review_request is on but there is no Google review link');
      }
      if (mods.has('voice_receptionist') && !c.voice_receptionist_forward_to) {
        problems.push('voice_receptionist is on but has no forward-to number');
      }
      if (mods.has('prospecting') && !(c.target_states && c.target_industries)) {
        // A tenant with prospecting and no ICP fails its run every morning.
        problems.push('prospecting is on with no ICP (target_states + '
          + 'target_industries) — its daily run would fail every morning');
      }
      if (!c.logo_url) {
        problems.push('no logo — the branded app and content have nothing to use');
      }

      if (problems.length) {
        throw new Error(`not ready to go live:\n  - ${problems.join('\n  - ')}`);
      }
      await _writeConfig(supabase, tenantId, {
        preflight_passed_at: new Date().toISOString(),
      });
      log.success(`Pre-go-live checks passed for ${tenantId} (${mods.size} modules)`);
      break;
    }
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

/**
 * Everything the Onboarding Center needs to preview or run a step:
 *   context — the variables an email template renders with
 *   config  — every tenant_config key, for the warning checks
 *   modules — the module keys actually enabled
 *
 * One call so a preview and the send that follows it see identical state.
 */
async function loadCenterContext(supabase, tenantId) {
  const [context, config, modules] = await Promise.all([
    _getOnboardingContext(supabase, tenantId),
    _config(supabase, tenantId),
    _enabledModules(supabase, tenantId),
  ]);
  return { context, config, modules };
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
  loadCenterContext,
  dayLabel: _dayLabel,
  ONBOARDING_STEPS,
  NotImplementedStep,
  WaitingOnPerson,
  // Exposed so tests can run individual handlers directly. The handlers are
  // where the false-success bugs lived, so they have to be reachable by a test
  // that asserts on what they wrote — not by grepping the file for a string.
  _internals: { _executeStepHandler, _runAutomatedSteps, _retryUnresolvedSteps, _completeWorkflow },
};
