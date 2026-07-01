/**
 * Tenant Email Identity — owner-facing health + send preview.
 *
 * GET /api/tenant/email-identity — returns the resolved From / Reply-To /
 * signature / verification status for the logged-in tenant, so the portal can
 * show a Send Preview and warn/disable when identity is missing or unverified
 * (Guardrail 10). Behind authMiddleware + tenantMiddleware.
 */

const express = require('express');
const router = express.Router();
const { resolveIdentity, signatureLinesFor } = require('../../core/tenant-email-identity');

router.get('/', async (req, res) => {
  try {
    const id = resolveIdentity(req.tenant);
    const issues = [];
    if (!id.complete) issues.push(`Missing or unverified: ${id.missing.join(', ')}`);
    res.json({
      success: true,
      data: {
        tenant: req.tenant.slug,
        business_name: id.business_name,
        from: id.from,
        from_email: id.from_email,
        from_name: id.from_name,
        reply_to: id.reply_to,
        signature_preview: signatureLinesFor(id),
        provider: id.provider,
        sending_domain_status: id.sending_domain_status,
        verified: id.verified,
        complete: id.complete,
        missing: id.missing,
        can_send: id.complete,
        issues,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
