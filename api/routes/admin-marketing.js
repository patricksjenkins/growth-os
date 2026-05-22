/**
 * Growth OS — Platform-Owner Marketing Routes
 *
 * Mounted at /api/admin/marketing/* and gated by adminMiddleware so it
 * is COMPLETELY hidden from tenant/client surfaces. These endpoints
 * power the platform-owner-only Module Promo Generator: pick a module +
 * a target niche + a concept, get back a script + a Veo render job,
 * then later approve to push to FGA's own Buffer channels.
 *
 * Storage strategy: results land in content_drafts with tenant_id =
 * FGA tenant + content_type='video_promo'. No new tables, no migration.
 * The Approvals page filters by content_type, so these drafts never
 * leak into the regular content queue.
 *
 * Routes:
 *   POST /generate-video       — kick off script + Veo render
 *   GET  /videos               — list FGA video drafts (most recent first)
 *   GET  /videos/:draftId      — lazy-poll Veo for status, persist result
 *   POST /videos/:draftId/publish — approve & schedule to FGA Buffer
 *   GET  /taxonomy             — modules + niches (mirror of taxonomy module)
 */

const express = require('express');
const router = express.Router();
const { getServiceClient } = require('../../db/client');
const { createLogger } = require('../../core/logger');
const { askClaudeJSON } = require('../../integrations/claude');
const { generateVeoVideo, pollVeoOperation } = require('../../integrations/veo');
const { publishToFgaBuffer, isFgaBufferConfigured } = require('../../integrations/buffer');
const {
  MODULES,
  NICHE_CATEGORIES,
  NICHES_BY_CATEGORY,
  findCategoryForNiche,
  findModule,
} = require('../../core/marketing-taxonomy');

const log = createLogger('admin-marketing');

const FGA_TENANT_ID = process.env.FGA_TENANT_ID || '30566ed6-026a-45e1-9502-029e6219df31';
const CONTENT_TYPE = 'video_promo';

// ============================================================================
// GET /api/admin/marketing/taxonomy — frontend mirror seed
// ============================================================================
router.get('/taxonomy', (req, res) => {
  res.json({
    success: true,
    modules: MODULES,
    categories: NICHE_CATEGORIES,
    niches: NICHES_BY_CATEGORY,
    fga_buffer_configured: isFgaBufferConfigured(),
  });
});

// ============================================================================
// POST /api/admin/marketing/generate-video
//
// Body: { module_id, niche, concept }
// Optional: { aspect_ratio, duration_seconds }
//
// Returns: { success, draft_id, status: 'rendering', operation_name, script }
// ============================================================================
router.post('/generate-video', async (req, res) => {
  try {
    const db = getServiceClient();
    const { module_id, niche, concept } = req.body || {};

    // ── Input validation ─────────────────────────────────────────
    const module = findModule(module_id);
    if (!module) {
      return res.status(400).json({ success: false, error: 'Invalid or missing module_id' });
    }
    const category = findCategoryForNiche(niche);
    if (!category) {
      return res.status(400).json({
        success: false,
        error: `Niche "${niche}" is not in the official taxonomy. See /api/admin/marketing/taxonomy.`,
      });
    }
    const trimmedConcept = String(concept || '').trim();
    if (!trimmedConcept || trimmedConcept.length < 10) {
      return res.status(400).json({
        success: false,
        error: 'Concept must be at least 10 characters — describe a specific scenario.',
      });
    }

    // ── Step 1: Claude writes script + cinematic Veo prompt ──────
    const systemPrompt = `You write 20–30 second social-media promotional video scripts for First Gen Automate (FGA), a done-for-you business operating system installed for small businesses with 1–5 employees.

You write for ONE specific scenario at a time: one FGA product module, one micro-business niche. Your output is consumed by two systems:

1. A copywriter who turns the SCRIPT into the social post caption.
2. A text-to-video model (Google Veo) that turns the VIDEO_PROMPT into a 20-30 second cinematic clip.

Rules:
- Tight to the niche. A plumber on a slab leak ≠ a personal trainer with a client ≠ an Etsy seller packing orders. Make it visually unmistakable that you wrote it for THIS niche, not generic small-biz B-roll.
- Frame the FGA module as the moment of relief, not a feature list. Show, don't tell.
- Operator is 1–5 people. No call centers, no corporate offices, no big crews. Solo or 2-3 person crew.
- The VIDEO_PROMPT must be a single dense paragraph (~120–180 words) describing the FULL clip arc: opening shot → mid → resolution. Specify camera moves (handheld, push-in, overhead), lighting (golden hour, fluorescent shop, soft window), and the exact moment the customer/operator looks at their phone or app when the module kicks in. NO speaking dialogue inside the video (Veo audio quality varies); rely on captions baked-in if needed.
- Hook (3-5 words), caption body (15-25 words), and 3-5 hashtags geared to the niche.

Output ONLY a JSON object with this exact shape:
{
  "hook": "3-5 word scroll-stopper",
  "caption": "15-25 word post body. Conversational. One specific CTA.",
  "hashtags": ["plumbing", "etc"],
  "video_prompt": "120-180 word cinematic description of the 20-30 second clip arc"
}`;

    const userMessage = `Module:    ${module.name}  (${module.key})
Category:  ${category.categoryName}
Niche:     ${niche}
Operator:  Owner of a 1-5 person ${niche.toLowerCase()} business

Owner-provided concept / specific scenario angle:
"${trimmedConcept}"

Write the script + cinematic Veo prompt now.`;

    log.info(`Generating promo: module=${module.key} niche=${niche}`);

    const script = await askClaudeJSON(systemPrompt, userMessage, {
      maxTokens: 1600,
      tenantSlug: 'fga-marketing',
    });

    // Defensive normalization — Claude occasionally returns bare strings.
    const safeScript = {
      hook: String(script?.hook || '').trim().slice(0, 80),
      caption: String(script?.caption || '').trim().slice(0, 320),
      hashtags: Array.isArray(script?.hashtags)
        ? script.hashtags.map(h => String(h || '').replace(/^#+/, '').trim()).filter(Boolean).slice(0, 6)
        : [],
      video_prompt: String(script?.video_prompt || '').trim(),
    };
    if (!safeScript.video_prompt) {
      return res.status(502).json({
        success: false,
        error: 'Script generator returned no video_prompt. Try again or refine the concept.',
      });
    }

    // ── Step 2: Kick off Veo render ──────────────────────────────
    let operationName = null;
    let veoError = null;
    try {
      const veoRes = await generateVeoVideo(safeScript.video_prompt, {
        aspectRatio: req.body.aspect_ratio || '9:16',
        durationSeconds: req.body.duration_seconds || 8,
        tenantSlug: 'fga-marketing',
      });
      operationName = veoRes.operation_name;
    } catch (e) {
      // Don't abandon the run — the script is still useful. The admin
      // can re-trigger the render from the draft view if Veo is down.
      veoError = e.message || String(e);
      log.warn(`Veo kickoff failed (script saved anyway): ${veoError}`);
    }

    // ── Step 3: Persist as a content_drafts row on FGA tenant ────
    const initialStatus = operationName ? 'rendering' : 'draft_no_video';
    const { data: draft, error: dbErr } = await db
      .from('content_drafts')
      .insert({
        tenant_id: FGA_TENANT_ID,
        content_type: CONTENT_TYPE,
        platform: 'instagram',     // primary FGA platform; overridable at publish time
        status: 'draft',
        headline: safeScript.hook,
        body: safeScript.caption,
        hashtags: safeScript.hashtags,
        image_urls: [],            // populated when Veo render completes (video URL)
        topic: `${module.name} · ${niche}`,
        format_template: 'fga-module-promo',
        campaign_payload: {
          content_type: CONTENT_TYPE,   // duplicated here for filter convenience
          module: { id: module.id, key: module.key, name: module.name },
          niche: { category_key: category.categoryKey, category_name: category.categoryName, niche },
          owner_concept: trimmedConcept,
          script: safeScript,
          veo: {
            operation_name: operationName,
            status: initialStatus,
            error: veoError,
            queued_at: new Date().toISOString(),
          },
        },
      })
      .select()
      .single();

    if (dbErr) {
      log.error(`Draft insert failed: ${dbErr.message}`);
      return res.status(500).json({ success: false, error: dbErr.message });
    }

    log.success(`Promo draft created: ${draft.id} (Veo op: ${operationName || 'none'})`);

    res.json({
      success: true,
      draft_id: draft.id,
      status: initialStatus,
      operation_name: operationName,
      veo_error: veoError,
      script: safeScript,
    });
  } catch (err) {
    log.error(`generate-video failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// GET /api/admin/marketing/videos
// List recent FGA video promo drafts (most recent first).
// ============================================================================
router.get('/videos', async (req, res) => {
  try {
    const db = getServiceClient();
    const limit = Math.min(Number(req.query.limit) || 30, 100);
    const { data, error } = await db
      .from('content_drafts')
      .select('id, status, headline, body, hashtags, image_urls, topic, campaign_payload, created_at, updated_at, posted_at')
      .eq('tenant_id', FGA_TENANT_ID)
      .eq('content_type', CONTENT_TYPE)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    res.json({ success: true, drafts: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// GET /api/admin/marketing/videos/:draftId
// Lazy-poll Veo for in-flight renders. Persists the video URL onto the
// draft when complete, so the frontend doesn't need to know about ops.
// ============================================================================
router.get('/videos/:draftId', async (req, res) => {
  try {
    const db = getServiceClient();
    const { data: draft, error } = await db
      .from('content_drafts')
      .select('*')
      .eq('id', req.params.draftId)
      .eq('tenant_id', FGA_TENANT_ID)
      .eq('content_type', CONTENT_TYPE)
      .maybeSingle();
    if (error) throw error;
    if (!draft) return res.status(404).json({ success: false, error: 'Not found' });

    const veo = draft.campaign_payload?.veo || {};
    const alreadyDone = !!draft.image_urls?.length || veo.status === 'done' || veo.status === 'failed';

    if (alreadyDone || !veo.operation_name) {
      return res.json({ success: true, draft });
    }

    // Poll Veo and update the draft if it finished.
    const result = await pollVeoOperation(veo.operation_name, { tenantSlug: 'fga-marketing' });
    if (!result.done) {
      return res.json({ success: true, draft });
    }

    const nextStatus = result.error ? 'failed' : 'done';
    const updates = {
      campaign_payload: {
        ...draft.campaign_payload,
        veo: {
          ...veo,
          status: nextStatus,
          error: result.error || null,
          completed_at: new Date().toISOString(),
          video_url: result.video_url || null,
        },
      },
    };
    if (result.video_url) updates.image_urls = [result.video_url];

    const { data: updated } = await db
      .from('content_drafts')
      .update(updates)
      .eq('id', draft.id)
      .select()
      .single();

    res.json({ success: true, draft: updated || { ...draft, ...updates } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// POST /api/admin/marketing/videos/:draftId/publish
// Approve & schedule the video to FGA's corporate Buffer channels.
// Body: { platforms: ['instagram','linkedin'], scheduled_at? }
// ============================================================================
router.post('/videos/:draftId/publish', async (req, res) => {
  try {
    if (!isFgaBufferConfigured()) {
      return res.status(412).json({
        success: false,
        error: 'FGA_BUFFER_API_KEY (and channels) not configured. Set env vars to enable corporate publishing.',
      });
    }
    const db = getServiceClient();
    const { data: draft, error } = await db
      .from('content_drafts')
      .select('*')
      .eq('id', req.params.draftId)
      .eq('tenant_id', FGA_TENANT_ID)
      .eq('content_type', CONTENT_TYPE)
      .maybeSingle();
    if (error) throw error;
    if (!draft) return res.status(404).json({ success: false, error: 'Not found' });

    const videoUrl = draft.image_urls?.[0] || draft.campaign_payload?.veo?.video_url || null;
    if (!videoUrl) {
      return res.status(409).json({
        success: false,
        error: 'Video render not finished yet. Wait for status=done before publishing.',
      });
    }

    const platforms = Array.isArray(req.body?.platforms) && req.body.platforms.length
      ? req.body.platforms
      : ['instagram'];
    const text = [
      draft.headline,
      draft.body,
      (draft.hashtags || []).map(h => `#${h}`).join(' '),
    ].filter(Boolean).join('\n\n');

    const published = [];
    const failures = [];
    for (const platform of platforms) {
      try {
        const r = await publishToFgaBuffer(
          { platform, text, mediaUrls: [videoUrl] },
          { scheduledAt: req.body?.scheduled_at || null, addToQueue: !req.body?.scheduled_at },
        );
        published.push({ platform, post_id: r.id, status: r.status });
      } catch (e) {
        failures.push({ platform, error: e.message });
      }
    }

    // Move draft to 'approved' (then 'posted' if Buffer accepted any post).
    const allOk = failures.length === 0;
    const next = allOk ? 'posted' : (published.length ? 'approved' : draft.status);
    await db.from('content_drafts').update({
      status: next,
      approved_by: req.user?.id || null,
      posted_at: published.length ? new Date().toISOString() : null,
      campaign_payload: {
        ...draft.campaign_payload,
        publish_result: { published, failures, requested_at: new Date().toISOString() },
      },
    }).eq('id', draft.id);

    res.json({ success: failures.length === 0, published, failures });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
