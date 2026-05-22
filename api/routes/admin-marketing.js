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
router.get('/taxonomy', async (req, res) => {
  res.json({
    success: true,
    modules: MODULES,
    categories: NICHE_CATEGORIES,
    niches: NICHES_BY_CATEGORY,
    fga_buffer_configured: await isFgaBufferConfigured(),
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
    //
    // The template enforces a fixed 4-scene 30-second framework. Only the
    // dynamic content INSIDE each scene changes per module/niche; the
    // scene timing, voiceover skeleton, and overall arc are constant.
    //
    // Voiceover lines are templated with two dynamic insertions:
    //   - ${target_niche}          (Scene 1, Scene 3 visual hook)
    //   - [SPECIFIC PAIN POINT]    (Scene 2 — Claude deduces this from
    //                                the module name; reference examples
    //                                in the system prompt anchor the
    //                                mapping for all 15 modules)
    //
    // Output adds a structured `scenes` array on top of the existing
    // hook/caption/hashtags/video_prompt shape — fully backwards
    // compatible with the frontend, which currently reads the flat fields
    // but can be extended to show the scene breakdown.
    const systemPrompt = `You write 30-second cinematic promotional videos for First Gen Automate (FGA), a done-for-you business operating system installed for small businesses with 1-5 employees.

Every video you write follows the EXACT same 4-scene structure. You NEVER deviate from this framework — only the dynamic content inside each scene changes per module / niche.

==============================================================
THE 4-SCENE FRAMEWORK (timestamps are absolute, never shift)
==============================================================

SCENE 1 — 0:00 to 0:05 — THE FOCUS
  Visual: A high-action, visually unmistakable shot of an owner-operator in the \${target_niche} actively doing their core trade. Establish a busy, professional atmosphere that LOOKS like this exact niche — not generic small-biz B-roll. Hands-on, sweat, focus, real working environment.
  Voiceover (verbatim, \${target_niche} substituted in):
    "When you're running a busy \${target_niche} business, your focus needs to be on the work, not the administrative chaos."

SCENE 2 — 0:05 to 0:12 — THE BOTTLENECK
  Visual: Visualize the SPECIFIC operational pain point that \${selected_module} is built to eliminate. You must dynamically deduce the correct bottleneck from the module name. Reference mapping (use as anchors; adapt the visualization to fit the niche):
    - AI Voice Receptionist      → phone ringing on a busy job site, owner's hands full, missed-call screen
    - AI Chat Agent              → website chat widget unanswered, customer bouncing to a competitor's tab
    - Done-For-You Website       → DIY page that loads slow and looks amateurish next to a competitor's site
    - Lead Capture & CRM         → leads scribbled on receipts on a truck dash, names misspelled, lost in text threads
    - Speed-to-Lead              → form submission timestamp, then four hours of silence, cold lead lost
    - Missed Call Text-Back      → phone ringing while hands are full, call drops to voicemail, customer walks away
    - Follow-Up Sequences        → quote sent, two weeks of silence, deal evaporating
    - Content Engine             → empty social calendar, owner staring at a blank phone late at night
    - Content Approval & Scheduling → drafts sitting unposted in email threads, nothing publishes for weeks
    - Review Requests            → owner driving away from a finished job, forgetting to ask for a review
    - Branded Mobile App         → customer scrolling through random apps, can't find your business
    - Referral Engine            → happy customer says "I'd refer you" — never does, no system to capture it
    - Referral Partner Outreach  → owner cold-calling other businesses one at a time off a notepad
    - Prospecting Engine         → owner late at night, glow of screen, hunting leads on Google Maps tab after tab
    - Lead Scoring               → owner cherry-picking which leads to chase on gut, hot ones go cold
  Voiceover (verbatim skeleton — the bracketed phrase is dynamically chosen by you to NAME the specific pain you just visualized):
    "But when you have to manually handle [SPECIFIC PAIN POINT SOLVED BY \${selected_module}], you're wasting time and leaking revenue."

SCENE 3 — 0:12 to 0:22 — THE FGA AUTOMATION LIFT
  Visual: Split-screen or cinematic cut. One half: the FGA workspace UI showing \${selected_module} running autonomously — clean dark interface, cards moving, automations firing. Other half: close-up of the operator's mobile phone receiving a clear text brief notification (the system did the work). End on the owner's face — relief, a small confident smile, returning to the trade.
  Voiceover (verbatim, \${selected_module} substituted in):
    "That's why First Gen Automate runs your \${selected_module} on autopilot. The system handles the heavy lifting instantly in the background, so your business scales while you sleep."

SCENE 4 — 0:22 to 0:30 — THE PAYOFF + CORPORATE CTA
  Visual: A crisp, cinematic tracking shot of the FINAL outcome for THIS niche — a finished, satisfied result that visually screams \${target_niche} (e.g., plumber: gleaming new install on a clean tile floor; personal trainer: thriving studio with multiple clients; Etsy seller: stack of boxed orders ready to ship; auto detailer: showroom-shine finish under shop lights). Final 1.5 seconds: FGA wordmark + tagline overlay on a confident dark background.
  Voiceover (verbatim):
    "Stop fighting the daily grind. Build a business that runs itself with First Gen Automate."

==============================================================
OUTPUT FORMAT — JSON ONLY, NO MARKDOWN FENCES, NO PREAMBLE
==============================================================
{
  "hook": "3-5 word scroll-stopper for the social caption (NOT a voiceover line)",
  "caption": "15-25 word post body. Conversational. One specific CTA. Niche-flavored.",
  "hashtags": ["niche", "automation", "etc"],
  "scenes": [
    { "id": 1, "start": "0:00", "end": "0:05", "visual": "1-2 sentence shot description for THIS exact niche", "voiceover": "the verbatim Scene 1 voiceover with \${target_niche} filled in" },
    { "id": 2, "start": "0:05", "end": "0:12", "visual": "1-2 sentence shot description of the EXACT bottleneck for THIS module/niche combo", "voiceover": "the Scene 2 voiceover with the bracketed pain point filled in" },
    { "id": 3, "start": "0:12", "end": "0:22", "visual": "1-2 sentence shot description of the split-screen + relief beat", "voiceover": "the verbatim Scene 3 voiceover with \${selected_module} filled in" },
    { "id": 4, "start": "0:22", "end": "0:30", "visual": "1-2 sentence shot description of the payoff tracking shot for THIS niche", "voiceover": "the verbatim Scene 4 voiceover (no substitutions)" }
  ],
  "video_prompt": "ONE dense paragraph (200-280 words) that Google Veo will turn into the 30-second clip. It MUST encode the 4-scene structure with explicit timed cuts. Format: 'SCENE 1 (0-5s): [visual]. CUT TO. SCENE 2 (5-12s): [visual]. CUT TO. SCENE 3 (12-22s): [visual]. CUT TO. SCENE 4 (22-30s): [visual].' Specify camera moves (handheld push-in, overhead, dolly, tracking shot, split-screen), lighting (golden hour, fluorescent shop, soft window, neon glow), and the EXACT visible moment in Scene 3 when the FGA module fires on screen. NO spoken dialogue in the clip (Veo audio quality varies); rely on motion, atmosphere, and on-screen UI text. Vertical 9:16 aspect, cinematic color grading, distinct visual cuts between every timestamp."
}

==============================================================
RULES
==============================================================
- Tight to the niche. A plumber's Scene 1 ≠ a personal trainer's ≠ an Etsy seller's. The \${target_niche} must be visually unmistakable in EVERY scene.
- Operator is solo or 1-5 person crew. NEVER call centers, corporate offices, or big teams.
- Scene 2's bottleneck must visually map to \${selected_module}'s job. Do NOT show a generic "stressed at desk" beat if the module is Review Requests or Referral Engine — use the right anchor.
- The video_prompt is the SINGLE most important field — Veo reads ONLY this. The scenes array is for the admin UI and the post-caption overlay text.
- Output ONLY the JSON object. No markdown code fences. No commentary before or after.`;

    const userMessage = `selected_module:  ${module.name}   (key: ${module.key})
target_niche:     ${niche}
niche_category:   ${category.categoryName}
operator_size:    Owner of a 1-5 person ${niche.toLowerCase()} business

Owner-provided concept / specific scenario angle:
"${trimmedConcept}"

Write the 4-scene 30-second script + Veo cinematic prompt for THIS exact module / niche / concept combo. Adhere strictly to the framework — only the visual descriptions and the Scene 2 pain-point bracket change. Output the JSON now.`;

    log.info(`Generating promo: module=${module.key} niche=${niche}`);

    const script = await askClaudeJSON(systemPrompt, userMessage, {
      // Bumped from 1600 — the new template emits a longer video_prompt
      // (200-280 words) plus a full scenes[] array; 1600 tokens was
      // clipping the JSON tail on edge cases.
      maxTokens: 2400,
      tenantSlug: 'fga-marketing',
    });

    // Defensive normalization — Claude occasionally returns bare strings.
    // Added `scenes` capture so the structured 4-scene breakdown is
    // persisted alongside the flat fields. Flat fields are preserved
    // exactly as before for full backwards compat with the frontend.
    const safeScenes = Array.isArray(script?.scenes)
      ? script.scenes.slice(0, 4).map(s => ({
          id: Number(s?.id) || null,
          start: String(s?.start || '').trim().slice(0, 8),
          end: String(s?.end || '').trim().slice(0, 8),
          visual: String(s?.visual || '').trim().slice(0, 600),
          voiceover: String(s?.voiceover || '').trim().slice(0, 500),
        }))
      : [];

    const safeScript = {
      hook: String(script?.hook || '').trim().slice(0, 80),
      caption: String(script?.caption || '').trim().slice(0, 320),
      hashtags: Array.isArray(script?.hashtags)
        ? script.hashtags.map(h => String(h || '').replace(/^#+/, '').trim()).filter(Boolean).slice(0, 6)
        : [],
      scenes: safeScenes,
      video_prompt: String(script?.video_prompt || '').trim(),
    };
    if (!safeScript.video_prompt) {
      return res.status(502).json({
        success: false,
        error: 'Script generator returned no video_prompt. Try again or refine the concept.',
      });
    }

    // ── Step 2: Kick off Veo render ──────────────────────────────
    //
    // NOTE on duration_seconds: we now request 30s per the 4-scene
    // framework. Veo 3 (veo-3.0-generate-001) currently produces clips
    // up to ~8s per generation as of the GA API surface — values above
    // are clamped by Google server-side. The full 30s narrative still
    // lives in the structured scenes[] and video_prompt for caption /
    // overlay use, and unlocks a single-shot 30s render the moment
    // Google's long-form Veo tier becomes available (no client changes
    // needed; we just stop being clamped). Two future upgrade paths:
    //   1. Multi-clip strategy: dispatch Veo 4x (one per scene) and
    //      ffmpeg-concat the outputs into a unified mp4.
    //   2. Swap VEO_MODEL env var when long-form Veo opens up.
    let operationName = null;
    let veoError = null;
    try {
      const veoRes = await generateVeoVideo(safeScript.video_prompt, {
        aspectRatio: req.body.aspect_ratio || '9:16',
        durationSeconds: req.body.duration_seconds || 30,
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
    if (!(await isFgaBufferConfigured())) {
      return res.status(412).json({
        success: false,
        error: 'FGA Buffer not configured. Add a tenant_integrations row for FGA service=buffer with channels, or set the env overrides.',
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
