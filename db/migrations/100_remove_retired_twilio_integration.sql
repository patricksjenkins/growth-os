-- 100: delete the retired Twilio integration row.
--
-- Telnyx is the carrier. The call record shows the cutover finished:
-- voice_calls holds 10 Twilio-originated calls ending 2026-06-12 and 15 Telnyx
-- calls continuing to 2026-07-27 — seven weeks with no Twilio traffic.
--
-- The row was already marked status='retired', but that label does nothing.
-- core/tenant.js resolveTenant() selects every tenant_integrations row and
-- flattens it into tenant.integrations[service] without filtering on status,
-- so api/middleware/webhookVerify.js verifyTwilioSignature() read that row's
-- auth_token exactly as it would a live one. A stored carrier credential for a
-- carrier we no longer use is not made safe by a status column.
--
-- Retiring an integration means deleting the row.
--
-- Telnyx is unaffected: its auth lives in environment variables
-- (TELNYX_API_KEY / TELNYX_MESSAGING_PROFILE_ID), not in this table, which is
-- why the telnyx row here carries no credentials at all.
--
-- ROTATE THE TOKEN AT TWILIO TOO. Deleting the row removes our copy; it does
-- not invalidate the credential. The account_sid/auth_token pair should be
-- rotated or the Twilio account closed, since the secret has been sitting in
-- the database in plaintext.

DELETE FROM public.tenant_integrations
 WHERE service = 'twilio';
