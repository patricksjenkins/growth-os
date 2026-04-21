/**
 * Growth OS — Admin Middleware
 * Restricts access to platform owner/founder endpoints.
 * Must be used AFTER authMiddleware (requires req.user).
 *
 * ADMIN_EMAILS env var (comma-separated) is the source of truth. Falls back
 * to the founder's two known addresses if unset so local dev keeps working.
 * Role check accepts either app_metadata.role or user_metadata.role === 'owner'
 * so a user provisioned via self-serve (user_metadata) isn't locked out.
 */

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
  const role =
    req.user?.app_metadata?.role ||
    req.user?.user_metadata?.role;
  const email = (req.user?.email || '').toLowerCase();

  const allowlist = getAdminEmails();
  if (role !== 'owner' || !allowlist.includes(email)) {
    return res.status(403).json({
      success: false,
      error: 'Forbidden — admin access required'
    });
  }

  req.isAdmin = true;
  next();
}

module.exports = { adminMiddleware };
