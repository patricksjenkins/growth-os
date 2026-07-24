/**
 * Growth OS — Admin Middleware
 * Restricts access to platform owner/founder endpoints.
 * Must be used AFTER authMiddleware (requires req.user).
 *
 * ADMIN_EMAILS env var (comma-separated) is the source of truth. Falls back
 * to the founder's two known addresses if unset so local dev keeps working.
 * During the no-break rollout, legacy user_metadata role claims remain a
 * shadowed compatibility fallback. The enforcement flag removes that fallback.
 */

const { createLogger } = require('../../core/logger');
const { flags } = require('../../core/autonomous-os/feature-flags');
const { resolveRoleClaim } = require('../../core/authz/claims');

const log = createLogger('admin-authz');

const DEFAULT_ADMIN_EMAILS = [
  'owner@firstgenautomate.com',
  'patrick@firstgenautomate.com',
  'info@firstgenautomate.com',
];

function getAdminEmails() {
  const fromEnv = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
  return fromEnv.length ? fromEnv : DEFAULT_ADMIN_EMAILS.map(s => s.toLowerCase());
}

function adminMiddleware(req, res, next) {
  const claim = resolveRoleClaim(req.user, {
    enforce: flags.authzAppMetadataEnforce(),
  });
  const role = claim.role;
  const email = (req.user?.email || '').toLowerCase();

  if (claim.legacyFallback || claim.conflict) {
    log.warn('Non-authoritative admin role claim observed');
  }

  const allowlist = getAdminEmails();
  if (!claim.allowed || role !== 'owner' || !allowlist.includes(email)) {
    return res.status(403).json({
      success: false,
      error: 'Forbidden — admin access required'
    });
  }

  req.isAdmin = true;
  next();
}

module.exports = { adminMiddleware };
