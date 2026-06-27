/**
 * Public Gallery — read-only, unauthenticated.
 *
 * GET /api/public/gallery?tenant=<slug>
 *
 * Powers the gallery on customer-facing static websites (e.g. A Kut Above's
 * index.html), which already call this API for leads + chat. Returns ONLY
 * published items, grouped by category, so owner drafts never leak. Uses the
 * service client (RLS bypass) but hard-filters status='published' + tenant.
 *
 * Mounted BEFORE the global authMiddleware so anonymous site visitors can read.
 */

const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { db } = require('../../db/client');
const { createLogger } = require('../../core/logger');

const log = createLogger('gallery-public');

const MAX_FEATURED = 20;

// Light per-IP limit — this is a public read hit on every site load.
const limiter = rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false });

function shape(row) {
  return {
    id: row.id,
    category: row.category,
    url: row.public_image_url,
    thumb: row.thumb_url || row.public_image_url,
    before_url: row.before_url || null,
    headline: row.title || null,
    caption: row.description || null,
    city: row.city || null,
    service_type: row.service_type || null,
    alt: row.alt_text || row.description || 'A Kut Above Tree Services work',
  };
}

router.get('/', limiter, async (req, res) => {
  try {
    const slug = String(req.query.tenant || '').trim().toLowerCase();
    if (!slug) return res.status(400).json({ success: false, error: 'tenant is required' });

    const { data: tenant, error: tErr } = await db
      .from('tenants').select('id, slug').eq('slug', slug).maybeSingle();
    if (tErr) throw tErr;
    if (!tenant) return res.status(404).json({ success: false, error: 'tenant not found' });

    const { data: rows, error } = await db
      .from('gallery_items')
      .select('id, category, title, description, city, service_type, alt_text, public_image_url, thumb_url, before_url, featured, sort_order')
      .eq('tenant_id', tenant.id)
      .eq('status', 'published')
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });
    if (error) throw error;

    const all = rows || [];
    const result = {
      // Main "Our Work" gallery = the featured selection (up to 20).
      our_work: all.filter((r) => r.category === 'our_work' && r.featured).slice(0, MAX_FEATURED).map(shape),
      before_after: all.filter((r) => r.category === 'before_after').map(shape),
      storm_damage: all.filter((r) => r.category === 'storm_damage').map(shape),
      equipment: all.filter((r) => r.category === 'equipment').map(shape),
    };

    // Cacheable at the CDN edge; owner publishes are infrequent.
    res.set('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600');
    res.json({ success: true, tenant: tenant.slug, ...result });
  } catch (err) {
    log.error(`public gallery failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
