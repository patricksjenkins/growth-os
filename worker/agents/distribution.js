/**
 * Growth OS — Distribution Agent (Tenant-Aware)
 * Ported from WellMor distribution-agent.js
 *
 * Adapts content for each social platform. Takes a draft and
 * rewrites captions/copy for Instagram, LinkedIn, Facebook, etc.
 */

const { askClaudeJSON } = require('../../integrations/claude');
const { createLogger } = require('../../core/logger');
const { getConfig } = require('../../core/config');
const { db } = require('../../db/client');

/**
 * @param {Object} tenant - Resolved tenant
 * @param {Object} payload - { draft_id }
 */
async function run(tenant, payload = {}) {
  const log = createLogger('distribution', tenant.slug);

  if (!payload.draft_id) throw new Error('draft_id is required');

  const businessName = getConfig(tenant, 'business_name', tenant.name || 'Our Company');
  const brandVoice = getConfig(tenant, 'brand_voice', 'Professional and helpful.');
  // Default platforms aligned with campaign-orchestrator. Caller (orchestrator)
  // normally passes `payload.platforms`; we fall back to tenant config then
  // Instagram + Facebook — matching the orchestrator default so the two can't
  // drift into producing 3× expected drafts.
  const platforms = Array.isArray(payload.platforms) && payload.platforms.length
    ? payload.platforms
    : getConfig(tenant, 'social_platforms', ['instagram', 'facebook']);

  // Load the source draft
  const { data: draft, error: fetchErr } = await db
    .from('content_drafts')
    .select('*')
    .eq('id', payload.draft_id)
    .eq('tenant_id', tenant.id)
    .single();

  if (fetchErr || !draft) throw new Error(`Draft not found: ${payload.draft_id}`);

  const content = draft.campaign_payload?.content || {};
  const caption = content.caption || draft.body || '';
  const headline = content.headline || draft.headline || '';

  if (!caption) {
    // Do NOT silently create variants with empty bodies. Upstream content
    // generation didn't return a caption — flag it so we can see in the logs.
    throw new Error(`Source draft ${draft.id} has no caption/body — refusing to distribute (upstream generation failure)`);
  }

  log.info(`Distributing draft ${draft.id} to ${platforms.length} platforms`);

  const systemPrompt = `You adapt social media captions for ${businessName}.
Voice: ${brandVoice}
Return JSON: { "platforms": { "platform_name": { "caption": "string", "hashtags": "string" } } }`;

  const userPrompt = `Adapt this content for each platform: ${platforms.join(', ')}

Original caption: ${caption}
Headline: ${headline}
Topic: ${draft.topic || ''}

Platform guidance:
- LinkedIn: professional, thought-leadership, 3-5 hashtags
- Instagram: conversational, emoji-friendly, swipe CTA for carousels, 15-20 hashtags
- Facebook: community-focused, conversational, 3-5 hashtags
- X/Twitter: punchy one-liner, 1-2 hashtags

JSON only.`;

  const result = await askClaudeJSON(systemPrompt, userPrompt, {
    maxTokens: 2000,
    tenantSlug: tenant.slug,
  });

  // Create platform variants
  const created = [];
  const platformData = result.platforms || {};

  for (const platform of platforms) {
    if (platform === draft.platform) continue;

    const adapted = platformData[platform] || {};
    const adaptedCaption = adapted.caption || caption;

    // Safety: still refuse to insert a variant with an empty caption. The
    // upstream throw already catches the common case, but this defends
    // against partial Claude output that returns the key with an empty string.
    if (!adaptedCaption || !String(adaptedCaption).trim()) {
      log.warn(`Skipping empty-caption variant for platform ${platform} on draft ${draft.id}`);
      continue;
    }

    const { data: variant, error: insertErr } = await db
      .from('content_drafts')
      .insert({
        tenant_id: tenant.id,
        content_type: draft.content_type,
        platform,
        status: 'draft',
        headline: draft.headline,
        body: adaptedCaption,
        image_urls: draft.image_urls,
        campaign_payload: { ...draft.campaign_payload, adapted_caption: adaptedCaption, hashtags: adapted.hashtags },
        format_template: draft.format_template,
        topic: draft.topic,
        parent_draft_id: draft.id,
      })
      .select()
      .single();

    if (!insertErr && variant) {
      created.push({ draft_id: variant.id, platform });
    } else if (insertErr) {
      log.error(`Failed to insert variant for ${platform}: ${insertErr.message}`);
    }
  }

  log.success(`Distributed to ${created.length} platforms`);
  return { success: true, source_draft: draft.id, variants: created };
}

module.exports = run;
