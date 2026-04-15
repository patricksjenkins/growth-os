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
  const platforms = getConfig(tenant, 'social_platforms', ['linkedin']);

  log.info(`Orchestrating ${postsPerBatch} posts for ${businessName}`);

  // Step 1: Generate content via content-generation agent
  const contentAgent = require('./content-generation');
  const generated = [];
  const errors = [];

  for (let i = 0; i < postsPerBatch; i++) {
    try {
      const result = await contentAgent(tenant, {
        platform: platforms[i % platforms.length],
      });
      generated.push(result);
      log.info(`Generated post ${i + 1}/${postsPerBatch}: ${result.topic}`);
    } catch (err) {
      log.error(`Content generation ${i + 1} failed`, err);
      errors.push({ step: 'content_generation', index: i, error: err.message });
    }
  }

  // Step 2: For each generated draft, create platform variants
  const distributed = [];
  for (const draft of generated) {
    try {
      // Load the draft from DB
      const { data: draftRow } = await db
        .from('content_drafts')
        .select('*')
        .eq('id', draft.draft_id)
        .single();

      if (!draftRow) continue;

      // Create copies for each platform
      for (const platform of platforms) {
        if (platform === draftRow.platform) continue; // Already created for primary

        const { data: variant } = await db
          .from('content_drafts')
          .insert({
            tenant_id: tenant.id,
            content_type: draftRow.content_type,
            platform,
            status: 'draft',
            headline: draftRow.headline,
            body: draftRow.body,
            image_urls: draftRow.image_urls,
            campaign_payload: draftRow.campaign_payload,
            format_template: draftRow.format_template,
            topic: draftRow.topic,
            parent_draft_id: draftRow.id,
          })
          .select()
          .single();

        if (variant) distributed.push({ draft_id: variant.id, platform });
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
