-- 098: enable RLS on the six public tables that had none.
--
-- Supabase flagged these ERROR-level on 2026-07-26 (rls_disabled_in_public):
-- "Anyone with your project URL can read, edit, and delete all data in this
-- table because Row-Level Security is not enabled." The anon key is public by
-- design — it ships in any browser client — so an un-RLS'd table in the
-- `public` schema is readable and WRITABLE by the internet.
--
-- Severity is not equal across the six:
--   owner_password_resets  — password-reset tokens for the 923A owner portal.
--                            Readable = account takeover; writable = mint your
--                            own reset. This one is the emergency.
--   inbound_email_log      — customer email content and routing decisions.
--   engagement_touches     — customer engagement records.
--   rate_limits            — writable means rate limiting can be erased.
--   email_events           — bounce/complaint data (deliverability reputation).
--   autosend_decisions     — the outreach gate ledger (append-only, mig 094).
--
-- WHY "ENABLE RLS" WITH NO POLICIES IS THE CORRECT FIX HERE
-- Every writer of these tables uses the SERVICE-ROLE key, which bypasses RLS
-- entirely:
--   - growth-os  -> db/client.js getServiceClient()
--   - 923A Coins -> client-sites/923a-coins/lib/supa.js (service role,
--                   explicitly "never shipped to the browser")
-- getAnonClient() exists in growth-os but is called by nothing — verified
-- before applying. So enabling RLS denies anon/authenticated and changes
-- nothing for the applications. Deny-by-default is also what the other ~48
-- tables in this database already do.
--
-- If a table ever needs genuine browser access, add an explicit policy for it.
-- Do NOT disable RLS again to make something work.

ALTER TABLE public.owner_password_resets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inbound_email_log     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.engagement_touches    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rate_limits           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_events          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.autosend_decisions    ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.owner_password_resets IS
  'RLS enabled, no policies: service-role only. Password-reset tokens — never expose to anon.';
COMMENT ON TABLE public.inbound_email_log IS
  'RLS enabled, no policies: service-role only. Contains customer email content.';
