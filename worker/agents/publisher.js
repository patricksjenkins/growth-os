/**
 * Growth OS — Publisher Agent
 * Ported from WellMor agents/publisher-agent.js
 *
 * Finds approved content and publishes to Buffer using tenant credentials.
 */

const { createLogger } = require('../../core/logger');
const { publishToBuffer, isBufferConfigured } = require('../../integrations/buffer');
const { getApprovedUnpublished, markPosted } = require('../../db/queries/content');
const { logActivity } = require('../../db/queries/jobs');

/**
 * Agent entry point
 * @param {Object} tenant - Resolved tenant object
 * @param {Object} payload - { id } to publish specific item, or empty to publish all approved
 */
async function run(tenant, payload = {}) {
  const log = createLogger('publisher', tenant.slug);
  const startTime = Date.now();
  let published = 0;

  // Check if Buffer is configured for this tenant
  if (!isBufferConfigured(tenant.integrations)) {
    log.warn('Buffer not configured — skipping publish');
    return { published: 0, message: 'Buffer not configured' };
  }

  // Get items to publish
  let items;
  if (payload.id) {
    // Publish specific item
    const { getDraft } = require('../../db/queries/content');
    const draft = await getDraft(tenant.id, payload.id);
    if (!draft || draft.status !== 'approved') {
      throw new Error(`Item ${payload.id} not found or not approved`);
    }
    items = [draft];
  } else {
    // Publish all approved items
    items = await getApprovedUnpublished(tenant.id);
  }

  if (items.length === 0) {
    log.info('No approved items to publish');
    return { published: 0 };
  }

  log.info(`Found ${items.length} approved items to publish`);

  for (const item of items) {
    try {
      // Build post data — append hashtags to the caption
      const captionText = item.body || item.headline || '';
      const hashtagStr = Array.isArray(item.hashtags) && item.hashtags.length
        ? '\n\n' + item.hashtags.map(h => `#${h.replace(/^#+/, '')}`).join(' ')
        : '';
      const postData = {
        platform: item.platform,
        text: captionText + hashtagStr,
      };

      // Attach images — prefer public URLs from Supabase Storage, fall back to local disk
      const imageUrls = item.image_urls || [];
      const carouselImages = item.campaign_payload?.carousel_images || [];

      if (carouselImages.length > 0) {
        // Use carousel_images which have public_url from Supabase Storage
        postData.imageUrls = carouselImages
          .map(img => img.public_url)
          .filter(Boolean);
      } else if (imageUrls.length > 0) {
        // Check if URLs are already full URLs (Supabase Storage) or local filenames
        if (imageUrls[0].startsWith('http')) {
          postData.imageUrls = imageUrls;
        } else {
          // Legacy: local disk fallback
          const fs = require('fs');
          const path = require('path');
          const imagePath = path.join(__dirname, '..', '..', 'static', 'images', imageUrls[0]);
          if (fs.existsSync(imagePath)) {
            postData.imageBuffer = fs.readFileSync(imagePath);
            postData.imageName = imageUrls[0];
          }
        }
      }

      // Publish to Buffer. Three modes in priority order:
      //   1. Per-post override — item.scheduled_for is set to a future
      //      ISO timestamp on the draft (Module 6.5: "Override timing
      //      per post"). Schedules at that exact moment.
      //   2. shareNow — payload override forces immediate publish.
      //   3. addToQueue — default, Buffer picks the optimal next slot
      //      from the tenant's configured queue (Module 6.3).
      const scheduledOverride = item.scheduled_for && new Date(item.scheduled_for) > new Date()
        ? item.scheduled_for
        : null;
      const result = await publishToBuffer(tenant.integrations, postData, {
        tenantSlug: tenant.slug,
        addToQueue: !scheduledOverride && payload.shareNow !== true,
        scheduledAt: scheduledOverride,
      });

      // Mark as posted (with race condition protection — only updates if still 'approved')
      await markPosted(tenant.id, item.id, result?.id || null);

      published++;
      log.success(`Published: ${item.platform} — "${item.headline || 'untitled'}"`);
    } catch (err) {
      log.error(`Failed to publish ${item.id}`, err);
      // Continue with next item — don't fail the whole batch
    }
  }

  await logActivity(tenant.id, 'publisher', 'publish_batch', {
    _startTime: startTime,
    status: 'success',
    recordsAffected: published,
    data: { total: items.length, published }
  });

  return { published, total: items.length, duration_ms: Date.now() - startTime };
}

module.exports = run;
