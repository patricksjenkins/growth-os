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
/**
 * How long a claim is respected before another caller may take it over.
 *
 * A step sends in seconds, so anything still 'in_progress' after this window
 * is a process that died mid-run rather than one still working. Long enough
 * that a slow Stripe call is never stolen from; short enough that Patrick is
 * not stuck looking at an unclickable step.
 */
const STALE_CLAIM_MS = 15 * 60 * 1000;

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
/**
 * What the setup-invoice step will ACTUALLY charge, from this tenant's config.
 *
 * The description used to hardcode "$199" while the handler could invoice a
 * configured custom amount — so Patrick could read "$199", click, and send a
 * $500 invoice. The number shown before an irreversible click has to be the
 * number the click produces, computed from the same config the handler reads.
 */
function setupInvoiceDescription(config = {}) {
  const { FGA_KNOWLEDGE } = require('./fga-knowledge');
  const standard = FGA_KNOWLEDGE.pricing.setup_fee.amount;
  const configured = (config.setup_fee !== undefined && config.setup_fee !== null && config.setup_fee !== '')
    ? Number(config.setup_fee) : null;
  const isComp = config.is_complimentary === true || config.is_complimentary === 'true';

  if (isComp) {
    return 'This client is COMPLIMENTARY — running this step will refuse. Nothing should be invoiced.';
  }
  if (configured === 0) {
    return 'The setup fee for this client is $0 — running this step will refuse. Nothing to invoice.';
  }
  const amount = configured !== null ? configured : standard;
  const customNote = (configured !== null && configured !== standard)
    ? ` (custom — the standard fee is $${standard})` : '';
  return `Email them a Stripe invoice for the $${amount} setup fee${customNote}. `
    + 'Stripe hosts the pay page. The monthly is NOT on it — that starts after the 14-day trial.';
}

const ACTION_DESCRIPTIONS = Object.freeze({
  create_tenant:        'Check the tenant exists and is not a demo.',
  start_subscription:   'Start the subscription with a 14-day trial, so the first monthly charge lands on day 15. Needs a card, which they get by paying the setup invoice.',
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

    case 'send_setup_invoice':
      if (has('setup_invoice_id')) {
        out.push(`Invoice ${config.setup_invoice_id} has already been sent — running again does nothing.`);
      }
      if (!has('owner_email')) out.push('No owner email — there is nobody to invoice.');
      // The AMOUNT lives on the row, not only in the preview. The preview is
      // optional; the row is what Patrick is looking at when he clicks Run,
      // and a $500 custom deal must not be clickable behind a generic label.
      out.push(setupInvoiceDescription(config));
      break;

    case 'start_subscription':
      if (has('stripe_subscription_id')) {
        out.push('A subscription already exists — running again does nothing.');
      }
      if (!has('stripe_customer_id')) {
        out.push('No Stripe customer yet — send the setup invoice first.');
      } else if (!has('setup_invoice_id')) {
        out.push('No setup invoice on record. They may have no card on file, which a trial still needs for day 15.');
      }
      {
        const tierPrice = config.tier === 'scale' ? 399 : 249;
        const rate = (config.monthly_rate !== undefined && config.monthly_rate !== null && config.monthly_rate !== '')
          ? Number(config.monthly_rate) : null;
        if (rate !== null && rate !== tierPrice) {
          out.push(`This client's rate is $${rate}/mo, not the $${tierPrice} tier price — running `
            + 'this will refuse. Custom deals are subscribed from the Stripe dashboard.');
        } else {
          out.push(`Starts billing $${tierPrice}/mo, first charge in 14 days.`);
        }
      }
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

  // The welcome is its own email: the welcome-wizard template carrying the
  // customer's magic login link. The link is minted at send time and is
  // single-use, so the preview shows a sentinel that the send replaces —
  // and an edited body must keep it, or the send refuses.
  if (step.step_name === 'send_welcome_email') {
    const { WELCOME_LINK_SENTINEL } = require('./welcome-wizard');
    return {
      kind: 'email',
      to: context.client_email || null,
      subject: email.subjectFor('welcome-wizard'),
      html: email.renderTemplate('welcome-wizard', {
        owner_name: context.owner_name || 'there',
        business_name: context.business_name || 'your business',
        web_link: WELCOME_LINK_SENTINEL,
      }),
      warnings: [
        'This email creates their login. The link shown is a placeholder — the real '
        + 'one is generated when you click Send, and an edit must leave it in place.',
        ...warnings,
      ],
      alreadyDone,
    };
  }

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
    // The money step's description is computed from THIS tenant's config —
    // the displayed amount must be the amount the click produces.
    description: step.step_name === 'send_setup_invoice'
      ? setupInvoiceDescription(config)
      : (ACTION_DESCRIPTIONS[step.step_name] || step.description || step.step_name),
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
  const { ctxLoader, executeHandler, NotImplementedStep, WaitingOnPerson, AlreadySettled } = deps;

  if (step.status === 'completed' && !opts.force) {
    // Re-clicking a done step must not send a second email. The Center greys
    // these out, but the guard belongs here where it cannot be bypassed.
    return { status: 'completed', detail: 'Already done — nothing sent.' };
  }

  // CLAIM THE STEP BEFORE SENDING.
  //
  // Reading the status, sending, then marking it complete is not
  // exactly-once: two concurrent posts both read 'pending', and the customer
  // gets the email twice. A double-click is enough.
  //
  // So the claim is a conditional update, which Postgres serialises: exactly
  // one caller gets a row back and everyone else is told it is already
  // running.
  //
  // THE FIRST VERSION OF THIS WAS STILL WRONG. It required the row to still
  // hold `step.status` — the status the CALLER had read. When the caller read
  // the row AFTER someone else had claimed it, step.status was already
  // 'in_progress', so the condition became in_progress -> in_progress, which
  // matches, and the second caller sent a second email. Both returned
  // 'completed'. Reproduced with two overlapping requests: sends = 2.
  //
  // The precondition has to be a fixed property of the row — "nobody holds
  // this" — not a value copied from the racing caller.
  const now = new Date();
  const staleCutoff = new Date(now.getTime() - STALE_CLAIM_MS).toISOString();
  const claimPatch = {
    status: 'in_progress',
    attempts: (step.attempts || 0) + 1,
    claimed_at: now.toISOString(),
  };

  let claimQuery = supabase.from('onboarding_steps').update(claimPatch).eq('id', step.id);
  if (step.status === 'in_progress') {
    // Somebody holds it. The only way through is if their claim is old enough
    // that the process holding it is gone — a crash mid-send would otherwise
    // strand the step forever, unclickable. The .lt() makes the takeover
    // itself exclusive: whoever wins stamps claimed_at to now, and the losers
    // no longer match.
    claimQuery = claimQuery.eq('status', 'in_progress').lt('claimed_at', staleCutoff);
  } else {
    claimQuery = claimQuery.eq('status', step.status);
  }

  const { data: claimed, error: claimErr } = await claimQuery.select();
  if (claimErr) throw new Error(`could not claim the step: ${claimErr.message}`);
  if (!claimed || claimed.length === 0) {
    return {
      status: step.status,
      detail: step.status === 'in_progress'
        ? 'This step is running right now — nothing sent twice.'
        : 'Someone already started this one — nothing sent twice.',
    };
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

  // DELIVERY EVIDENCE + PROVIDER DEDUPE — exactly-once across a crash.
  //
  // Evidence written AFTER the send does not close the window, it moves it: a
  // crash between provider acceptance and the evidence write leaves nothing,
  // and the retry sends again. And no ordering of local writes can fix that,
  // because the caller can never know which side of the send the crash was on.
  //
  // So two mechanisms, layered:
  //
  //  1. An ATTEMPT record, written BEFORE the send and required to succeed —
  //     if we cannot record that we are about to send, nothing is sent. After
  //     provider acceptance it is promoted to state:'sent'.
  //  2. A provider idempotency key derived from the STEP ROW's id, passed to
  //     Resend on every attempt. A retry that cannot know whether the first
  //     attempt reached the provider sends with the SAME key, and Resend
  //     returns the original email instead of delivering another (24h window).
  //
  // A retry therefore sees one of: no evidence (send normally), 'sending'
  // (crashed mid-attempt — resend with the same key, the provider dedupes),
  // or 'sent' (short-circuit, nothing sent).
  //
  // Keyed by step.id, NOT step_name: a tenant who churns and comes back gets
  // a NEW workflow with new step rows, and their new welcome must not be
  // suppressed by evidence from the old one — especially when the recipient
  // address changed in between.
  //
  // Reads and writes both FAIL CLOSED. "I could not check whether this was
  // already sent" is not permission to send it.
  const evidenceKey = `email_evidence_${step.id}`;
  const readEvidence = async () => {
    const { data, error } = await supabase
      .from('tenant_config').select('value')
      .eq('tenant_id', tenantId).eq('key', evidenceKey).maybeSingle();
    if (error) {
      throw new Error(
        `Could not check whether this email was already sent (${error.message}) — `
        + 'nothing was sent. Sending blind risks the customer getting it twice.',
      );
    }
    return data?.value || null;
  };
  const priorDelivery = async () => (opts.force ? null : readEvidence());

  // WHICH provider key this attempt uses — and it is not one key per step.
  //
  //  * A crash-retry must reuse the EXACT key of the interrupted attempt, so
  //    the provider can dedupe it. The key therefore lives in the 'sending'
  //    evidence record, not in a formula a later attempt might compute
  //    differently.
  //  * A FORCE must use a FRESH key, or it does not resend at all — Resend
  //    answers a reused key with the original email (payload identical) or a
  //    409 (payload changed), and either way the customer gets nothing new.
  //    attemptNo comes from the claim above, so every force is unique.
  const attemptNo = (step.attempts || 0) + 1;
  const pickIdempotencyKey = (evidence) =>
    (evidence && evidence.state === 'sending' && evidence.idempotency_key && !opts.force)
      ? evidence.idempotency_key
      : `onb-step-${step.id}-a${attemptNo}`;

  // TWO Resend idempotency errors, with OPPOSITE meanings — the first
  // version matched /idempoten/i and treated both as delivered:
  //
  //  * invalid_idempotent_request — reused key, DIFFERENT payload. Can only
  //    happen when a previous request with this key succeeded. PROOF of
  //    delivery.
  //  * concurrent_idempotent_requests — the original request is STILL
  //    PROCESSING. Proof of nothing; Resend says retry later. Marking the
  //    step completed off this one invents a delivery that may never happen.
  const isPayloadConflictProof = (err) =>
    err?.providerCode === 'invalid_idempotent_request'
    || /invalid_idempotent_request/.test(err?.message || '');
  const isStillProcessing = (err) =>
    err?.providerCode === 'concurrent_idempotent_requests'
    || /concurrent_idempotent_requests/.test(err?.message || '');

  // Resend forgets an idempotency key after 24 hours. Past that, "resend
  // with the same key" is not deduped — it just delivers again. An
  // interrupted attempt that old is genuinely UNKNOWABLE from here, so it
  // fails closed: Patrick checks the Resend dashboard, then either marks the
  // step done or forces a fresh send. 23h keeps a margin under the limit.
  const PROVIDER_KEY_TTL_MS = 23 * 60 * 60 * 1000;
  const providerForgot = (evidence) =>
    !evidence?.at || (Date.now() - Date.parse(evidence.at)) > PROVIDER_KEY_TTL_MS;
  const recordEvidence = async (evidence, { critical }) => {
    const { error } = await supabase.from('tenant_config').upsert(
      { tenant_id: tenantId, key: evidenceKey, value: evidence },
      { onConflict: 'tenant_id,key' },
    );
    if (error) {
      if (critical) {
        // Pre-send: no record, no send.
        throw new Error(
          `Could not record the send attempt (${error.message}) — nothing was sent.`,
        );
      }
      // Post-send: the email is out. The idempotency key makes the eventual
      // retry safe regardless, so log rather than masking the send's success.
      log.error(`Sent, but could not promote delivery evidence: ${error.message}`);
    }
  };

  try {
    // --- the welcome: the email that creates their login -------------------
    //
    // Not on the generic template path because sending it is more than
    // rendering: it creates the auth user, records membership, and mints a
    // fresh single-use magic link that gets substituted into the (possibly
    // edited) body. See core/welcome-wizard.js sendWelcomeFromCenter.
    if (step.step_name === 'send_welcome_email') {
      const already = await priorDelivery();
      if (already && already.state === 'sent') {
        await mark('completed');
        return {
          status: 'completed',
          detail: `Already delivered to ${already.to} on ${(already.at || '').slice(0, 10)} — not resending.`,
        };
      }

      const { context } = await ctxLoader(supabase, tenantId);
      const to = context.client_email;
      if (!to) throw new Error('No owner email on this tenant — nothing was sent.');
      for (const [field, value] of Object.entries({ subject: opts.subject, html: opts.html })) {
        if (value !== undefined && String(value).trim() === '') {
          throw new Error(`The ${field} is empty — nothing was sent. Reload the step to get the original wording.`);
        }
      }

      // An interrupted attempt older than the provider's memory cannot be
      // reasoned about from here — the key no longer dedupes, so "retry"
      // just delivers again, and there is no 409 left to prove anything.
      if (already && already.state === 'sending' && providerForgot(already)) {
        throw new Error(
          `An interrupted send from ${(already.at || '').slice(0, 10)} is too old for the provider `
          + 'to remember — retrying blind could deliver a second copy. Check the Resend dashboard: '
          + 'if it was delivered, mark this step done; if not, use Force to send a fresh one.',
        );
      }

      // No attempt record, no send. A crash after this point is covered by
      // the stored key: the retry reuses it and the provider dedupes.
      const idemKey = pickIdempotencyKey(already);
      await recordEvidence(
        { state: 'sending', to, at: already?.at || started, idempotency_key: idemKey },
        { critical: true },
      );

      const sendWelcome = deps.sendWelcome
        || require('./welcome-wizard').sendWelcomeFromCenter;
      let result;
      try {
        result = await sendWelcome(supabase, {
          tenantId,
          email: to,
          ownerName: context.owner_name,
          businessName: context.business_name,
          phone: context.phone || null,
          subject: opts.subject,
          html: opts.html,
          idempotencyKey: idemKey,
        });
      } catch (err) {
        // "Still processing" proves nothing — the original request may yet
        // fail. Resend's own guidance is to retry later, with the same key.
        if (isStillProcessing(err)) {
          throw new Error(
            'The previous attempt is still processing at the provider — wait a few '
            + 'seconds and click again. Nothing was sent twice.',
          );
        }
        // The welcome can NEVER reproduce its original payload on a retry —
        // each attempt mints a fresh single-use magic link. So a reused key
        // comes back as a payload conflict, and THAT error is proof: it can
        // only happen when the interrupted attempt reached Resend and was
        // accepted, original login link included (still the valid one).
        if (already && already.state === 'sending' && isPayloadConflictProof(err)) {
          await recordEvidence(
            { state: 'sent', to, at: already.at || started, step: step.step_name, via: 'provider_409_proof' },
            { critical: false },
          );
          await mark('completed');
          return {
            status: 'completed',
            detail: `The earlier attempt DID reach ${to} — the provider confirmed it holds `
              + 'that send. Nothing was sent twice; their original login link is the live one.',
          };
        }
        throw err;
      }

      await recordEvidence(
        { state: 'sent', to, id: result?.emailResult?.id || null, at: started, step: step.step_name },
        { critical: false },
      );
      await mark('completed');
      log.success(`Welcome (with login link) sent to ${to}`);
      return {
        status: 'completed',
        detail: `Sent to ${to} — their login link is inside.`,
        evidence: { to, edited: Boolean(opts.subject || opts.html), at: started },
      };
    }

    const template = EMAIL_STEPS[step.step_name];

    if (template) {
      const already = await priorDelivery();
      if (already && already.state === 'sent') {
        await mark('completed');
        return {
          status: 'completed',
          detail: `Already delivered to ${already.to} on ${(already.at || '').slice(0, 10)} — not resending.`,
        };
      }

      const { context } = await ctxLoader(supabase, tenantId);
      const to = context.client_email;
      if (!to) throw new Error('No owner email on this tenant — nothing was sent.');

      // An edit that was CLEARED is not an edit that was never made.
      //
      // `opts.subject || template` restored the original whenever the edited
      // value was empty, so clearing the subject box and clicking Send emailed
      // the customer the template subject — silently, with the UI showing an
      // empty field. Refusing is the only honest option: we cannot know
      // whether they meant "blank" (which is not sendable) or "I was
      // mid-edit", and guessing sends the wrong thing to a real person.
      for (const [field, value] of Object.entries({ subject: opts.subject, html: opts.html })) {
        if (value !== undefined && String(value).trim() === '') {
          throw new Error(
            `The ${field} is empty — nothing was sent. Put something back, or `
            + 'reload the step to get the original wording.',
          );
        }
      }

      // Patrick's edits win. Falling back to the template means an unedited
      // send is byte-identical to what the preview showed him.
      const subject = opts.subject || STEP_SUBJECTS[step.step_name] || email.subjectFor(template);
      const html = opts.html || email.renderTemplate(template, context);

      // Same stale-attempt rule as the welcome: past the provider's memory
      // there is nothing left to dedupe against, so fail closed.
      if (already && already.state === 'sending' && providerForgot(already)) {
        throw new Error(
          `An interrupted send from ${(already.at || '').slice(0, 10)} is too old for the provider `
          + 'to remember — retrying blind could deliver a second copy. Check the Resend dashboard: '
          + 'if it was delivered, mark this step done; if not, use Force to send a fresh one.',
        );
      }

      const idemKey = pickIdempotencyKey(already);
      await recordEvidence(
        { state: 'sending', to, at: already?.at || started, idempotency_key: idemKey },
        { critical: true },
      );

      let result;
      try {
        result = await email.sendEmail(to, subject, html, { idempotencyKey: idemKey });
      } catch (err) {
        if (isStillProcessing(err)) {
          throw new Error(
            'The previous attempt is still processing at the provider — wait a few '
            + 'seconds and click again. Nothing was sent twice.',
          );
        }
        // Same payload-conflict-as-proof as the welcome. A generic template
        // usually reproduces its payload exactly (Resend then just returns
        // the original), but an EDITED retry does not — and the conflict
        // still means the interrupted attempt was delivered.
        if (already && already.state === 'sending' && isPayloadConflictProof(err)) {
          await recordEvidence(
            { state: 'sent', to, at: already.at || started, step: step.step_name, via: 'provider_409_proof' },
            { critical: false },
          );
          await mark('completed');
          return {
            status: 'completed',
            detail: `The earlier attempt DID reach ${to} — the provider confirmed it holds that send. Nothing was sent twice.`,
          };
        }
        throw err;
      }

      // Believe the provider, not the absence of an exception.
      //
      // With no Resend key configured, sendEmail returns
      // { status: 'dev_logged' } and delivers nothing. Marking the step
      // complete off that is the same false-green that made welcome_sent lie
      // about the one email carrying the customer's login.
      if (result && (result.status === 'dev_logged' || result.skipped)) {
        throw new Error(
          `Email was NOT delivered (${result.reason || result.status}). `
          + 'Check the Resend configuration — nothing reached the customer.',
        );
      }

      // Provider accepted — promote the attempt record, so a failed step mark
      // leaves 'sent' evidence and a retry short-circuits instead of resending.
      await recordEvidence(
        { state: 'sent', to, id: result?.id || null, at: started, step: step.step_name },
        { critical: false },
      );
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
    // "They already paid" is an OUTCOME, not an error. The step's purpose is
    // that the customer is invoiced and subscribed; if Stripe already did it,
    // that purpose is met and the step is done. Showing it red would send
    // Patrick looking for a problem, and the obvious way to "fix" a red money
    // step is to click it again — which is the exact double-charge this
    // guards against.
    if (AlreadySettled && err instanceof AlreadySettled) {
      await mark('completed');
      log.info(`${step.step_name}: ${err.message}`);
      return { status: 'completed', detail: err.message, evidence: { settled_elsewhere: true } };
    }

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
