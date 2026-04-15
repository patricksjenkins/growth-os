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
  const platforms = getConfig(tenant, 'social_platforms', ['linkedin', 'instagram', 'facebook']);

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
    }
  }

  log.success(`Distributed to ${created.length} platforms`);
  return { success: true, source_draft: draft.id, variants: created };
}

module.exports = run;
