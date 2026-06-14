/**
 * content-concept-finalize — turn an APPROVED concept into a final draft.
 *
 * This is the only place visual cost is incurred for the planner path. It
 * reuses the existing content-generation agent (which writes the content_drafts
 * row with parent_concept_id and runs image-generation inline), then enforces
 * the image-validation gate: invalid slides are regenerated (bounded) before
 * the draft is allowed into the existing approval queue. If visuals can't be
 * salvaged, the draft is held (status 'failed') and the owner is notified —
 * the approved COPY is preserved on the draft for a manual retry.
 */

const { db } = require('../../db/client');
const { createLogger } = require('../../core/logger');
const flags = require('../../core/content/planner-flags');
const imageValidation = require('../../core/content/image-validation');
const { regenerateSlide } = require('./content-visual-regenerate');
const contentGeneration = require('./content-generation');
const { computeWeekStart } = require('./content-plan');

async function findApprovedConcept(tenant, slot) {
  const weekStart = computeWeekStart();
  const { data } = await db.from('content_plan_concepts')
    .select('*, content_plans!inner(week_start_date)')
    .eq('tenant_id', tenant.id).eq('slot', slot).eq('status', 'concept_approved')
    .eq('content_plans.week_start_date', weekStart)
    .order('created_at', { ascending: false }).limit(1);
  return data && data.length ? data[0] : null;
}

async function run(tenant, payload = {}) {
  const log = createLogger('concept-finalize', tenant.slug);
  if (!flags.isPlannerEnabled(tenant)) return { skipped: true, reason: 'planner_disabled' };

  let concept = null;
  if (payload.concept_id) {
    const { data } = await db.from('content_plan_concepts').select('*').eq('id', payload.concept_id).single();
    concept = data;
  } else if (payload.slot) {
    concept = await findApprovedConcept(tenant, payload.slot);
  }
  if (!concept) return { skipped: true, reason: 'no_approved_concept' };
  if (concept.status === 'final_ready' || concept.status === 'published') {
    return { skipped: true, reason: 'already_finalized', concept_id: concept.id };
  }
  if (concept.status !== 'concept_approved' && concept.status !== 'generating') {
    return { skipped: true, reason: `concept_not_approved(${concept.status})` };
  }

  await db.from('content_plan_concepts').update({ status: 'generating' }).eq('id', concept.id);

  // Reuse the existing content-generation agent in concept mode. It writes the
  // content_drafts row (status 'draft') with parent_concept_id and runs image
  // generation inline.
  let genResult;
  try {
    genResult = await contentGeneration(tenant, {
      concept_id: concept.id,
      concept,
      platform: 'instagram',
    });
  } catch (e) {
    log.error('finalize generation failed', e);
    await db.from('content_plan_concepts').update({ status: 'failed' }).eq('id', concept.id);
    return { error: e.message, concept_id: concept.id };
  }

  const draftId = genResult && genResult.draft_id;
  if (!draftId) {
    await db.from('content_plan_concepts').update({ status: 'failed' }).eq('id', concept.id);
    return { error: 'no_draft_produced', concept_id: concept.id };
  }

  // If a screenshot was captured for this concept, use it as the hero image.
  const shots = (concept.evidence_ref && concept.evidence_ref.screenshot_urls) || [];
  if (shots.length) {
    try {
      const { data: draft } = await db.from('content_drafts').select('*').eq('id', draftId).single();
      const campaign = draft.campaign_payload || {};
      const carousel = Array.isArray(campaign.carousel_images) ? campaign.carousel_images.slice() : [];
      const imageUrls = (draft.image_urls || []).slice();
      if (carousel.length) {
        carousel[0] = { public_url: shots[0], file_name: shots[0].split('/').pop(), source: 'screenshot', slide_role: carousel[0]?.slide_role || 'hook', slide_number: 1 };
        imageUrls[0] = shots[0];
        await db.from('content_drafts').update({
          image_urls: imageUrls,
          campaign_payload: { ...campaign, carousel_images: carousel, screenshots: shots },
          updated_at: new Date().toISOString(),
        }).eq('id', draftId);
      }
    } catch (e) { log.warn(`screenshot swap skipped: ${e.message}`); }
  }

  // Image-validation gate, with bounded per-slide regeneration.
  const maxRetries = flags.visualMaxRetries(tenant);
  let { data: draft } = await db.from('content_drafts').select('*').eq('id', draftId).single();
  let validation = await imageValidation.validateCarousel(draft);
  await imageValidation.recordValidation(tenant.id, draftId, validation.perSlide);

  if (!validation.ok) {
    for (const s of validation.perSlide.filter((x) => !x.ok)) {
      let attempts = 0;
      while (attempts < maxRetries) {
        const r = await regenerateSlide(tenant, draftId, s.index + 1);
        attempts++;
        if (r.ok) break;
      }
    }
    ({ data: draft } = await db.from('content_drafts').select('*').eq('id', draftId).single());
    validation = await imageValidation.validateCarousel(draft);
    await imageValidation.recordValidation(tenant.id, draftId, validation.perSlide);
  }

  if (!validation.ok) {
    // Hold the draft out of the approval queue; preserve copy; notify owner.
    await db.from('content_drafts').update({ status: 'failed', updated_at: new Date().toISOString() }).eq('id', draftId);
    await db.from('content_plan_concepts').update({ status: 'failed', draft_id: draftId }).eq('id', concept.id);
    try {
      await db.from('notifications').insert({
        tenant_id: tenant.id, channel: 'push', priority: 'high', status: 'pending',
        category: 'content_visual_failed', entity_type: 'content_draft', entity_id: draftId,
        title: 'A post\'s visuals need attention',
        message: 'The copy is ready but one or more images failed validation after retries. Regenerate the visual to continue.',
        metadata: { draft_id: draftId, concept_id: concept.id, screen: 'ContentApprovals' },
      });
    } catch (_) { /* non-fatal */ }
    log.warn(`Draft ${draftId} held — visuals invalid after ${maxRetries} retries`);
    return { concept_id: concept.id, draft_id: draftId, status: 'held_invalid_visual' };
  }

  // Success — link + mark ready. Draft (status 'draft') flows into the
  // existing /api/approvals/pending owner-approval queue unchanged.
  await db.from('content_plan_concepts').update({ status: 'final_ready', draft_id: draftId }).eq('id', concept.id);
  log.success(`Concept ${concept.id} finalized → draft ${draftId} (ready for approval)`);
  return { concept_id: concept.id, draft_id: draftId, status: 'final_ready' };
}

module.exports = run;
