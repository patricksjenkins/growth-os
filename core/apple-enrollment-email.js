/**
 * Day-1 Apple Developer Enrollment email — fired the moment a wizard
 * customer picks Path B (Full Ownership) so they have everything they
 * need to enroll their own Apple Developer account before the call.
 *
 * Idempotency lives in the caller via the
 * tenant_config.apple_enrollment_email_sent_at marker.
 *
 * See docs/business/onboarding/path-choice.md and
 * client-onboarding-runbook.md "Day 1 — Apple Enrollment (Path B)".
 */

const { createLogger } = require('./logger');

const log = createLogger('apple-enrollment-email');

const DEFAULT_CAL_LINK =
  process.env.FOUNDER_CAL_LINK || 'https://cal.com/patricksjenkins/apple-enrollment';

async function sendAppleEnrollmentEmail(supabase, { tenantId, email, ownerName, businessName }) {
  if (!email) {
    throw new Error('sendAppleEnrollmentEmail: email is required');
  }
  // Email lookup fallback — when owner_email isn't in tenant_config
  // yet, pull from the auth user we created during welcome wizard.
  let recipient = email;
  if (!recipient) {
    const { data: users } = await supabase.auth.admin.listUsers();
    const match = users?.users?.find(
      (u) =>
        u.app_metadata?.tenant_id === tenantId ||
        u.user_metadata?.tenant_id === tenantId,
    );
    recipient = match?.email;
  }
  if (!recipient) {
    throw new Error('No recipient email found for tenant ' + tenantId);
  }

  const vars = {
    owner_name: ownerName || 'there',
    business_name: businessName || 'your business',
    cal_link: DEFAULT_CAL_LINK,
  };

  const emailMod = require('../integrations/email');
  const result = await emailMod.sendTemplateEmail(recipient, 'apple-enrollment', vars);
  log.info(`Apple enrollment email sent to ${recipient} for tenant ${tenantId}`);
  return result;
}

module.exports = { sendAppleEnrollmentEmail };
