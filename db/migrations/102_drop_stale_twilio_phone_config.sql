-- 102: delete the stale twilio_phone_number tenant_config rows.
--
-- FGA held one, pointing at the number given up in June 2026.
-- worker/agents/dfy-website-build.js used it as a fallback for the phone
-- number printed on a CUSTOMER'S WEBSITE, so a disconnected number could
-- reach a live page. The fallback was removed in the same change; this
-- removes the data behind it.
DELETE FROM public.tenant_config WHERE key = 'twilio_phone_number';
