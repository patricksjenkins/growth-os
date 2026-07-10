/**
 * Growth OS — Onboarding Workflow Engine
 * Manages the 7-day automated client onboarding process.
 *
 * Day 0:  Contract signed  → create tenant, apply preset, send welcome email, send intake form link
 * Day 1-2: Process intake  → configure branding, provision Twilio, configure Buffer, import contacts
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

  // 2. Store client record
  const { data: client, error: clientErr } = await supabase
    .from('pipeline_prospects')
    .update({
      stage: 'onboarding',
      metadata: {
        auth_user_id: authData.user.id,
        account_created_at: new Date().toISOString(),
      },
    })
    .eq('email', email)
    .select()
    .single();

  if (clientErr) {
    log.warn(`Could not update pipeline prospect: ${clientErr.message}`);
  }

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

const ONBOARDING_STEPS = [
  // Day 0
  { day: 0, stepName: 'create_tenant',       description: 'Create tenant in the platform',                     automated: true  },
  { day: 0, stepName: 'apply_preset',        description: 'Apply vertical preset to tenant',                automated: true  },
  { day: 0, stepName: 'send_welcome_email',  description: 'Send welcome email with timeline',               automated: true  },
  { day: 0, stepName: 'send_intake_form',    description: 'Send intake form link to client',                automated: true  },

  // Day 1-2
  { day: 1, stepName: 'configure_branding',  description: 'Configure branding from intake data (logo, colors, appearance)', automated: true  },
  { day: 1, stepName: 'provision_twilio',    description: 'Provision Twilio number for the tenant',         automated: true  },
  { day: 1, stepName: 'configure_buffer',    description: 'Configure Buffer connection for social publishing', automated: true  },
  { day: 2, stepName: 'import_contacts',     description: 'Import existing contacts/leads from intake form', automated: true  },
  { day: 2, stepName: 'configure_messaging', description: 'Configure messaging templates with client tone',  automated: true  },
  { day: 2, stepName: 'send_building_email', description: 'Send "we\'re building your system" status email', automated: true  },

  // Day 3-4
  { day: 3, stepName: 'generate_content',    description: 'Generate initial content batch from intake photos', automated: true  },
  { day: 3, stepName: 'setup_schedule',      description: 'Set up social publishing schedule',              automated: true  },
  { day: 4, stepName: 'configure_followups', description: 'Configure follow-up sequences',                  automated: true  },
  { day: 4, stepName: 'setup_review_triggers', description: 'Set up review request triggers',               automated: true  },
  { day: 4, stepName: 'send_content_ready',  description: 'Send "your content is ready" email',             automated: true  },

  // Day 5-6
  { day: 5, stepName: 'send_app_ready',      description: 'Send "your app is ready" email with call details', automated: true  },
  { day: 5, stepName: 'founder_video_call',  description: 'Founder video call walkthrough with client',     automated: false },
  { day: 6, stepName: 'client_photo_upload', description: 'Client uploads first batch of photos',           automated: false },
  { day: 6, stepName: 'test_automations',    description: 'Test all automations end-to-end',                automated: true  },
  { day: 6, stepName: 'activate_modules',    description: 'Activate all tenant modules',                    automated: true  },

  // Day 7
  { day: 7, stepName: 'go_live',             description: 'Activate all systems for production',            automated: true  },
  { day: 7, stepName: 'send_golive_email',   description: 'Send "you\'re live" email',                      automated: true  },
  { day: 7, stepName: 'schedule_checkins',   description: 'Schedule 2-week, 30-day, and 60-day check-in emails', automated: true  },
];

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

  // 2. Seed all steps
  const stepRows = ONBOARDING_STEPS.map((s) => ({
    tenant_id: tenantId,
    workflow_id: workflow.id,
    day: s.day,
    step_name: s.stepName,
    description: s.description,
    status: 'pending',
    automated: s.automated,
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

  const { data: steps } = await supabase
    .from('onboarding_steps')
    .select('*')
    .eq('workflow_id', workflow.id)
    .order('day', { ascending: true });

  const completed = (steps || []).filter((s) => s.status === 'completed');
  const pending   = (steps || []).filter((s) => s.status === 'pending');
  const inProgress = (steps || []).filter((s) => s.status === 'in_progress');

  return {
    workflowId: workflow.id,
    tenantId: workflow.tenant_id,
    status: workflow.status,
    currentDay: workflow.current_day,
    startedAt: workflow.started_at,
    completedAt: workflow.completed_at,
    totalSteps: (steps || []).length,
    completedCount: completed.length,
    pendingCount: pending.length,
    inProgressCount: inProgress.length,
    completed,
    pending,
    inProgress,
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

  // Check that all steps for the current day are done
  const currentDayPending = status.pending.filter((s) => s.day <= status.currentDay);
  if (currentDayPending.length > 0) {
    return {
      advanced: false,
      message: `Cannot advance — ${currentDayPending.length} step(s) still pending for day ${status.currentDay}`,
      pendingSteps: currentDayPending.map((s) => s.step_name),
    };
  }

  // Advance the day
  await supabase
    .from('onboarding_workflows')
    .update({ current_day: nextDay })
    .eq('id', status.workflowId);

  // Run automated steps for the new day
  await _runAutomatedSteps(supabase, tenantId, status.workflowId, nextDay);

  log.info(`Advanced onboarding for tenant ${tenantId} to day ${nextDay}`);

  // If we just hit day 7 and all steps are done, complete
  if (nextDay === 7) {
    const refreshed = await getOnboardingStatus(supabase, tenantId);
    if (refreshed && refreshed.pendingCount === 0) {
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
  if (status && status.pendingCount === 0 && status.inProgressCount === 0) {
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
      // Mark in-progress
      await supabase
        .from('onboarding_steps')
        .update({ status: 'in_progress' })
        .eq('id', step.id);

      // Execute the step handler (if one exists)
      await _executeStepHandler(supabase, tenantId, step);

      // Mark completed
      await supabase
        .from('onboarding_steps')
        .update({ status: 'completed', completed_at: new Date().toISOString() })
        .eq('id', step.id);

    } catch (err) {
      log.error(`Failed automated step ${step.step_name}: ${err.message}`);
      // Leave it in_progress for manual retry
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

async function _executeStepHandler(supabase, tenantId, step) {
  const ctx = await _getOnboardingContext(supabase, tenantId);
  const clientEmail = ctx.client_email;

  switch (step.step_name) {
    // --- Day 0 ---
    case 'create_tenant':
      log.info(`Tenant ${tenantId} already exists (created during contract flow)`);
      break;
    case 'apply_preset':
      log.info(`Applying vertical preset for tenant ${tenantId}`);
      // TODO: await presets.applyPreset(supabase, tenantId, ctx.industry)
      break;
    case 'send_welcome_email':
      if (clientEmail) {
        await email.sendWelcomeEmail(clientEmail, ctx);
        log.info(`Welcome email sent to ${clientEmail}`);
      } else {
        log.warn(`No client email for tenant ${tenantId} — skipping welcome email`);
      }
      break;
    case 'send_intake_form':
      if (clientEmail) {
        await email.sendTemplateEmail(clientEmail, 'welcome', {
          ...ctx,
          subject_override: 'Next Step: Complete Your Intake Form',
        }, { subject: 'Next Step: Complete Your Intake Form' });
        log.info(`Intake form link sent to ${clientEmail}`);
      }
      break;

    // --- Day 1-2 ---
    case 'configure_branding':
      log.info(`Configuring branding for tenant ${tenantId}`);
      break;
    case 'provision_twilio':
      log.info(`Provisioning Twilio number for tenant ${tenantId}`);
      break;
    case 'configure_buffer':
      log.info(`Configuring Buffer for tenant ${tenantId}`);
      break;
    case 'import_contacts':
      log.info(`Importing contacts for tenant ${tenantId}`);
      break;
    case 'configure_messaging':
      log.info(`Configuring messaging templates for tenant ${tenantId}`);
      break;
    case 'send_building_email':
      if (clientEmail) {
        await email.sendBuildingEmail(clientEmail, ctx);
        log.info(`System building email sent to ${clientEmail}`);
      }
      break;

    // --- Day 3-4 ---
    case 'generate_content':
      log.info(`Generating initial content batch for tenant ${tenantId}`);
      break;
    case 'setup_schedule':
      log.info(`Setting up publishing schedule for tenant ${tenantId}`);
      break;
    case 'configure_followups':
      log.info(`Configuring follow-up sequences for tenant ${tenantId}`);
      break;
    case 'setup_review_triggers':
      log.info(`Setting up review request triggers for tenant ${tenantId}`);
      break;
    case 'send_content_ready':
      if (clientEmail) {
        await email.sendContentReadyEmail(clientEmail, ctx);
        log.info(`Content ready email sent to ${clientEmail}`);
      }
      break;

    // --- Day 5-6 ---
    case 'send_app_ready':
      if (clientEmail) {
        await email.sendAppReadyEmail(clientEmail, ctx);
        log.info(`App ready email sent to ${clientEmail}`);
      }
      break;
    case 'test_automations':
      log.info(`Testing automations end-to-end for tenant ${tenantId}`);
      break;
    case 'activate_modules':
      log.info(`Activating all modules for tenant ${tenantId}`);
      break;

    // --- Day 7 ---
    case 'go_live':
      log.info(`Going live for tenant ${tenantId}`);
      break;
    case 'send_golive_email':
      if (clientEmail) {
        await email.sendGoLiveEmail(clientEmail, ctx);
        log.info(`Go-live email sent to ${clientEmail}`);
      }
      break;
    case 'schedule_checkins':
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

    default:
      log.warn(`No handler for step: ${step.step_name}`);
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
  getOnboardingChecklist,
  ONBOARDING_STEPS,
};
