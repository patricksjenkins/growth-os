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
const { getServiceClient } = require('../../db/client');
const { FGA_KNOWLEDGE } = require('../../core/fga-knowledge');

/**
 * Monthly social-post cap, per tier. We QUOTE these numbers to customers
 * (fga-knowledge volume_limits: 15 Growth / 30 Scale), so they must be
 * enforced — reading them from the same knowledge block keeps the promise
 * and the enforcement from drifting apart. Per-tenant override via
 * tenant_config `usage_cap.social_posts_per_month`.
 */
function socialPostCap(tenant) {
  const override = Number(tenant.config?.usage_cap?.social_posts_per_month);
  if (Number.isFinite(override) && override > 0) return override;
  const tier = (tenant.tier || tenant.subscription_tier || 'growth').toLowerCase();
  const limits = FGA_KNOWLEDGE.volume_limits[tier] || FGA_KNOWLEDGE.volume_limits.growth;
  return limits.social_posts_per_month;
}

/** Posts already published this calendar month (UTC) for the tenant. */
async function postsPublishedThisMonth(tenantId) {
  const db = getServiceClient();
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const { count, error } = await db
    .from('content_drafts')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('status', 'posted')
    .gte('posted_at', monthStart.toISOString());
  if (error) throw error;
  return count || 0;
}

/**
 * Agent entry point
 * @param {Object} tenant - Resolved tenant object
 * @param {Object} payload - { id } to publish specific item, or empty to publish all approved
 */
async function run(tenant, payload = {}) {
  const log = createLogger('publisher', tenant.slug);
  const startTime = Date.now();
  let published = 0;
  const failures = [];

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
    // Say that nothing was approved. The bare `{published: 0}` this used to
    // return carried no evidence the queue had been checked, so 22 legitimate
    // empty runs were indistinguishable from a broken agent.
    log.info('No approved items to publish');
    return {
      success: true,
      published: 0,
      total: 0,
      candidates: 0,
      message: 'No approved items to publish',
      outcome_contract: {
        result_state: 'succeeded',
        output_state: 'no_op',
        business_outcome_state: 'not_applicable',
        reason_code: 'nothing_approved',
        evidence: { approved_unpublished: 0 },
      },
    };
  }

  // Enforce the tier's monthly social-post volume limit. Approved drafts
  // beyond the cap stay 'approved' and publish next month — nothing is lost,
  // nothing exceeds what the customer's plan includes.
  const cap = socialPostCap(tenant);
  const alreadyPosted = await postsPublishedThisMonth(tenant.id);
  const remaining = Math.max(0, cap - alreadyPosted);
  if (remaining <= 0) {
    log.warn(`Monthly social-post cap reached (${alreadyPosted}/${cap}) — holding ${items.length} approved item(s) until next month`);
    await logActivity(tenant.id, 'publisher', 'publish_batch', {
      _startTime: startTime,
      status: 'success',
      recordsAffected: 0,
      data: { total: items.length, published: 0, reason: 'monthly_social_post_cap', cap, alreadyPosted },
    });
    return { published: 0, total: items.length, reason: 'monthly_social_post_cap' };
  }
  if (items.length > remaining) {
    log.warn(`Monthly social-post cap: ${alreadyPosted}/${cap} used — publishing ${remaining} of ${items.length} approved item(s)`);
    items = items.slice(0, remaining);
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
      // Record the failure in the RESULT, not only the log. Previously a
      // total publish failure returned {published:0, total:N} — visually
      // identical to "nothing to do" — so 23 runs where approved content
      // failed to reach Buffer looked like healthy no-ops on the dashboard.
      failures.push({
        draft_id: item.id,
        platform: item.platform || null,
        headline: (item.headline || '').slice(0, 80) || null,
        error: String(err?.message || err).slice(0, 200),
      });
      // Continue with next item — don't fail the whole batch
    }
  }

  await logActivity(tenant.id, 'publisher', 'publish_batch', {
    _startTime: startTime,
    status: failures.length > 0 && published === 0 ? 'error' : 'success',
    recordsAffected: published,
    data: { total: items.length, published, failed: failures.length }
  });

  const allFailed = published === 0 && failures.length > 0;
  return {
    success: !allFailed,
    published,
    total: items.length,
    failed: failures.length,
    failures: failures.slice(0, 10),
    duration_ms: Date.now() - startTime,
    outcome_contract: {
      result_state: allFailed ? 'failed' : 'succeeded',
      output_state: published > 0 ? 'produced' : (items.length === 0 ? 'no_op' : 'no_output'),
      delivery_state: published > 0 ? 'delivered' : (items.length === 0 ? 'not_applicable' : 'not_delivered'),
      business_outcome_state: published > 0 ? 'achieved' : (items.length === 0 ? 'not_applicable' : 'not_achieved'),
      reason_code: allFailed ? 'all_publishes_failed'
        : failures.length > 0 ? 'partial_publish_failure'
          : items.length === 0 ? 'nothing_approved' : 'published',
      evidence: {
        approved_items: items.length,
        published,
        failed: failures.length,
        first_error: failures[0]?.error || null,
      },
    },
  };
}

module.exports = run;
module.exports.socialPostCap = socialPostCap; // exported for tests
