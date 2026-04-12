/**
 * Growth OS — Admin Middleware
 * Restricts access to platform owner/founder endpoints.
 * Must be used AFTER authMiddleware (requires req.user).
 */

const ADMIN_EMAILS = [
  'owner@firstgenautomate.com',
  'patrick@firstgenautomate.com'
];

function adminMiddleware(req, res, next) {
  const role = req.user?.app_metadata?.role;
  const email = req.user?.email;

  if (role !== 'owner' || !ADMIN_EMAILS.includes(email)) {
    return res.status(403).json({
      success: false,
      error: 'Forbidden — admin access required'
    });
  }

  req.isAdmin = true;
  next();
}

module.exports = { adminMiddleware };
