/**
 * Growth OS — Welcome Wizard Bootstrap
 *
 * After Stripe confirms payment, this module:
 *   1. Creates a Supabase auth user (random password — login is via magic link)
 *   2. Attaches tenant_id to the user's app_metadata so tenantMiddleware
 *      can resolve them on subsequent requests
 *   3. Generates a magic link to the WEB onboarding form via Supabase admin API
 *   4. Sends the welcome email with the link + optionally a welcome SMS
 *
 * NOTE: onboarding is a WEB form (magic link -> browser). There is no setup
 * wizard inside any app, and the customer has no branded app yet at this
 * point (we build it in the first few days). So the email hands out ONE web
 * link, not an "open in the app" path.
 *
 * Designed to be idempotent — if the user already exists we just rotate
 * their magic links and resend. Safe for Stripe webhook replay.
 */

const crypto = require('crypto');
const { createLogger } = require('./logger');

const log = createLogger('welcome-wizard');

// Use the www subdomain: the apex (firstgenautomate.com) 307-redirects to
// www, and we want the magic link to land on a clean, non-redirected origin
// so the Supabase session cookie sets on the right host.
const WEB_ORIGIN = process.env.WEB_ORIGIN || 'https://www.firstgenautomate.com';

/**
 * Send the welcome-wizard email + SMS to a tenant owner.
 *
 * @param {SupabaseClient} supabase - service-role client
 * @param {Object} args
 * @param {string} args.tenantId
 * @param {string} args.email
 * @param {string} args.ownerName
 * @param {string} args.businessName
 * @param {string} [args.phone] - if provided, also send welcome SMS
 * @returns {Promise<Object>} result summary
 */
async function sendWelcomeWizard(supabase, args) {
  const { tenantId, email, ownerName, businessName, phone } = args || {};
  if (!supabase || !tenantId || !email) {
    throw new Error('sendWelcomeWizard: supabase, tenantId, email are required');
  }

  // 1. Ensure the auth user exists and is linked to this tenant.
  const userId = await ensureAuthUser(supabase, { email, ownerName, businessName, tenantId });

  // 1b. Record the membership.
  //
  // No JavaScript anywhere in this repo has ever inserted into `tenant_users`.
  // Tenancy works anyway because RLS reads app_metadata.tenant_id off the JWT,
  // so the gap is invisible day to day — until something resolves the owner by
  // membership instead. worker/agents/supervised-executive-foundation.js does
  // exactly that and throws `revenue_owner_membership_missing`.
  await ensureMembership(supabase, tenantId, userId);

  // 2. Generate a single magic link to the WEB onboarding form.
  const webLink = await generateMagicLink(supabase, email, `${WEB_ORIGIN}/onboarding/start`);

  // 3. Send the welcome email.
  const emailResult = await sendEmail(email, {
    owner_name: ownerName || 'there',
    business_name: businessName || 'your business',
    web_link: webLink,
  });

  // Did it ACTUALLY go out?
  //
  // This used to log "Welcome wizard sent" unconditionally and return, and the
  // admin route set welcome_sent = true off the mere absence of a throw. But
  // sendEmail() swallows provider failures into { skipped: true }, and the
  // email integration returns { status: 'dev_logged' } when no Resend key is
  // configured. So the admin UI could report a delivered welcome email — the
  // one containing the customer's only way to log in — when nothing had been
  // sent at all, and nobody would know until the customer said they never got
  // it.
  const delivered = !emailResult?.skipped && emailResult?.status !== 'dev_logged';
  if (!delivered) {
    log.error(
      `Welcome email to ${email} was NOT delivered `
      + `(${emailResult?.reason || emailResult?.status || 'unknown'})`,
    );
  }

  // 4. Best-effort SMS — log on failure but don't throw.
  let smsResult = null;
  if (phone) {
    smsResult = await sendSms(phone, ownerName, webLink).catch((err) => {
      log.warn(`Welcome SMS failed (non-fatal): ${err.message}`);
      return null;
    });
  }

  // 5. Record it where the admin onboarding tracker actually looks.
  //    api/routes/admin.js reads `welcome_email_sent_at` for its Day-0 row and
  //    NOTHING in the codebase wrote that key, so the box never ticked.
  if (delivered) {
    await supabase.from('tenant_config').upsert(
      { tenant_id: tenantId, key: 'welcome_email_sent_at', value: new Date().toISOString() },
      { onConflict: 'tenant_id,key' },
    ).then(({ error }) => {
      if (error) log.warn(`Could not record welcome_email_sent_at: ${error.message}`);
    });
  }

  if (delivered) log.info(`Welcome wizard sent to ${email} (tenant ${tenantId})`);
  return { userId, emailResult, smsResult, webLink, delivered };
}

/**
 * Create the Supabase auth user if it doesn't exist, and ensure
 * app_metadata.tenant_id is set. Returns the user id.
 */
async function ensureAuthUser(supabase, { email, ownerName, businessName, tenantId }) {
  const found = await findUserByEmail(supabase, email);

  if (found) {
    const currentTenant = found.app_metadata?.tenant_id;

    // REFUSE to move a user who already belongs to a different tenant.
    //
    // This used to overwrite app_metadata.tenant_id unconditionally. Tenancy
    // rides entirely on that claim, so reassigning it does not ADD access to
    // the new tenant — it silently REVOKES their access to the old one. An
    // owner of one business who is also the contact on another would be locked
    // out of their own Command Center by someone else's onboarding, with no
    // error anywhere.
    if (currentTenant && currentTenant !== tenantId) {
      throw new Error(
        `${email} is already the owner of tenant ${currentTenant}. `
        + 'Onboarding them into a second tenant would revoke their access to the '
        + 'first. Use a different owner email, or move them deliberately.',
      );
    }

    if (!currentTenant) {
      const { error } = await supabase.auth.admin.updateUserById(found.id, {
        app_metadata: { ...(found.app_metadata || {}), tenant_id: tenantId, role: 'client_owner' },
      });
      if (error) throw new Error(`Failed to link existing user to tenant: ${error.message}`);
    }
    return found.id;
  }

  // Otherwise create a fresh user with a random password — login is
  // always via magic link in the new flow.
  const randomPassword = crypto.randomBytes(16).toString('hex');
  const { data: created, error } = await supabase.auth.admin.createUser({
    email,
    password: randomPassword,
    email_confirm: true,
    app_metadata: { tenant_id: tenantId, role: 'client_owner' },
    user_metadata: {
      owner_name: ownerName,
      business_name: businessName,
    },
  });
  if (error) throw new Error(`Failed to create auth user: ${error.message}`);
  return created.user.id;
}

/**
 * Insert the tenant_users row linking this owner to this tenant, if absent.
 *
 * Idempotent by lookup rather than upsert, because the table's unique
 * constraints are not something to assume from here.
 */
async function ensureMembership(supabase, tenantId, userId) {
  const { data: existing, error: readErr } = await supabase
    .from('tenant_users')
    .select('user_id')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .maybeSingle();
  if (readErr) {
    log.warn(`Could not check tenant_users membership: ${readErr.message}`);
    return;
  }
  if (existing) return;

  const { error } = await supabase
    .from('tenant_users')
    .insert({ tenant_id: tenantId, user_id: userId, role: 'owner' });
  if (error) {
    // Not fatal: login works off the JWT claim regardless. But it must be
    // visible, because the agents that resolve an owner by membership will
    // fail later with an error that points somewhere else entirely.
    log.warn(`Could not create tenant_users membership: ${error.message}`);
  } else {
    log.info(`Recorded tenant_users membership for ${userId} on ${tenantId}`);
  }
}

/**
 * Find an auth user by email, across ALL pages.
 *
 * `listUsers()` with no arguments returns only the first page (~50 users).
 * Past that, an existing user simply is not found — so onboarding would fall
 * through to createUser and fail on a duplicate-email constraint, for reasons
 * that look nothing like the actual cause. Paginate until we find them or run
 * out.
 */
async function findUserByEmail(supabase, email) {
  const target = String(email || '').toLowerCase();
  const perPage = 200;
  for (let page = 1; page <= 50; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(`Failed to list users: ${error.message}`);
    const users = data?.users || [];
    const hit = users.find((u) => (u.email || '').toLowerCase() === target);
    if (hit) return hit;
    if (users.length < perPage) return null;   // last page
  }
  return null;
}

/**
 * Use the Supabase admin API to mint a single-use magic link for this
 * email. The action_link returned is what we put in the email body.
 *
 * Supabase magic links carry their own expiry (default 1 hour, can be
 * extended in Supabase project settings); we don't reissue them per
 * request. If the customer waits days, they reply for a fresh one.
 */
async function generateMagicLink(supabase, email, redirectTo) {
  const { data, error } = await supabase.auth.admin.generateLink({
    type: 'magiclink',
    email,
    options: { redirectTo },
  });
  if (error) throw new Error(`Failed to generate magic link: ${error.message}`);
  // generateLink returns either `properties.action_link` (newer SDK)
  // or `data.action_link` depending on version. Handle both.
  return data?.properties?.action_link || data?.action_link;
}

/**
 * Send the welcome-wizard email via the existing email integration.
 * Falls back to logging if email is not configured (dev environments).
 */
async function sendEmail(to, vars) {
  try {
    const emailMod = require('../integrations/email');
    return await emailMod.sendTemplateEmail(to, 'welcome-wizard', vars);
  } catch (err) {
    log.warn(`Email send failed (continuing): ${err.message}`);
    return { skipped: true, reason: err.message };
  }
}

/**
 * Send a brief welcome SMS via Telnyx (platform number).
 *
 * Uses the platform Telnyx account (TELNYX_API_KEY) + a from-number. If no
 * Telnyx config is available yet, this is a no-op and the customer just relies
 * on the email links.
 */
async function sendSms(toPhone, ownerName, webLink) {
  const from = process.env.TELNYX_ONBOARDING_FROM || process.env.TELNYX_PHONE_NUMBER;
  if (!process.env.TELNYX_API_KEY || !from) {
    log.info('Telnyx platform SMS not configured — skipping welcome SMS');
    return { skipped: true, reason: 'telnyx_not_configured' };
  }
  const greeting = ownerName ? `Hi ${ownerName.split(' ')[0]}, ` : '';
  const body =
    `${greeting}your First Gen Automate setup form is ready: ${webLink} ` +
    `Opens in your browser, about 15 min. Pause anytime, it saves as you go. -Patrick`;
  const axios = require('axios');
  const payload = { from, to: toPhone, text: body, use_profile_webhooks: true };
  if (process.env.TELNYX_MESSAGING_PROFILE_ID) payload.messaging_profile_id = process.env.TELNYX_MESSAGING_PROFILE_ID;
  const res = await axios.post('https://api.telnyx.com/v2/messages', payload, {
    headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}`, 'Content-Type': 'application/json' },
  });
  return res.data;
}

/**
 * Stands in for the magic link in a PREVIEW.
 *
 * The real link is minted by Supabase at send time and is single-use — there
 * is nothing true to show before the click. The Center renders the email with
 * this sentinel, and sendWelcomeFromCenter swaps the real link in wherever it
 * appears, including inside an edited body.
 */
const WELCOME_LINK_SENTINEL = 'https://login-link-generated-at-send.firstgenautomate.com';

/**
 * The welcome, sent from the Onboarding Center — the ONLY caller that sends it.
 *
 * WHY (2026-08-03)
 * "Onboard this client" had a Send-welcome checkbox that defaulted ON, and the
 * provisioning route called sendWelcomeWizard directly. So creating a client
 * SENT — email and potentially SMS — before the Center's welcome step was
 * ever previewed or clicked, which made "nothing reaches a customer without a
 * click" false at the very first screen of the flow.
 *
 * Provisioning now stages only. This function is what the Center's
 * send_welcome_email step runs, and it does everything sendWelcomeWizard did:
 * auth user, membership, fresh magic link, the welcome-wizard email, optional
 * SMS. Patrick's edits are honoured — with one hard rule: the email must
 * still carry the login link, because it is the customer's only way in.
 *
 * @param {Object} args - tenantId, email, ownerName, businessName, phone
 * @param {string} [args.subject] edited subject
 * @param {string} [args.html]    edited body; the sentinel is replaced with
 *                                the real link and must still be present
 * @returns {Promise<{delivered, emailResult, smsResult, userId}>}
 */
async function sendWelcomeFromCenter(supabase, args) {
  const { tenantId, email, ownerName, businessName, phone, subject, html, idempotencyKey } = args || {};
  if (!supabase || !tenantId || !email) {
    throw new Error('sendWelcomeFromCenter: supabase, tenantId, email are required');
  }

  // Same account plumbing as the wizard path — idempotent on resend.
  const userId = await ensureAuthUser(supabase, { email, ownerName, businessName, tenantId });
  await ensureMembership(supabase, tenantId, userId);
  const webLink = await generateMagicLink(supabase, email, `${WEB_ORIGIN}/onboarding/start`);

  const emailMod = require('../integrations/email');
  let body;
  if (html !== undefined) {
    // An edited body keeps Patrick's words but must keep the customer's way
    // in. The preview showed the sentinel; a body it no longer appears in has
    // had the login link edited out, and sending that strands the customer.
    if (!String(html).includes(WELCOME_LINK_SENTINEL)) {
      throw new Error(
        'The edited welcome email no longer contains the login link. '
        + 'Reload the step to get it back — the customer cannot log in without it.',
      );
    }
    body = String(html).split(WELCOME_LINK_SENTINEL).join(webLink);
  } else {
    body = emailMod.renderTemplate('welcome-wizard', {
      owner_name: ownerName || 'there',
      business_name: businessName || 'your business',
      web_link: webLink,
    });
  }

  const emailResult = await emailMod.sendEmail(
    email,
    subject || emailMod.subjectFor('welcome-wizard'),
    body,
    // Same key on every retry of the same step: if a previous attempt reached
    // the provider and the crash ate the evidence, Resend returns the ORIGINAL
    // email (original magic link included, which is still the valid one)
    // instead of delivering a second copy.
    idempotencyKey ? { idempotencyKey } : {},
  );
  const delivered = !emailResult?.skipped && emailResult?.status !== 'dev_logged';
  if (!delivered) {
    // Same contract as the Center's other email steps: the provider's answer
    // is the truth, and "not delivered" is a failure, not a completion.
    throw new Error(
      `Welcome email was NOT delivered (${emailResult?.reason || emailResult?.status || 'unknown'}). `
      + 'Check the Resend configuration — nothing reached the customer.',
    );
  }

  let smsResult = null;
  if (phone) {
    smsResult = await sendSms(phone, ownerName, webLink).catch((err) => {
      log.warn(`Welcome SMS failed (non-fatal): ${err.message}`);
      return null;
    });
  }

  await supabase.from('tenant_config').upsert(
    { tenant_id: tenantId, key: 'welcome_email_sent_at', value: new Date().toISOString() },
    { onConflict: 'tenant_id,key' },
  ).then(({ error }) => {
    if (error) log.warn(`Could not record welcome_email_sent_at: ${error.message}`);
  });

  log.info(`Welcome sent from the Center to ${email} (tenant ${tenantId})`);
  return { userId, emailResult, smsResult, delivered };
}

module.exports = { sendWelcomeWizard, sendWelcomeFromCenter, WELCOME_LINK_SENTINEL };
