-- 064_oauth_client_kind.sql
--
-- Dual Google OAuth clients (2026-07-08).
--
-- The FGA Google Cloud project's consent screen is User type = Internal, which
-- by definition only accepts @firstgenautomate.com Workspace accounts. Patrick's
-- personal Gmail hits `Error 403: org_internal` and can never authorize it.
-- User type is a PER-PROJECT setting, so a single project cannot serve both.
--
-- Flipping the existing project to External is the wrong fix: an External app
-- with publishing status "Testing" is issued refresh tokens that expire after
-- 7 days (Google docs, oauth2#expiration) for any Gmail scope. That would put
-- the working outreach reply-sync on a weekly re-auth treadmill.
--
-- Instead we support TWO OAuth clients:
--   'internal' — the existing project (Workspace inboxes). Untouched.
--   'external' — a second project, consent screen External, PUBLISHED TO
--                PRODUCTION (unverified is fine: Google's personal-use
--                exemption covers restricted scopes for <100 known users, and
--                production status — not verification — is what grants
--                long-lived refresh tokens).
--
-- A refresh token is bound to the client_id that minted it: refreshing a
-- token from client A while presenting client B's secret is rejected by
-- Google. So every connection must remember which client it belongs to.
-- Existing rows default to 'internal', which is exactly what they are.

ALTER TABLE email_connections
  ADD COLUMN IF NOT EXISTS oauth_client TEXT NOT NULL DEFAULT 'internal';

ALTER TABLE email_connections
  DROP CONSTRAINT IF EXISTS email_connections_oauth_client_check;

ALTER TABLE email_connections
  ADD CONSTRAINT email_connections_oauth_client_check
  CHECK (oauth_client IN ('internal', 'external'));

COMMENT ON COLUMN email_connections.oauth_client IS
  'Which Google OAuth client minted this token: internal (Workspace-only project) or external (published project, personal Gmail). Refresh MUST use the same client credentials.';
