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
      // Build post data
      const postData = {
        platform: item.platform,
        text: item.body || item.headline || '',
      };

      // Attach image if available
      if (item.image_urls && item.image_urls.length > 0) {
        const fs = require('fs');
        const path = require('path');
        const imagePath = path.join(__dirname, '..', '..', 'static', 'images', item.image_urls[0]);
        if (fs.existsSync(imagePath)) {
          postData.imageBuffer = fs.readFileSync(imagePath);
          postData.imageName = item.image_urls[0];
        }
      }

      // Publish to Buffer
      const result = await publishToBuffer(tenant.integrations, postData, { tenantSlug: tenant.slug });

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
