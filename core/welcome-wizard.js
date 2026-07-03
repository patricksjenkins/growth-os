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

  // 2. Generate a single magic link to the WEB onboarding form.
  const webLink = await generateMagicLink(supabase, email, `${WEB_ORIGIN}/onboarding/start`);

  // 3. Send the welcome email.
  const emailResult = await sendEmail(email, {
    owner_name: ownerName || 'there',
    business_name: businessName || 'your business',
    web_link: webLink,
  });

  // 4. Best-effort SMS — log on failure but don't throw.
  let smsResult = null;
  if (phone) {
    smsResult = await sendSms(phone, ownerName, webLink).catch((err) => {
      log.warn(`Welcome SMS failed (non-fatal): ${err.message}`);
      return null;
    });
  }

  log.info(`Welcome wizard sent to ${email} (tenant ${tenantId})`);
  return { userId, emailResult, smsResult, webLink };
}

/**
 * Create the Supabase auth user if it doesn't exist, and ensure
 * app_metadata.tenant_id is set. Returns the user id.
 */
async function ensureAuthUser(supabase, { email, ownerName, businessName, tenantId }) {
  // Try to find existing user
  const { data: existing } = await supabase.auth.admin.listUsers();
  const found = existing?.users?.find((u) => (u.email || '').toLowerCase() === email.toLowerCase());

  if (found) {
    // Make sure tenant_id is set on app_metadata
    const needsUpdate = found.app_metadata?.tenant_id !== tenantId;
    if (needsUpdate) {
      await supabase.auth.admin.updateUserById(found.id, {
        app_metadata: { ...(found.app_metadata || {}), tenant_id: tenantId, role: 'client_owner' },
      });
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

module.exports = { sendWelcomeWizard };
