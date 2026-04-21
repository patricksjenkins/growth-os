/**
 * Growth OS — Campaign Orchestrator Agent (Tenant-Aware)
 * Ported from WellMor campaign-orchestrator-agent.js
 *
 * Full content pipeline: generates content, images, distributes across
 * platforms, schedules, and queues for approval. Single agent that
 * coordinates the entire weekly content batch.
 */

const { createLogger } = require('../../core/logger');
const { getConfig } = require('../../core/config');
const { db } = require('../../db/client');

/**
 * @param {Object} tenant - Resolved tenant
 * @param {Object} payload - { count, platform }
 */
async function run(tenant, payload = {}) {
  const log = createLogger('campaign-orchestrator', tenant.slug);
  const startTime = Date.now();

  const businessName = getConfig(tenant, 'business_name', tenant.name || 'Our Company');
  const postsPerMonth = getConfig(tenant, 'volume_limits', {}).posts_per_month || 15;
  const postsPerBatch = Math.min(Number(payload.count || Math.ceil(postsPerMonth / 4)), 10);
  // SINGLE SOURCE OF TRUTH for platforms. Default = Instagram + Facebook
  // (Patrick's business rule for FGA and most tenants). Distribution agent
  // receives this same list via payload so the two can't drift.
  const platforms = getConfig(tenant, 'social_platforms', ['instagram', 'facebook']);

  log.info(`Orchestrating ${postsPerBatch} posts × ${platforms.length} platforms for ${businessName}`);

  // Step 1: Generate ONE base draft per post. The base draft's platform is
  // platforms[0] — we do NOT round-robin the base because distribution will
  // fan it out to every platform below. Round-robin-ing the base used to
  // produce the "3× too many drafts" bug (base on LinkedIn + distribution
  // defaulting to LI/IG/FB = 3 rows per post).
  const contentAgent = require('./content-generation');
  const generated = [];
  const errors = [];
  const basePlatform = platforms[0] || 'instagram';

  for (let i = 0; i < postsPerBatch; i++) {
    try {
      const result = await contentAgent(tenant, { platform: basePlatform });
      generated.push(result);
      log.info(`Generated post ${i + 1}/${postsPerBatch}: ${result.topic}`);
    } catch (err) {
      log.error(`Content generation ${i + 1} failed`, err);
      errors.push({ step: 'content_generation', index: i, error: err.message });
    }
  }

  // Step 2: For each generated draft, create platform variants via distribution agent.
  // Pass platforms explicitly so distribution can't use its own default.
  const distributionAgent = require('./distribution');
  const distributed = [];
  for (const draft of generated) {
    try {
      const result = await distributionAgent(tenant, {
        draft_id: draft.draft_id,
        platforms,
      });
      if (result?.variants) {
        distributed.push(...result.variants);
      }
    } catch (err) {
      log.error(`Distribution failed for draft ${draft.draft_id}`, err);
      errors.push({ step: 'distribution', draft_id: draft.draft_id, error: err.message });
    }
  }

  const duration = Date.now() - startTime;
  const result = {
    success: true,
    generated: generated.length,
    distributed: distributed.length,
    total_drafts: generated.length + distributed.length,
    platforms,
    errors,
    duration_ms: duration,
  };

  log.success(`Campaign orchestration complete: ${result.total_drafts} drafts`, result);
  return result;
}

module.exports = run;
