'use strict';

/**
 * The Onboarding Center — manual, with assistance.
 *
 * THE RULE (Patrick, 2026-08-02)
 * Nothing goes out on its own. Every step is staged and ready, and every one
 * of them waits for a click. If a customer received something, he sent it.
 *
 * That is a deliberate reversal. The engine used to advance on a 3am cron and
 * fire steps by itself; the cron entry is gone and startOnboarding no longer
 * runs day 0. What survives is the checklist — `onboarding_steps`, still
 * seeded only for the modules the client bought — and this module, which gives
 * every step two operations:
 *
 *   previewStep()  what WOULD happen. For an email: the rendered subject and
 *                  body with their details filled in, ready to read and edit.
 *                  For an action: a plain sentence, plus anything it needs
 *                  that is missing. Sends nothing. Changes nothing.
 *
 *   runStep()      does it, for real, once. Emails accept an edited subject
 *                  and body so Patrick can change the wording first.
 *
 * Steps can be worked in any order. Where a step depends on something else,
 * that surfaces as a WARNING with the missing piece named — it does not block.
 * He knows his customers; the system's job is to tell him what it can see, not
 * to argue.
 */

const { createLogger } = require('./logger');
const email = require('../integrations/email');
const log = createLogger('onboarding-center');

// ---------------------------------------------------------------------------
// Which steps send email, and from which template
// ---------------------------------------------------------------------------

/**
 * step_name -> template. A step in here is a SEND: it gets a readable,
 * editable preview and its run() delivers the (possibly edited) copy.
 * Everything else is an ACTION.
 */
const EMAIL_STEPS = Object.freeze({
  send_welcome_email:  'welcome',
  send_intake_form:    'welcome',
  send_building_email: 'system-building',
  send_content_ready:  'content-ready',
  send_app_ready:      'app-ready',
  send_golive_email:   'go-live',
});

/** Subject overrides where the template's default does not fit the step. */
const STEP_SUBJECTS = Object.freeze({
  send_intake_form: 'Next step: your setup form',
});

/**
 * What each action step will do, in words Patrick can check before clicking.
 * Absent from here means the step is a person's job (the founder call, the
 * customer's photos) and simply gets ticked off.
 */
const ACTION_DESCRIPTIONS = Object.freeze({
  create_tenant:        'Check the tenant exists and is not a demo.',
  apply_preset:         'Apply the vertical preset, or record that none exists for this vertical.',
  configure_branding:   'Confirm we have a logo and brand colours to build with.',
  provision_phone_number: 'Buy a Telnyx number and attach the messaging profile. This spends money.',
  configure_buffer:     'Check whether their social accounts are connected in Buffer.',
  import_contacts:      'Import their customer list into leads, skipping anyone already there.',
  configure_messaging:  'Write the message tone from their brand-voice sentences.',
  generate_content:     'Queue the first batch of content so there is something to approve.',
  setup_schedule:       'Set the publishing cadence (Mon + Thu, 11am ET).',
  configure_followups:  'Set the follow-up cadence the follow-up agent reads.',
  setup_review_triggers: 'Set when review requests fire after a job.',
  test_automations:     'Run the pre-go-live checks and report anything that would silently do nothing.',
  activate_modules:     'Confirm the modules they bought are enabled.',
  go_live:              'Flip them to active. This is what starts their agents running.',
  schedule_checkins:    'Queue the 2-week, 30-day and 60-day check-in emails.',
});

// ---------------------------------------------------------------------------
// Warnings — say what is missing, do not refuse
// ---------------------------------------------------------------------------

/**
 * Things worth knowing before running a step, given the tenant's current
 * state. Each returns a sentence or null.
 *
 * These are WARNINGS on purpose. Patrick works the steps in whatever order the
 * customer makes possible, and a system that refuses because its own checklist
 * is out of order is a system that gets worked around.
 */
function warningsFor(stepName, { config = {}, modules = new Set() } = {}) {
  const out = [];
  const has = (k) => config[k] !== undefined && config[k] !== null && config[k] !== '';

  switch (stepName) {
    case 'send_welcome_email':
    case 'send_intake_form':
    case 'send_building_email':
    case 'send_content_ready':
    case 'send_app_ready':
    case 'send_golive_email':
      if (!has('owner_email')) out.push('No owner email on this tenant — the send will fail.');
      break;

    case 'configure_branding':
      if (!has('logo_url')) out.push('No logo yet — the customer has not uploaded one.');
      if (!has('color_primary')) out.push('No brand colours yet.');
      break;

    case 'provision_phone_number':
      if (has('telnyx_phone_number')) out.push(`Already has ${config.telnyx_phone_number} — running again will not buy a second number.`);
      if (!process.env.TELNYX_MESSAGING_PROFILE_ID) out.push('No messaging profile configured — a number bought now could not send SMS.');
      break;

    case 'import_contacts':
      if (!Array.isArray(config.customers) || !config.customers.length) {
        out.push('No customer list captured — nothing to import.');
      }
      break;

    case 'configure_messaging':
      if (!Array.isArray(config.brand_voice) || !config.brand_voice.length) {
        out.push('No brand-voice sentences — their messages would sound generic.');
      }
      break;

    case 'generate_content':
      if (!has('key_services')) out.push('No services listed — content has nothing to write about.');
      if (!modules.has('publishing')) out.push('Publishing is off, so generated content would never go out.');
      break;

    case 'setup_review_triggers':
      if (!has('google_review_url')) out.push('No Google review link — review requests would have nowhere to send people.');
      break;

    case 'go_live':
      if (!modules.size) out.push('No modules enabled — going live would switch nothing on.');
      if (modules.has('content_engine') && !modules.has('publishing')) {
        out.push('Content engine is on without publishing — posts would generate and never publish.');
      }
      if (!has('preflight_passed_at')) out.push('Pre-go-live checks have not been run yet.');
      break;

    case 'schedule_checkins':
      // Worth stating plainly: this is the one step that causes something to
      // send later without another click.
      out.push('These three emails will send on their own at 2 weeks, 30 days and 60 days.');
      break;

    default:
      break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// previewStep — what would happen, without doing it
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<{kind:'email'|'action'|'person', to?, subject?, html?,
 *   description?, warnings:string[], alreadyDone:boolean}>}
 */
async function previewStep(supabase, tenantId, step, ctxLoader) {
  const { context, config, modules } = await ctxLoader(supabase, tenantId);
  const warnings = warningsFor(step.step_name, { config, modules });
  const alreadyDone = step.status === 'completed';

  const template = EMAIL_STEPS[step.step_name];
  if (template) {
    return {
      kind: 'email',
      to: context.client_email || null,
      subject: STEP_SUBJECTS[step.step_name] || email.subjectFor(template),
      html: email.renderTemplate(template, context),
      warnings,
      alreadyDone,
    };
  }

  if (step.kind === 'founder' || step.kind === 'customer') {
    return {
      kind: 'person',
      description: step.kind === 'founder'
        ? 'You do this one, then tick it off.'
        : 'The customer does this one. Tick it off once they have.',
      warnings,
      alreadyDone,
    };
  }

  return {
    kind: 'action',
    description: ACTION_DESCRIPTIONS[step.step_name] || step.description || step.step_name,
    warnings,
    alreadyDone,
  };
}

// ---------------------------------------------------------------------------
// runStep — the only thing in the system that actually sends
// ---------------------------------------------------------------------------

/**
 * Do the step, once, now.
 *
 * @param {Object}   opts
 * @param {string}   [opts.subject] edited subject — email steps only
 * @param {string}   [opts.html]    edited body — email steps only
 * @param {boolean}  [opts.force]   run again even if already completed
 * @returns {Promise<{status:string, detail:string, evidence?:Object}>}
 */
async function runStep(supabase, tenantId, step, opts = {}, deps = {}) {
  const { ctxLoader, executeHandler, NotImplementedStep, WaitingOnPerson } = deps;

  if (step.status === 'completed' && !opts.force) {
    // Re-clicking a done step must not send a second email. The Center greys
    // these out, but the guard belongs here where it cannot be bypassed.
    return { status: 'completed', detail: 'Already done — nothing sent.' };
  }

  const started = new Date().toISOString();
  const mark = async (status, detail) => {
    const patch = { status, last_error: status === 'completed' ? null : detail };
    if (status === 'completed') patch.completed_at = new Date().toISOString();
    const { error } = await supabase
      .from('onboarding_steps')
      .update(patch)
      .eq('id', step.id);
    if (error) throw new Error(`ran, but could not record it: ${error.message}`);
  };

  // --- a person's step: there is nothing to execute ------------------------
  if (step.kind === 'founder' || step.kind === 'customer') {
    await mark('completed');
    return { status: 'completed', detail: 'Ticked off.' };
  }

  try {
    const template = EMAIL_STEPS[step.step_name];

    if (template) {
      const { context } = await ctxLoader(supabase, tenantId);
      const to = context.client_email;
      if (!to) throw new Error('No owner email on this tenant — nothing was sent.');

      // Patrick's edits win. Falling back to the template means an unedited
      // send is byte-identical to what the preview showed him.
      const subject = opts.subject || STEP_SUBJECTS[step.step_name] || email.subjectFor(template);
      const html = opts.html || email.renderTemplate(template, context);

      await email.sendEmail(to, subject, html);
      await mark('completed');
      log.success(`Sent "${subject}" to ${to} (${step.step_name})`);
      return {
        status: 'completed',
        detail: `Sent to ${to}`,
        evidence: { to, subject, edited: Boolean(opts.subject || opts.html), at: started },
      };
    }

    // --- an action: reuse the handlers the engine already had -------------
    await executeHandler(supabase, tenantId, step);
    await mark('completed');
    return { status: 'completed', detail: 'Done.' };

  } catch (err) {
    // Same three states as before, for the same reason: "the customer has not
    // uploaded a logo" and "the code is not written" and "it broke" need three
    // different responses from the person reading it.
    let status = 'failed';
    if (WaitingOnPerson && err instanceof WaitingOnPerson) status = 'waiting';
    else if (NotImplementedStep && err instanceof NotImplementedStep) status = 'blocked';

    await mark(status, err.message);
    if (status === 'waiting') log.info(`${step.step_name}: ${err.message}`);
    else log.error(`${step.step_name} failed: ${err.message}`);
    return { status, detail: err.message };
  }
}

module.exports = {
  EMAIL_STEPS,
  STEP_SUBJECTS,
  ACTION_DESCRIPTIONS,
  warningsFor,
  previewStep,
  runStep,
};
