/**
 * Tenant Gallery — owner-portal "Website Photos" publishing workflow.
 *
 * Lets the business owner (Sheila/Amber for A Kut Above) manage the photos that
 * appear on their public website, with a simple Upload -> Preview -> Publish flow
 * and no FGA involvement. Photos live in the pre-provisioned gallery_items table;
 * files go to the public `asset-gallery-public` Storage bucket (web-optimized via
 * sharp). Drafts are private (status='draft'); only published items are exposed by
 * the public read endpoint (api/routes/gallery-public.js).
 *
 * Field mapping to the owner UI: headline -> title, caption -> description.
 * Categories: our_work | before_after | storm_damage | equipment.
 * "Our Work" supports up to 20 FEATURED items — those are the main gallery.
 *
 * Storage is written with the SERVICE client (server controls the tenant-scoped
 * path); the gallery_items rows are written with the per-user client so tenant
 * RLS (migration 061) is the real isolation gate.
 *
 * Mounted at /api/tenant/gallery (behind authMiddleware + tenantMiddleware).
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const sharp = require('sharp');
const { getUserClient } = require('../../db/userClient');
const { db: serviceDb } = require('../../db/client');
const { createLogger } = require('../../core/logger');

const log = createLogger('tenant-gallery');

const BUCKET = 'asset-gallery-public';
const CATEGORIES = new Set(['our_work', 'before_after', 'storm_damage', 'equipment']);
const MAX_FEATURED = 20;
const WEB_WIDTH = 1600;
const THUMB_WIDTH = 600;

const uploadHandler = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB (matches bucket limit)
  fileFilter: (_req, file, cb) => {
    if (/^image\/(jpe?g|png|webp|heic|heif)$/i.test(file.mimetype)) return cb(null, true);
    cb(new Error('Only image files (JPEG, PNG, WEBP, HEIC) are allowed.'));
  },
});

/** Resize + recompress a phone photo into a web-friendly JPEG at a target width. */
async function toWebJpeg(buffer, width, quality) {
  return sharp(buffer, { failOn: 'none' })
    .rotate() // honor EXIF orientation, then strip metadata
    .resize({ width, withoutEnlargement: true })
    .jpeg({ quality, mozjpeg: true })
    .toBuffer();
}

/** Optimize one image buffer and store web + thumb in the public bucket. */
async function optimizeAndStore(slug, buffer) {
  const [webBuf, thumbBuf] = await Promise.all([
    toWebJpeg(buffer, WEB_WIDTH, 82),
    toWebJpeg(buffer, THUMB_WIDTH, 78),
  ]);
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const webPath = `${slug}/gallery/${stamp}.jpg`;
  const thumbPath = `${slug}/gallery/${stamp}_thumb.jpg`;
  const put = async (path, buf) => {
    const { error } = await serviceDb.storage.from(BUCKET).upload(path, buf, {
      contentType: 'image/jpeg', cacheControl: '31536000', upsert: false,
    });
    if (error) throw error;
    return serviceDb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
  };
  const [url, thumb_url] = await Promise.all([put(webPath, webBuf), put(thumbPath, thumbBuf)]);
  return { url, public_path: webPath, thumb_url };
}

/** Friendly auto caption from structured fields. Owner can override. */
function autoCaption({ headline, service_type, city }) {
  if (headline && headline.trim()) return headline.trim();
  const svc = (service_type || '').trim();
  const loc = (city && city !== 'Other' ? city : '').trim();
  if (svc && loc) return `${svc} in ${loc}.`;
  if (svc) return `${svc} by A Kut Above Tree Services.`;
  if (loc) return `Tree service in ${loc}.`;
  return 'Completed work by A Kut Above Tree Services.';
}

/** Alt text = city + service + caption, for accessibility + SEO. */
function autoAlt({ city, service_type, caption }) {
  const parts = [];
  parts.push(service_type && service_type.trim() ? service_type.trim() : 'Tree service');
  parts.push(city && city !== 'Other' ? `in ${city}` : 'in South Mississippi');
  parts.push('by A Kut Above Tree Services');
  let alt = parts.join(' ');
  if (caption && caption.trim() && caption.trim() !== alt) alt += ` — ${caption.trim()}`;
  return alt.slice(0, 280);
}

function userEmail(req) {
  return req.user?.email || req.user?.app_metadata?.email || 'owner';
}

/** Count featured Our Work items (optionally excluding one id). */
async function countFeatured(db, tenantId, excludeId) {
  let q = db.from('gallery_items').select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId).eq('category', 'our_work').eq('featured', true);
  if (excludeId) q = q.neq('id', excludeId);
  const { count, error } = await q;
  if (error) throw error;
  return count || 0;
}

// GET / — all items for this tenant (drafts + published), for the owner UI.
router.get('/', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { data, error } = await db
      .from('gallery_items')
      .select('*')
      .eq('tenant_id', req.tenantId)
      .order('category', { ascending: true })
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });
    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (err) {
    log.error(`gallery list failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /upload — optimize + store one image; returns URLs. Does not create a row.
router.post('/upload', uploadHandler.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded.' });
    const slug = req.tenant?.slug || req.tenantId;
    const meta = await sharp(req.file.buffer, { failOn: 'none' }).metadata().catch(() => ({}));
    const stored = await optimizeAndStore(slug, req.file.buffer);
    res.json({ success: true, ...stored, width: meta.width || null, height: meta.height || null });
  } catch (err) {
    log.error(`gallery upload failed: ${err.message}`);
    res.status(err.message?.includes('allowed') ? 400 : 500).json({ success: false, error: err.message });
  }
});

// POST /upload-batch — upload MANY photos at once, each becoming its own draft
// item with shared city/service. The owner fine-tunes or publishes afterward.
// fields: category, city?, service_type?, featured? ('true' = feature Our Work,
// applied to as many as fit under the 20 cap). Files in the 'files' field.
router.post('/upload-batch', uploadHandler.array('files', 12), async (req, res) => {
  try {
    const db = getUserClient(req);
    const slug = req.tenant?.slug || req.tenantId;
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ success: false, error: 'No files uploaded.' });
    const category = String(req.body?.category || '').toLowerCase();
    if (!CATEGORIES.has(category)) {
      return res.status(400).json({ success: false, error: `category must be one of: ${[...CATEGORIES].join(', ')}` });
    }
    const city = req.body?.city || null;
    const service_type = req.body?.service_type || null;
    const wantFeatured = category === 'our_work' && String(req.body?.featured) === 'true';

    // Remaining feature slots (live count) — feature as many as fit, rest unfeatured.
    let remaining = wantFeatured ? Math.max(0, MAX_FEATURED - (await countFeatured(db, req.tenantId))) : 0;

    // Continue sort_order after the current max in this category.
    const { data: maxRow } = await db.from('gallery_items')
      .select('sort_order').eq('tenant_id', req.tenantId).eq('category', category)
      .order('sort_order', { ascending: false }).limit(1).maybeSingle();
    let sort = (maxRow?.sort_order ?? -1) + 1;

    const caption = autoCaption({ service_type, city });
    const alt_text = autoAlt({ city, service_type, caption });
    const me = userEmail(req);

    const rows = [];
    const errors = [];
    for (const f of files) {
      try {
        const stored = await optimizeAndStore(slug, f.buffer);
        const featured = remaining > 0; if (featured) remaining--;
        rows.push({
          tenant_id: req.tenantId, category, title: null, description: caption,
          city, service_type, alt_text,
          public_image_url: stored.url, public_image_path: stored.public_path, thumb_url: stored.thumb_url,
          featured, status: 'draft', sort_order: sort++, created_by: me, updated_by: me,
        });
      } catch (e) {
        errors.push(f.originalname || 'photo');
        log.warn(`batch item failed (${f.originalname}): ${e.message}`);
      }
    }
    if (!rows.length) throw new Error('All photos failed to process.');

    const { data, error } = await db.from('gallery_items').insert(rows).select();
    if (error) throw error;
    res.json({
      success: true,
      created: data.length,
      featured: data.filter((r) => r.featured).length,
      skipped: errors,
      items: data,
    });
  } catch (err) {
    log.error(`gallery upload-batch failed: ${err.message}`);
    res.status(err.message?.includes('allowed') ? 400 : 500).json({ success: false, error: err.message });
  }
});

// POST / — create a gallery item (status draft). Body carries metadata + uploaded URLs.
router.post('/', async (req, res) => {
  try {
    const db = getUserClient(req);
    const b = req.body || {};
    const category = String(b.category || '').toLowerCase();
    if (!CATEGORIES.has(category)) {
      return res.status(400).json({ success: false, error: `category must be one of: ${[...CATEGORIES].join(', ')}` });
    }
    if (!b.public_image_url) {
      return res.status(400).json({ success: false, error: 'An image is required (upload first).' });
    }
    const featured = category === 'our_work' ? !!b.featured : false;
    if (featured && (await countFeatured(db, req.tenantId)) >= MAX_FEATURED) {
      return res.status(409).json({ success: false, error: `You can feature up to ${MAX_FEATURED} photos in Our Work. Unselect one first.` });
    }

    const caption = (b.description && b.description.trim())
      || autoCaption({ headline: b.title, service_type: b.service_type, city: b.city });
    const alt_text = (b.alt_text && b.alt_text.trim()) || autoAlt({ city: b.city, service_type: b.service_type, caption });

    // next sort_order within category
    const { data: maxRow } = await db.from('gallery_items')
      .select('sort_order').eq('tenant_id', req.tenantId).eq('category', category)
      .order('sort_order', { ascending: false }).limit(1).maybeSingle();
    const sort_order = (maxRow?.sort_order ?? -1) + 1;

    const row = {
      tenant_id: req.tenantId,
      category,
      title: b.title?.trim() || null,
      description: caption,
      city: b.city || null,
      service_type: b.service_type || null,
      alt_text,
      public_image_url: b.public_image_url,
      public_image_path: b.public_image_path || null,
      thumb_url: b.thumb_url || b.public_image_url,
      before_url: category === 'before_after' ? (b.before_url || null) : null,
      before_path: category === 'before_after' ? (b.before_path || null) : null,
      featured,
      status: 'draft',
      sort_order,
      created_by: userEmail(req),
      updated_by: userEmail(req),
    };
    const { data, error } = await db.from('gallery_items').insert(row).select().single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    log.error(`gallery create failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /:id — update metadata / featured / order / category.
router.patch('/:id', async (req, res) => {
  try {
    const db = getUserClient(req);
    const b = req.body || {};
    const patch = { updated_at: new Date().toISOString(), updated_by: userEmail(req) };

    if (b.category !== undefined) {
      const c = String(b.category).toLowerCase();
      if (!CATEGORIES.has(c)) return res.status(400).json({ success: false, error: 'Invalid category.' });
      patch.category = c;
    }
    for (const f of ['title', 'description', 'city', 'service_type', 'alt_text', 'before_url', 'before_path', 'public_image_url', 'public_image_path', 'thumb_url']) {
      if (b[f] !== undefined) patch[f] = b[f] || null;
    }
    if (b.sort_order !== undefined) patch.sort_order = parseInt(b.sort_order) || 0;

    if (b.featured !== undefined) {
      const wantFeatured = !!b.featured;
      if (wantFeatured && (await countFeatured(db, req.tenantId, req.params.id)) >= MAX_FEATURED) {
        return res.status(409).json({ success: false, error: `You can feature up to ${MAX_FEATURED} photos in Our Work. Unselect one first.` });
      }
      patch.featured = wantFeatured;
    }

    const { data, error } = await db.from('gallery_items').update(patch)
      .eq('tenant_id', req.tenantId).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    log.error(`gallery patch failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /:id/publish and /:id/unpublish
router.post('/:id/publish', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { data, error } = await db.from('gallery_items')
      .update({ status: 'published', published_at: new Date().toISOString(), updated_by: userEmail(req) })
      .eq('tenant_id', req.tenantId).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/:id/unpublish', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { data, error } = await db.from('gallery_items')
      .update({ status: 'draft', updated_by: userEmail(req) })
      .eq('tenant_id', req.tenantId).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /publish — publish ALL drafts for this tenant ("Publish Changes").
router.post('/publish', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { data, error } = await db.from('gallery_items')
      .update({ status: 'published', published_at: new Date().toISOString(), updated_by: userEmail(req) })
      .eq('tenant_id', req.tenantId).eq('status', 'draft').select('id');
    if (error) throw error;
    res.json({ success: true, published: (data || []).length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /reorder — body { category, ids: [...] } -> sets sort_order by position.
router.post('/reorder', async (req, res) => {
  try {
    const db = getUserClient(req);
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    let i = 0;
    for (const id of ids) {
      await db.from('gallery_items').update({ sort_order: i++ })
        .eq('tenant_id', req.tenantId).eq('id', id);
    }
    res.json({ success: true, reordered: ids.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /:id — remove the row (Storage object is left in place; harmless).
router.delete('/:id', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { error } = await db.from('gallery_items')
      .delete().eq('tenant_id', req.tenantId).eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
