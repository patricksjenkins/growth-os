/**
 * Admin — cross-tenant email identity health (Guardrail 9).
 *
 * GET /api/admin/email-identity — for every tenant: from/reply-to/signature,
 * verification status, last successful send, last blocked send, and required
 * owner actions. Behind authMiddleware + adminMiddleware.
 */

const express = require('express');
const router = express.Router();
const { db } = require('../../db/client');
const { resolveTenant } = require('../../core/tenant');
const { resolveIdentity, signatureLinesFor, isPlatformTenant } = require('../../core/tenant-email-identity');

router.get('/', async (_req, res) => {
  try {
    const { data: tenants, error } = await db.from('tenants').select('id, slug, name, status');
    if (error) throw error;

    const rows = [];
    for (const t of (tenants || [])) {
      let full = t;
      try { full = (await resolveTenant(db, t.id)) || t; } catch (_) { /* use shallow */ }
      const id = resolveIdentity(full);

      const [{ data: lastSent }, { data: lastBlocked }] = await Promise.all([
        db.from('conversations').select('created_at')
          .eq('tenant_id', t.id).eq('channel', 'email').eq('direction', 'outbound')
          .order('created_at', { ascending: false }).limit(1).maybeSingle(),
        db.from('notifications').select('created_at, message')
          .eq('tenant_id', t.id).eq('category', 'email_identity_blocked')
          .order('created_at', { ascending: false }).limit(1).maybeSingle(),
      ]);

      rows.push({
        slug: t.slug,
        name: t.name,
        status: t.status,
        platform: isPlatformTenant(full),
        from: id.from,
        reply_to: id.reply_to,
        signature_preview: signatureLinesFor(id),
        provider: id.provider,
        sending_domain_status: id.sending_domain_status,
        verified: id.verified,
        complete: id.complete,
        missing: id.missing,
        last_successful_send: lastSent?.created_at || null,
        last_blocked_send: lastBlocked?.created_at || null,
        required_owner_actions: id.complete ? [] : [`Configure/verify: ${id.missing.join(', ')}`],
      });
    }
    rows.sort((a, b) => Number(a.complete) - Number(b.complete)); // problems first
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
