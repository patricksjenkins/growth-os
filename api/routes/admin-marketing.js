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
const {
  generateVeoVideo,
  pollVeoOperation,
  extendVeoVideo,
  extractFileUriFromPoll,
} = require('../../integrations/veo');
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

    // ── Step 1: Claude writes script + TWO cinematic Veo prompts ─
    //
    // The template now produces a 16-second narrative split across two
    // Veo generations (Veo 3 caps single clips at ~8s):
    //
    //   Base clip       0-8s   Scenes 1 + 2 (Focus + Friction)
    //   Extension clip  8-16s  Scenes 3 + 4 (Lift + Payoff)
    //
    // The extension clip is rendered as a CONTINUATION of the base
    // (Veo extension API in integrations/veo.js#extendVeoVideo), so the
    // operator's identity, lighting, and setting visually carry forward
    // from clip 1 into clip 2 — that's the whole point of using
    // extension over two independent renders.
    //
    // Voiceover skeleton:
    //   0-8s   "When you're busy running your ${target_niche} business,
    //           you can't waste time fighting manual [SPECIFIC PAIN
    //           POINT SOLVED BY ${selected_module}]."
    //   8-16s  "That's why First Gen Automate runs your
    //           ${selected_module} on autopilot. Build a business that
    //           runs itself."
    const systemPrompt = `You write 16-second cinematic promotional videos for First Gen Automate (FGA), a done-for-you business operating system installed for small businesses with 1-5 employees.

Every video you write follows the EXACT same 4-scene structure across TWO 8-second Veo renders. You NEVER deviate from this framework — only the dynamic content inside each scene changes per module / niche.

==============================================================
THE 16-SECOND FRAMEWORK (4 scenes × 4 seconds, across 2 Veo clips)
==============================================================

  BASE CLIP (0-8s) — FOCUS + FRICTION
  ────────────────────────────────────
  SCENE 1 — 0:00 to 0:04 — THE FOCUS
    Visual: A high-action, visually unmistakable shot of an owner-operator in the \${target_niche} actively doing their core trade. Establish a busy, professional atmosphere that LOOKS like THIS exact niche — not generic small-biz B-roll. Hands-on, sweat, focus, real working environment.

  SCENE 2 — 0:04 to 0:08 — THE BOTTLENECK
    Visual: The SPECIFIC operational pain point that \${selected_module} is built to eliminate. You must dynamically deduce the correct bottleneck from the module name. Reference anchors:
      - AI Voice Receptionist      → phone ringing on a busy job site, owner's hands full, missed-call screen
      - AI Chat Agent              → website chat widget unanswered, customer bouncing to a competitor's tab
      - Done-For-You Website       → DIY page loading slow next to a competitor's site
      - Lead Capture & CRM         → leads scribbled on receipts on a truck dash, names misspelled
      - Speed-to-Lead              → form submission timestamp, four hours of silence, cold lead lost
      - Missed Call Text-Back      → phone ringing while hands are full, call drops to voicemail
      - Follow-Up Sequences        → quote sent, two weeks of silence, deal evaporating
      - Content Engine             → empty social calendar, owner staring at a blank phone
      - Content Approval & Scheduling → drafts sitting unposted in email threads
      - Review Requests            → owner driving away from a finished job forgetting to ask
      - Branded Mobile App         → customer scrolling random apps, can't find the business
      - Referral Engine            → happy customer says "I'd refer you" — never does
      - Referral Partner Outreach  → owner cold-calling other businesses one at a time off a notepad
      - Prospecting Engine         → owner late at night, glow of screen, hunting leads tab after tab
      - Lead Scoring               → owner cherry-picking leads on gut, hot ones go cold
    The owner is too overwhelmed mid-work to stop and fix the bottleneck.

  Voiceover for the WHOLE base clip (0-8s, verbatim skeleton — fill the bracket):
    "When you're busy running your \${target_niche} business, you can't waste time fighting manual [SPECIFIC PAIN POINT SOLVED BY \${selected_module}]."

  EXTENSION CLIP (8-16s) — LIFT + PAYOFF
  ───────────────────────────────────────
  SCENE 3 — 0:08 to 0:12 — THE FGA AUTOMATION LIFT
    Visual: Cut to a close-up of the FGA mobile interface running \${selected_module} on autopilot — clean dark UI, cards animating, automation firing. The operator's phone receives a clear text-brief notification proving the task was handled. The operator's face relaxes — a small confident smile.

  SCENE 4 — 0:12 to 0:16 — THE PAYOFF + CORPORATE CTA
    Visual: A crisp cinematic tracking shot of the FINAL outcome for THIS niche — a finished, satisfied result that visually screams \${target_niche} (e.g., plumber: gleaming new install on a clean tile floor; personal trainer: thriving studio with multiple clients; Etsy seller: stack of boxed orders ready to ship; auto detailer: showroom-shine finish under shop lights). Final 1.5 seconds: modern FGA wordmark + tagline overlay on a confident dark background.

  Voiceover for the WHOLE extension clip (8-16s, verbatim, \${selected_module} substituted in):
    "That's why First Gen Automate runs your \${selected_module} on autopilot. Build a business that runs itself."

==============================================================
CONTINUITY — CRITICAL FOR THE EXTENSION CALL
==============================================================
Scenes 3-4 must feel like a continuation of scenes 1-2. The SAME operator, the SAME work environment, the SAME wardrobe/lighting palette carries through. The extension_video_prompt MUST start with a continuity anchor (e.g. "Continuing from the previous shot of the [operator/setting]...") so Veo's extension API has a visual handle.

==============================================================
OUTPUT FORMAT — JSON ONLY, NO MARKDOWN FENCES, NO PREAMBLE
==============================================================
{
  "hook": "3-5 word scroll-stopper for the social caption (NOT a voiceover line)",
  "caption": "15-25 word post body. Conversational. One specific CTA. Niche-flavored.",
  "hashtags": ["niche", "automation", "etc"],
  "scenes": [
    { "id": 1, "start": "0:00", "end": "0:04", "clip": "base",      "visual": "1-2 sentence shot description for THIS exact niche", "voiceover": "" },
    { "id": 2, "start": "0:04", "end": "0:08", "clip": "base",      "visual": "1-2 sentence shot of the EXACT bottleneck for THIS module/niche combo", "voiceover": "" },
    { "id": 3, "start": "0:08", "end": "0:12", "clip": "extension", "visual": "1-2 sentence shot of the FGA UI + relief beat", "voiceover": "" },
    { "id": 4, "start": "0:12", "end": "0:16", "clip": "extension", "visual": "1-2 sentence shot of the payoff tracking shot for THIS niche", "voiceover": "" }
  ],
  "voiceover_base":      "the verbatim 0-8s voiceover with the bracketed pain point filled in",
  "voiceover_extension": "the verbatim 8-16s voiceover with \${selected_module} filled in",
  "base_video_prompt":      "ONE dense paragraph (140-200 words) that Veo will turn into the FIRST 8-second clip (scenes 1-2). MUST encode 'SCENE 1 (0-4s): [visual]. CUT TO. SCENE 2 (4-8s): [visual].' Specify camera moves (handheld push-in, overhead, dolly, tracking), lighting (golden hour, fluorescent shop, soft window, neon), wardrobe, and the EXACT moment of friction. NO spoken dialogue in the clip — Veo audio quality varies. Vertical 9:16, cinematic color grading.",
  "extension_video_prompt": "ONE dense paragraph (140-200 words) that Veo will turn into the SECOND 8-second clip (scenes 3-4) as a CONTINUATION of the base. MUST begin with a continuity anchor ('Continuing seamlessly from the previous shot of the [SAME operator/setting], ...'). Then: 'SCENE 3 (0-4s): [visual]. CUT TO. SCENE 4 (4-8s): [visual].' (Times here are RELATIVE to this clip — Veo doesn't know about the global 0-16s timeline.) Specify the EXACT visible moment Scene 3 shows the FGA module firing on the phone. NO spoken dialogue. Vertical 9:16, cinematic color grading."
}

==============================================================
RULES
==============================================================
- Tight to the niche. A plumber's clip ≠ a personal trainer's ≠ an Etsy seller's. \${target_niche} must be visually unmistakable in EVERY scene.
- Operator is solo or 1-5 person crew. NEVER call centers, corporate offices, or big teams.
- Scene 2's bottleneck must visually map to \${selected_module}'s job — don't show "stressed at desk" if the module is Review Requests or Referral Engine.
- The base_video_prompt and extension_video_prompt are the TWO most important fields — Veo reads ONLY these for the two API calls.
- Output ONLY the JSON object. No markdown fences. No commentary before or after.`;

    const userMessage = `selected_module:  ${module.name}   (key: ${module.key})
target_niche:     ${niche}
niche_category:   ${category.categoryName}
operator_size:    Owner of a 1-5 person ${niche.toLowerCase()} business

Owner-provided concept / specific scenario angle:
"${trimmedConcept}"

Write the 4-scene 30-second script + Veo cinematic prompt for THIS exact module / niche / concept combo. Adhere strictly to the framework — only the visual descriptions and the Scene 2 pain-point bracket change. Output the JSON now.`;

    log.info(`Generating promo: module=${module.key} niche=${niche}`);

    const script = await askClaudeJSON(systemPrompt, userMessage, {
      // Bumped further — two video prompts + scenes[] + two voiceovers.
      maxTokens: 2800,
      tenantSlug: 'fga-marketing',
    });

    // Defensive normalization — Claude occasionally returns bare strings.
    // The new shape captures base / extension video prompts and split
    // voiceover lines alongside the structured scenes array.
    const safeScenes = Array.isArray(script?.scenes)
      ? script.scenes.slice(0, 4).map(s => ({
          id: Number(s?.id) || null,
          start: String(s?.start || '').trim().slice(0, 8),
          end: String(s?.end || '').trim().slice(0, 8),
          clip: s?.clip === 'extension' ? 'extension' : 'base',
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
      voiceover_base: String(script?.voiceover_base || '').trim().slice(0, 500),
      voiceover_extension: String(script?.voiceover_extension || '').trim().slice(0, 500),
      base_video_prompt: String(script?.base_video_prompt || '').trim(),
      extension_video_prompt: String(script?.extension_video_prompt || '').trim(),
      // Back-compat with the old single-prompt shape for any caller
      // (frontend / worker) that still reads `video_prompt`.
      video_prompt: String(script?.base_video_prompt || script?.video_prompt || '').trim(),
    };
    if (!safeScript.base_video_prompt) {
      return res.status(502).json({
        success: false,
        error: 'Script generator returned no base_video_prompt. Try again or refine the concept.',
      });
    }
    if (!safeScript.extension_video_prompt) {
      log.warn('Script generator returned no extension_video_prompt — clip will be 8s only.');
    }

    // ── Step 2: Kick off Veo BASE render ─────────────────────────
    //
    // The pipeline is two-step:
    //   1. Render the base clip now with base_video_prompt (this call).
    //   2. When the base completes (lazy-poll on GET /videos/:id), the
    //      poll route automatically dispatches an extension call with
    //      extension_video_prompt + a `video` reference to the base.
    //
    // We persist BOTH prompts on the draft so step 2 has everything it
    // needs without re-running Claude.
    let operationName = null;
    let veoError = null;
    try {
      const veoRes = await generateVeoVideo(safeScript.base_video_prompt, {
        aspectRatio: req.body.aspect_ratio || '9:16',
        durationSeconds: req.body.duration_seconds || 8,
        tenantSlug: 'fga-marketing',
      });
      operationName = veoRes.operation_name;
    } catch (e) {
      // Don't abandon the run — the script is still useful. The admin
      // can re-trigger the render from the draft view if Veo is down.
      veoError = e.message || String(e);
      log.warn(`Veo base kickoff failed (script saved anyway): ${veoError}`);
    }

    // ── Step 3: Persist as a content_drafts row on FGA tenant ────
    //
    // Two-step pipeline state lives under campaign_payload.veo:
    //   stage:                'base' | 'extension' | 'done' | 'failed' | 'draft_no_video'
    //   base.operation_name, base.video_url, base.file_uri, base.status, base.error
    //   extension.operation_name, extension.video_url, extension.file_uri,
    //     extension.status, extension.error, extension.unsupported
    //   final_video_urls:     [base_url, extension_url] in playback order
    //
    // The old single-clip fields (operation_name, video_url at top level)
    // are also written so existing frontend code that hasn't migrated
    // continues to see the BASE clip while we wait for the extension.
    const initialStage = operationName ? 'base' : 'draft_no_video';
    const veoPayload = {
      stage: initialStage,
      error: veoError,
      queued_at: new Date().toISOString(),
      base: {
        operation_name: operationName,
        status: operationName ? 'rendering' : 'failed',
        error: veoError,
        video_url: null,
        file_uri: null,
        completed_at: null,
      },
      extension: {
        operation_name: null,
        status: 'pending_base',
        error: null,
        unsupported: false,
        video_url: null,
        file_uri: null,
        completed_at: null,
      },
      // ─── back-compat mirrors of the old shape ─────────────────
      operation_name: operationName,
      status: operationName ? 'rendering' : 'failed',
      video_url: null,
    };

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
        image_urls: [],            // populated when first Veo render completes
        topic: `${module.name} · ${niche}`,
        format_template: 'fga-module-promo',
        campaign_payload: {
          content_type: CONTENT_TYPE,   // duplicated here for filter convenience
          module: { id: module.id, key: module.key, name: module.name },
          niche: { category_key: category.categoryKey, category_name: category.categoryName, niche },
          owner_concept: trimmedConcept,
          script: safeScript,
          veo: veoPayload,
        },
      })
      .select()
      .single();

    if (dbErr) {
      log.error(`Draft insert failed: ${dbErr.message}`);
      return res.status(500).json({ success: false, error: dbErr.message });
    }

    log.success(`Promo draft created: ${draft.id} (Veo base op: ${operationName || 'none'})`);

    res.json({
      success: true,
      draft_id: draft.id,
      status: initialStage,
      stage: initialStage,
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
//
// Drives the two-step pipeline lazily on every poll from the frontend:
//
//   stage=base       → poll base operation; on done, dispatch extension
//   stage=extension  → poll extension operation; on done, finalize
//   stage=done/failed → no-op, return existing draft
//
// The extension dispatch is best-effort: if the Gemini API surface
// rejects the `video` reference field on veo-3.0-generate-001, we mark
// veo.extension.unsupported=true and finalize with only the base clip.
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
    const stage = veo.stage || (veo.operation_name ? 'base' : 'draft_no_video');

    // Already terminal → return as-is.
    if (stage === 'done' || stage === 'failed' || stage === 'draft_no_video') {
      return res.json({ success: true, draft });
    }

    // ── Stage: base ─────────────────────────────────────────────
    if (stage === 'base') {
      const baseOp = veo.base?.operation_name || veo.operation_name;
      if (!baseOp) {
        return res.json({ success: true, draft });
      }
      const baseResult = await pollVeoOperation(baseOp, { tenantSlug: 'fga-marketing' });
      if (!baseResult.done) {
        // Still rendering — frontend keeps polling.
        return res.json({ success: true, draft });
      }

      // Base finished — failed or succeeded?
      const baseFileUri = baseResult.error ? null : extractFileUriFromPoll(baseResult).fileUri;
      const baseVideoUrl = baseResult.video_url || null;

      if (baseResult.error || !baseVideoUrl) {
        // Base failed — terminate pipeline.
        const failed = {
          ...draft.campaign_payload,
          veo: {
            ...veo,
            stage: 'failed',
            error: baseResult.error || 'Base render returned no video URL',
            base: {
              ...(veo.base || {}),
              status: 'failed',
              error: baseResult.error || 'no_video_url',
              completed_at: new Date().toISOString(),
            },
            // back-compat mirrors
            status: 'failed',
            video_url: null,
          },
        };
        const { data: u } = await db.from('content_drafts')
          .update({ campaign_payload: failed })
          .eq('id', draft.id).select().single();
        return res.json({ success: true, draft: u || draft });
      }

      // Base succeeded — kick off the second clip.
      //
      // Two strategies, tried in order:
      //   1. TRUE extension via Veo's video-reference API (best continuity
      //      — same character/lighting carries through). Currently blocked
      //      on veo-3.0-generate-001 via the Gemini API surface, which
      //      returns "Video extension is not allowed for this model."
      //   2. FALLBACK independent render with the extension prompt alone.
      //      Continuity is "narrative only" — Veo redraws the operator
      //      and setting but the prompt's explicit wardrobe / scene
      //      anchors keep it visually close.
      //
      // Either way the second clip is stored on veo.extension.* and
      // the pipeline finalizes when both renders are done.
      const extensionPrompt = draft.campaign_payload?.script?.extension_video_prompt;
      let extensionOp = null;
      let extensionError = null;
      let extensionUnsupported = false;
      let extensionMode = 'extension';   // 'extension' | 'independent' | 'skipped'

      if (!extensionPrompt) {
        extensionError = 'no_extension_prompt';
        extensionMode = 'skipped';
      } else {
        // Try true extension first.
        try {
          const extRes = await extendVeoVideo(
            { fileUri: baseFileUri, videoUrl: baseVideoUrl },
            extensionPrompt,
            { aspectRatio: '9:16', durationSeconds: 8, tenantSlug: 'fga-marketing' },
          );
          extensionOp = extRes.operation_name;
        } catch (e) {
          extensionError = e.message || String(e);
          extensionUnsupported = !!e.extensionUnsupported;
          log.warn(`Extension kickoff failed: ${extensionError} (unsupported=${extensionUnsupported})`);

          // Fallback to an INDEPENDENT base render of the extension prompt.
          // We only fall back when Google explicitly rejected the
          // extension surface — for other errors (rate limit, transient
          // 500) we let the admin retry, since they'd want true
          // extension if possible.
          if (extensionUnsupported) {
            try {
              const fb = await generateVeoVideo(extensionPrompt, {
                aspectRatio: '9:16',
                durationSeconds: 8,
                tenantSlug: 'fga-marketing',
              });
              extensionOp = fb.operation_name;
              extensionMode = 'independent';
              extensionError = null;         // fallback succeeded
              log.info(`Fallback independent extension queued: ${extensionOp}`);
            } catch (e2) {
              log.warn(`Independent fallback also failed: ${e2.message}`);
              extensionError = `${extensionError} | fallback failed: ${e2.message}`;
            }
          }
        }
      }

      const nextStage = extensionOp ? 'extension' : 'done';   // no extension possible → finalize with base
      const updatedVeo = {
        ...veo,
        stage: nextStage,
        base: {
          ...(veo.base || {}),
          status: 'done',
          error: null,
          completed_at: new Date().toISOString(),
          video_url: baseVideoUrl,
          file_uri: baseFileUri,
        },
        extension: {
          ...(veo.extension || {}),
          operation_name: extensionOp,
          status: extensionOp ? 'rendering' : (extensionUnsupported ? 'unsupported' : 'skipped'),
          error: extensionError,
          unsupported: extensionUnsupported,
          mode: extensionMode,   // 'extension' | 'independent' | 'skipped'
        },
        // back-compat mirrors point at base while extension renders
        status: extensionOp ? 'rendering_extension' : 'done',
        video_url: baseVideoUrl,
      };

      const updates = {
        campaign_payload: { ...draft.campaign_payload, veo: updatedVeo },
        image_urls: [baseVideoUrl],
      };
      const { data: u } = await db.from('content_drafts')
        .update(updates).eq('id', draft.id).select().single();
      return res.json({ success: true, draft: u || { ...draft, ...updates } });
    }

    // ── Stage: extension ────────────────────────────────────────
    if (stage === 'extension') {
      const extOp = veo.extension?.operation_name;
      if (!extOp) {
        // No extension op recorded — finalize with base.
        const finalized = {
          ...draft.campaign_payload,
          veo: { ...veo, stage: 'done', status: 'done', video_url: veo.base?.video_url || veo.video_url || null },
        };
        const { data: u } = await db.from('content_drafts')
          .update({ campaign_payload: finalized })
          .eq('id', draft.id).select().single();
        return res.json({ success: true, draft: u || draft });
      }

      const extResult = await pollVeoOperation(extOp, { tenantSlug: 'fga-marketing' });
      if (!extResult.done) {
        return res.json({ success: true, draft });
      }

      const extFileUri = extResult.error ? null : extractFileUriFromPoll(extResult).fileUri;
      const extVideoUrl = extResult.video_url || null;
      const extError = extResult.error || (extVideoUrl ? null : 'no_video_url');

      // Compose the final URL list. Base always first, extension second.
      const finalUrls = [veo.base?.video_url].filter(Boolean);
      if (extVideoUrl) finalUrls.push(extVideoUrl);

      const finalizedVeo = {
        ...veo,
        stage: 'done',
        completed_at: new Date().toISOString(),
        extension: {
          ...(veo.extension || {}),
          operation_name: extOp,
          status: extError ? 'failed' : 'done',
          error: extError,
          completed_at: new Date().toISOString(),
          video_url: extVideoUrl,
          file_uri: extFileUri,
        },
        final_video_urls: finalUrls,
        total_duration_seconds: finalUrls.length === 2 ? 16 : 8,
        // back-compat mirrors point at the BASE clip (single-mp4
        // consumers still see something playable). The frontend should
        // migrate to final_video_urls for the full 16s playlist.
        status: 'done',
        video_url: veo.base?.video_url || null,
      };

      const updates = {
        campaign_payload: { ...draft.campaign_payload, veo: finalizedVeo },
        image_urls: finalUrls,
      };
      const { data: u } = await db.from('content_drafts')
        .update(updates).eq('id', draft.id).select().single();
      return res.json({ success: true, draft: u || { ...draft, ...updates } });
    }

    // Unknown stage — return as-is.
    return res.json({ success: true, draft });
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
