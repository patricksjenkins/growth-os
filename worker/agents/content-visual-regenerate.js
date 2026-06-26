/**
 * content-visual-regenerate — regenerate ONE slide's visual and re-validate.
 *
 * Used both as a standalone agent (owner clicks "Regenerate visual" on a final
 * post) and as an inline helper by content-concept-finalize when a slide fails
 * the image-validation gate. Bounded by content_visual_assets.max_retries so a
 * persistently-failing asset can't loop forever.
 */

const { db } = require('../../db/client');
const { createLogger } = require('../../core/logger');
const { getFormatById } = require('../../core/fga-content-formats');
const imageValidation = require('../../core/content/image-validation');
const imageAgent = require('./image-generation');

/**
 * Regenerate a single slide image (1-based slide_number) on a draft.
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
async function regenerateSlide(tenant, draftId, slideNumber, opts = {}) {
  const log = createLogger('visual-regen', tenant.slug);
  const { data: draft } = await db.from('content_drafts').select('*').eq('id', draftId).single();
  if (!draft) return { ok: false, reason: 'draft_not_found' };
  void opts; // reason hint reserved for future targeted regeneration

  const campaign = draft.campaign_payload || {};
  const content = campaign.content || {};
  const slides = content.slides || [];
  const idx = slideNumber - 1;
  if (idx < 0 || idx >= slides.length) return { ok: false, reason: 'slide_out_of_range' };

  const formatTemplate = getFormatById(draft.format_template) || campaign.formatTemplate;
  const slide = slides[idx];
  const slideTemplate = formatTemplate?.slides?.[idx] || formatTemplate?.slides?.[formatTemplate.slides.length - 1];

  let image;
  try {
    image = await imageAgent.generateSlideImage(tenant, {
      headline: slide.headline,
      subtext: slide.subtext || '',
      body: slide.body || '',
      bullets: slide.bullets || [],
      slide_role: slide.role,
      slide_number: slide.slide_number || slideNumber,
      post_theme: content.post_theme,
      formatTemplate,
      slideTemplate,
      focusIndustry: campaign.focus_industry || null,
      // Preserve canvas + product-visual selection so a regenerated slide keeps
      // its kind (a Command Center card stays a Command Center card).
      platform: draft.platform,
      canvas: campaign.canvas || null,
      visualType: slide.visual_type || draft.visual_type || content.visual_type || null,
      visualData: slide.visual_data || null,
    });
  } catch (e) {
    log.warn(`regen slide ${slideNumber} failed: ${e.message}`);
    return { ok: false, reason: `gen_failed: ${e.message}` };
  }

  // Validate against the slide's own canvas + compose-time boxes (safe-area).
  const v = await imageValidation.validateAsset(image.public_url, { canvas: image.canvas || null, boxes: image.boxes || null });
  // Swap the slide image into carousel_images + image_urls regardless, but
  // report validity so callers can decide.
  const carousel = Array.isArray(campaign.carousel_images) ? campaign.carousel_images.slice() : [];
  carousel[idx] = image;
  const imageUrls = (draft.image_urls || []).slice();
  imageUrls[idx] = image.public_url || image.file_name;
  await db.from('content_drafts').update({
    image_urls: imageUrls,
    campaign_payload: { ...campaign, carousel_images: carousel },
    updated_at: new Date().toISOString(),
  }).eq('id', draftId);

  // Track retry on the visual asset row.
  try {
    const { data: existing } = await db.from('content_visual_assets')
      .select('id,retry_count').eq('draft_id', draftId).eq('slide_number', slideNumber).limit(1);
    if (existing && existing.length) {
      await db.from('content_visual_assets').update({
        status: v.ok ? 'valid' : 'invalid',
        validation: { checks: v.checks, ...v.meta },
        failure_reason: v.ok ? null : v.reason,
        public_url: image.public_url,
        retry_count: (existing[0].retry_count || 0) + 1,
        validated_at: new Date().toISOString(),
      }).eq('id', existing[0].id);
    }
  } catch (_) { /* non-fatal */ }

  return { ok: v.ok, reason: v.ok ? undefined : v.reason };
}

async function run(tenant, payload = {}) {
  const { draft_id, slide_number } = payload;
  if (!draft_id || !slide_number) return { error: 'draft_id and slide_number required' };
  return regenerateSlide(tenant, draft_id, slide_number);
}

module.exports = run;
module.exports.regenerateSlide = regenerateSlide;
