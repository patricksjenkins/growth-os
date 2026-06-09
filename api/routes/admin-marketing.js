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
const {
  generateSoraVideo,
  pollSoraVideo,
  uploadSoraToStorage,
  generateAndUploadThumbnail,
  SoraInvalidParamError,
  SORA_MODEL,
  SORA_SIZE,
  SORA_SECONDS,
  SORA_SECONDS_FALLBACKS,
} = require('../../integrations/sora');
const { checkMarketingVideoQuota } = require('../../core/marketing-usage-caps');
const { publishToFgaBuffer, isFgaBufferConfigured } = require('../../integrations/buffer');

// ============================================================================
// FGA BRAND TAGLINE — must close every marketing asset (video voiceover, social
// caption, brochure, ad, anything outbound). Title case, comma not period.
// See MEMORY.md "TAGLINE RULE".
// ============================================================================
const FGA_TAGLINE = 'Automate the Overhead, Focus on the Work.';

// Provider switch — default to Sora. Set VIDEO_PROVIDER=veo on Railway
// to fall back to the legacy two-step Veo pipeline without redeploy.
const VIDEO_PROVIDER = (process.env.VIDEO_PROVIDER || 'sora').toLowerCase();
const {
  MODULES,
  NICHE_CATEGORIES,
  NICHES_BY_CATEGORY,
  findCategoryForNiche,
  findModule,
} = require('../../core/marketing-taxonomy');

const log = createLogger('admin-marketing');

// V1 hardening (2026-05-24): centralized constant.
const { FGA_TENANT_ID } = require('../../core/config');
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
    video_provider: VIDEO_PROVIDER,
    sora_model: SORA_MODEL,
    sora_size: SORA_SIZE,
    sora_seconds: SORA_SECONDS,
  });
});

// ============================================================================
// GET /api/admin/marketing/quota — current generation quota status
// Used by the frontend to render the "Used: X/3 week · Y/12 month" banner.
// ============================================================================
router.get('/quota', async (req, res) => {
  try {
    const db = getServiceClient();
    const quota = await checkMarketingVideoQuota(db);
    res.json({ success: true, quota });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
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
    const { module_id, concept } = req.body || {};
    const niche = String((req.body && req.body.niche) || '').trim();

    // ── Input validation ─────────────────────────────────────────
    const module = findModule(module_id);
    if (!module) {
      return res.status(400).json({ success: false, error: 'Invalid or missing module_id' });
    }
    // A known niche resolves to its official category. An unrecognized niche
    // is accepted as a free-form "Other" occupation (e.g. "hair stylist") —
    // the Sora prompt just substitutes ${target_niche}, so any occupation
    // renders fine. We only reject an empty niche.
    let category = findCategoryForNiche(niche);
    if (!category) {
      if (!niche) {
        return res.status(400).json({ success: false, error: 'Missing niche — pick one or type a custom occupation.' });
      }
      category = { categoryKey: 'other', categoryName: 'Other' };
    }
    const trimmedConcept = String(concept || '').trim();
    if (!trimmedConcept || trimmedConcept.length < 10) {
      return res.status(400).json({
        success: false,
        error: 'Concept must be at least 10 characters — describe a specific scenario.',
      });
    }

    // ── Step 0: Quota gate ──────────────────────────────────────
    //
    // BEFORE any LLM or video API call, check the corporate marketing
    // generation cap (3/rolling-week + 12/calendar-month). Returns 429
    // if exceeded. Today's session API probes were direct API calls
    // that never inserted a content_drafts row, so they correctly
    // don't count toward the quota.
    const quota = await checkMarketingVideoQuota(db);
    if (!quota.allowed) {
      log.warn(`Marketing video quota exceeded: ${quota.reason}`);
      return res.status(429).json({
        success: false,
        error: quota.reason,
        quota,
      });
    }
    log.info(`Quota OK: ${quota.weekly_used}/${quota.weekly_max} week · ${quota.monthly_used}/${quota.monthly_max} month`);

    // ── Step 1: Claude writes the 25-second 4-act script ─────────
    //
    // Provider-aware: when VIDEO_PROVIDER='sora' (default), we ask
    // Claude for a SINGLE unified video prompt with embedded voiceover
    // directives — Sora 2 Pro renders the full 25s with native spoken
    // narration in one call. When VIDEO_PROVIDER='veo' (rollback), we
    // ask for the legacy two-clip prompt structure that powers the
    // base+extension Veo pipeline.
    //
    // 25-second 4-act timing (Sora):
    //   Scene 1  0-6s   Focus    (niche-specific work)
    //   Scene 2  6-12s  Bottleneck (module-specific pain)
    //   Scene 3  12-19s Lift     (FGA module on autopilot)
    //   Scene 4  19-25s Payoff   (finished result + CTA)
    //
    // Voiceover lines are FIXED per scene with dynamic insertions:
    //   ${target_niche}  — Scene 1
    //   [PAIN POINT]     — Scene 2 (Claude deduces from module name)
    //   ${selected_module} — Scene 3
    //   Scene 4 is verbatim, no substitutions.
    //
    // Editorial fix from the original spec (2026-05-22):
    //   Scene 3 voiceover trimmed from 28 to 21 words so it fits the
    //     7-second slot at a comfortable 180 wpm pace.
    //   Scene 4 final word: 'customer' → 'customers' (grammar fix).
    const systemPrompt = VIDEO_PROVIDER === 'sora'
      ? SORA_SYSTEM_PROMPT
      : VEO_SYSTEM_PROMPT_LEGACY;

    /* The full text of both SORA_SYSTEM_PROMPT and VEO_SYSTEM_PROMPT_LEGACY
       lives at the bottom of this file (after module.exports). */

    const userMessage = buildUserMessage({
      provider: VIDEO_PROVIDER,
      module,
      niche,
      category,
      trimmedConcept,
    });

    log.info(`Generating promo: module=${module.key} niche=${niche}`);

    // ── Voiceover word-budget enforcement ────────────────────────────
    // Sora 2 Pro on this account renders 12 seconds MAX. The script
    // must fit ≤30 words to read at natural narration pace without
    // getting cut off mid-sentence (the bug that wasted a render on
    // 2026-05-26). The prompt declares the budget but Claude does not
    // always honour it. We validate server-side and retry ONCE with
    // an emphatic correction. If the second attempt also overruns, we
    // truncate to the per-scene budget rather than burning another
    // Sora render on a script we know will get cut off.
    function countWords(s) {
      return String(s || '').trim().split(/\s+/).filter(Boolean).length;
    }
    // Observed 2026-05-26: Sora 2 Pro comfortably renders 40 words in
    // 12s (200 wpm). The earlier 30-word cap was overly conservative.
    // Holding at 36 — 4-word safety margin under the observed ceiling
    // so we never get clipped if Sora's pacing varies.
    const VOICEOVER_WORD_CAP = 36;

    let script = await askClaudeJSON(systemPrompt, userMessage, {
      // Bumped further — two video prompts + scenes[] + two voiceovers.
      maxTokens: 2800,
      tenantSlug: 'fga-marketing',
    });

    if (VIDEO_PROVIDER === 'sora') {
      const actualWordCount = countWords(script?.voiceover_full);
      if (actualWordCount > VOICEOVER_WORD_CAP) {
        log.warn(
          `Sora script overran on first pass: voiceover_full=${actualWordCount} words ` +
          `(cap=${VOICEOVER_WORD_CAP}, claude-declared=${script?.voiceover_word_count || 'n/a'}). ` +
          `Retrying with emphatic word-budget reminder.`
        );
        const retryUser = userMessage +
          `\n\n──── IMPORTANT CORRECTION ────\n` +
          `Your previous attempt returned a voiceover that was ${actualWordCount} words ` +
          `(cap is ${VOICEOVER_WORD_CAP}). At 150 wpm a ${VOICEOVER_WORD_CAP}-word script just fits 12 seconds ` +
          `with breath pauses. Your ${actualWordCount}-word version WILL get cut off mid-sentence in Sora.\n\n` +
          `Rewrite with these tighter limits (3-scene structure, 4s each):\n` +
          `  Scene 1 (0:00-0:04): ≤14 words AFTER substitution\n` +
          `  Scene 2 (0:04-0:08): ≤15 words AFTER substitution\n` +
          `  Scene 3 (0:08-0:12): exactly 7 words (the FGA tagline, unchanged)\n` +
          `  TOTAL: ≤${VOICEOVER_WORD_CAP} words.\n\n` +
          `Count your words BEFORE returning JSON. If voiceover_word_count > ${VOICEOVER_WORD_CAP}, rewrite shorter. ` +
          `Output the corrected JSON only — no apology, no commentary.`;
        const retryScript = await askClaudeJSON(systemPrompt, retryUser, {
          maxTokens: 2800,
          tenantSlug: 'fga-marketing',
        });
        const retryCount = countWords(retryScript?.voiceover_full);
        if (retryCount <= VOICEOVER_WORD_CAP && retryCount > 0) {
          log.info(`Sora script retry succeeded: ${retryCount} words.`);
          script = retryScript;
        } else {
          // Two consecutive overruns. Refuse to spend a Sora render on
          // a script we already know overruns. Surface to the founder.
          log.error(
            `Sora script retry ALSO overran: ${retryCount} words. ` +
            `Refusing to start a render with a script that will be cut off.`
          );
          return res.status(422).json({
            success: false,
            error: `Voiceover script overran the 12-second budget twice in a row ` +
                   `(${actualWordCount} then ${retryCount} words; cap is ${VOICEOVER_WORD_CAP}). ` +
                   `Refusing to start a Sora render that would be truncated mid-sentence. ` +
                   `Try a different module/niche pairing or hit Generate again.`,
            details: {
              first_attempt_words: actualWordCount,
              retry_attempt_words: retryCount,
              word_cap: VOICEOVER_WORD_CAP,
            },
          });
        }
      } else {
        log.info(`Sora script word count OK on first pass: ${actualWordCount}/${VOICEOVER_WORD_CAP}.`);
      }
    }

    // Defensive normalization — supports BOTH provider shapes:
    //   Sora path: { video_prompt, voiceover_full, scenes[4] }
    //   Veo path:  { base_video_prompt, extension_video_prompt,
    //                voiceover_base, voiceover_extension, scenes[4] }
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
      // Sora-only fields
      voiceover_full: String(script?.voiceover_full || '').trim().slice(0, 1200),
      // Veo-only fields
      voiceover_base: String(script?.voiceover_base || '').trim().slice(0, 500),
      voiceover_extension: String(script?.voiceover_extension || '').trim().slice(0, 500),
      base_video_prompt: String(script?.base_video_prompt || '').trim(),
      extension_video_prompt: String(script?.extension_video_prompt || '').trim(),
      // Unified field used by Sora dispatch AND for back-compat with
      // older callers that read `video_prompt` directly.
      video_prompt: String(
        script?.video_prompt ||
        script?.base_video_prompt ||
        ''
      ).trim(),
    };

    if (VIDEO_PROVIDER === 'sora' && !safeScript.video_prompt) {
      return res.status(502).json({
        success: false,
        error: 'Script generator returned no video_prompt. Try again or refine the concept.',
      });
    }
    if (VIDEO_PROVIDER === 'veo' && !safeScript.base_video_prompt) {
      return res.status(502).json({
        success: false,
        error: 'Script generator returned no base_video_prompt. Try again or refine the concept.',
      });
    }

    // ── Step 2: Persist as 'pending_review' — NO RENDER DISPATCH ─
    //
    // 2026-05-26: the render dispatch (the expensive Sora/Veo step) is
    // now deferred to POST /videos/:draftId/render so the founder can
    // review the script + voiceover + video_prompt and edit them
    // BEFORE money is spent on a render. The script-generation step
    // above is cheap (Claude API only); the render is the costly one.
    const persisted = { content_type: CONTENT_TYPE };
    persisted.module = { id: module.id, key: module.key, name: module.name };
    persisted.niche = { category_key: category.categoryKey, category_name: category.categoryName, niche };
    persisted.owner_concept = trimmedConcept;
    persisted.script = safeScript;
    persisted.provider = VIDEO_PROVIDER;
    // sora/veo fields are intentionally empty until /render is called.

    const { data: draft, error: dbErr } = await db
      .from('content_drafts')
      .insert({
        tenant_id: FGA_TENANT_ID,
        content_type: CONTENT_TYPE,
        platform: 'instagram',     // primary FGA platform; overridable at publish time
        status: 'pending_review',  // founder must approve before Sora dispatch
        headline: safeScript.hook,
        body: safeScript.caption,
        hashtags: safeScript.hashtags,
        image_urls: [],            // populated by the poll route when render completes
        topic: `${module.name} · ${niche}`,
        format_template: 'fga-module-promo',
        campaign_payload: persisted,
      })
      .select()
      .single();

    if (dbErr) {
      log.error(`Draft insert failed: ${dbErr.message}`);
      return res.status(500).json({ success: false, error: dbErr.message });
    }

    log.success(`Promo draft created (pending_review): ${draft.id}`);

    // Refresh quota numbers AFTER the insert so the response carries
    // the updated counter the frontend will use to render the banner.
    const postQuota = await checkMarketingVideoQuota(db).catch(() => null);

    res.json({
      success: true,
      draft_id: draft.id,
      provider: VIDEO_PROVIDER,
      sora: null,
      veo: null,
      script: safeScript,
      status: 'pending_review',
      quota: postQuota || quota,
    });
  } catch (err) {
    log.error(`generate-video failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// Helper — dispatchRender(safeScript, opts)
//
// Sends the script to the active video provider (Sora or Veo). Returns
// the renderState object that gets merged into campaign_payload. Used
// by POST /videos/:draftId/render below. Extracted from the legacy
// inline-dispatch path in /generate-video.
// ============================================================================
async function dispatchRender(safeScript, opts = {}) {
  if (VIDEO_PROVIDER === 'sora') {
    let soraId = null;
    let soraError = null;
    let soraStatus = 'queued';
    let requestedSeconds = SORA_SECONDS;

    const fallbackChain = [SORA_SECONDS, ...SORA_SECONDS_FALLBACKS.filter(s => s !== SORA_SECONDS)];
    let succeeded = false;
    for (const seconds of fallbackChain) {
      try {
        const r = await generateSoraVideo(safeScript.video_prompt, {
          model: SORA_MODEL,
          size: SORA_SIZE,
          seconds,
          tenantSlug: 'fga-marketing',
        });
        soraId = r.id;
        soraStatus = r.status;
        requestedSeconds = r.seconds;
        if (seconds !== SORA_SECONDS) {
          log.warn(`Sora accepted fallback seconds=${seconds} (requested ${SORA_SECONDS})`);
        }
        succeeded = true;
        break;
      } catch (e) {
        if (e instanceof SoraInvalidParamError && e.invalidParam === 'seconds') {
          log.warn(`Sora rejected seconds=${seconds}, trying next fallback`);
          continue;
        }
        soraError = e.message || String(e);
        log.warn(`Sora kickoff failed: ${soraError}`);
        break;
      }
    }
    if (!succeeded && !soraError) {
      soraError = 'All documented seconds values were rejected by Sora.';
    }

    return {
      provider: 'sora',
      sora: {
        video_id: soraId,
        status: soraStatus,
        error: soraError,
        requested_seconds: requestedSeconds,
        model: SORA_MODEL,
        size: SORA_SIZE,
        queued_at: new Date().toISOString(),
        completed_at: null,
        progress: 0,
      },
    };
  }

  // Legacy Veo two-step pipeline (rollback path)
  let operationName = null;
  let veoError = null;
  try {
    const veoRes = await generateVeoVideo(safeScript.base_video_prompt, {
      aspectRatio: opts.aspect_ratio || '9:16',
      durationSeconds: opts.duration_seconds || 8,
      tenantSlug: 'fga-marketing',
    });
    operationName = veoRes.operation_name;
  } catch (e) {
    veoError = e.message || String(e);
    log.warn(`Veo base kickoff failed: ${veoError}`);
  }
  return {
    provider: 'veo',
    veo: {
      stage: operationName ? 'base' : 'draft_no_video',
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
      operation_name: operationName,
      status: operationName ? 'rendering' : 'failed',
      video_url: null,
    },
  };
}

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

    // ── Sora provider path ──────────────────────────────────────
    //
    // Single render, no two-step pipeline. Just poll until status is
    // 'completed' or 'failed', then persist the result.
    if (draft.campaign_payload?.provider === 'sora' || draft.campaign_payload?.sora?.video_id) {
      const soraState = draft.campaign_payload?.sora || {};
      const terminalStatuses = ['completed', 'failed'];
      if (!soraState.video_id || terminalStatuses.includes(soraState.status)) {
        return res.json({ success: true, draft });
      }

      const result = await pollSoraVideo(soraState.video_id, { tenantSlug: 'fga-marketing' });
      const updatedSora = {
        ...soraState,
        status: result.status,
        progress: result.progress,
        completed_at: result.completed_at,
        error: result.error,
      };

      const updates = {
        campaign_payload: { ...draft.campaign_payload, sora: updatedSora },
      };

      // On completion: download the mp4 from OpenAI and stage it to
      // public Supabase Storage. The public URL is what the frontend
      // <video> tag loads AND what Buffer fetches at publish time.
      // We do this once per draft (skip if public_url is already set).
      if (result.status === 'completed' && !updatedSora.public_video_url) {
        try {
          const staged = await uploadSoraToStorage(db, soraState.video_id, draft.id);
          updatedSora.public_video_url = staged.public_url;
          updatedSora.storage_path = staged.storage_path;
          updatedSora.bytes = staged.bytes;
          updatedSora.with_overlay = staged.with_overlay;
          updatedSora.staging_error = null;
          updates.image_urls = [staged.public_url];
          updates.campaign_payload = { ...draft.campaign_payload, sora: updatedSora };
        } catch (stageErr) {
          log.error(`Sora storage upload failed for draft ${draft.id}: ${stageErr.message}`);
          updatedSora.staging_error = stageErr.message;
          updates.campaign_payload = { ...draft.campaign_payload, sora: updatedSora };
          // We do NOT mark the render itself as failed — admin can
          // still see preview via proxy fallback, and a retry hook
          // can re-stage if Supabase had a transient hiccup.
        }
      }

      const { data: updated } = await db
        .from('content_drafts')
        .update(updates)
        .eq('id', draft.id)
        .select()
        .single();

      return res.json({ success: true, draft: updated || { ...draft, ...updates } });
    }

    // ── Veo provider path (legacy two-step pipeline) ───────────
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
// POST /api/admin/marketing/videos/:draftId/render
//
// Approve a pending_review draft and dispatch it to Sora/Veo. This is
// where the money gets spent. Reads the latest script from the DB (so
// any user edits made via PATCH are picked up) and writes the new
// sora/veo state back to campaign_payload, flipping status to 'draft'
// so the existing polling code picks it up.
// ============================================================================
router.post('/videos/:draftId/render', async (req, res) => {
  try {
    const db = getServiceClient();

    const { data: draft, error } = await db
      .from('content_drafts')
      .select('id, status, campaign_payload')
      .eq('id', req.params.draftId)
      .eq('tenant_id', FGA_TENANT_ID)
      .eq('content_type', CONTENT_TYPE)
      .maybeSingle();
    if (error) throw error;
    if (!draft) return res.status(404).json({ success: false, error: 'Not found' });
    if (draft.status !== 'pending_review') {
      return res.status(409).json({
        success: false,
        error: `Draft is in status '${draft.status}' — render can only be dispatched from 'pending_review'.`,
      });
    }

    const script = draft.campaign_payload?.script;
    if (!script) {
      return res.status(422).json({
        success: false,
        error: 'Draft has no script — cannot render.',
      });
    }
    if (VIDEO_PROVIDER === 'sora' && !script.video_prompt) {
      return res.status(422).json({
        success: false,
        error: 'Script has no video_prompt — cannot dispatch to Sora.',
      });
    }
    if (VIDEO_PROVIDER === 'veo' && !script.base_video_prompt) {
      return res.status(422).json({
        success: false,
        error: 'Script has no base_video_prompt — cannot dispatch to Veo.',
      });
    }

    log.info(`Dispatching render for draft ${draft.id} (provider=${VIDEO_PROVIDER})`);
    const renderState = await dispatchRender(script, {
      aspect_ratio: req.body?.aspect_ratio,
      duration_seconds: req.body?.duration_seconds,
    });

    const newPayload = { ...(draft.campaign_payload || {}) };
    newPayload.provider = renderState.provider;
    if (renderState.sora) newPayload.sora = renderState.sora;
    if (renderState.veo) newPayload.veo = renderState.veo;

    const { data: updated, error: upErr } = await db
      .from('content_drafts')
      .update({
        status: 'draft',
        campaign_payload: newPayload,
        updated_at: new Date().toISOString(),
      })
      .eq('id', draft.id)
      .select()
      .single();
    if (upErr) throw upErr;

    const providerLogTag = renderState.provider === 'sora'
      ? `Sora id: ${renderState.sora?.video_id || 'none'}`
      : `Veo op: ${renderState.veo?.base?.operation_name || 'none'}`;
    log.success(`Render dispatched for ${draft.id} (${providerLogTag})`);

    res.json({
      success: true,
      draft: updated,
      provider: renderState.provider,
      sora: renderState.sora || null,
      veo: renderState.veo || null,
    });
  } catch (err) {
    log.error(`render dispatch failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// PATCH /api/admin/marketing/videos/:draftId
//
// Edit the post copy BEFORE approve & schedule. Lets the founder rewrite
// the AI-generated headline/body/hashtags without regenerating the video.
//
// Body: { headline?: string, body?: string, hashtags?: string[] }
// Only the supplied fields are updated. Trimmed + length-capped server-side.
// Blocked once status='posted' — published drafts are immutable.
// ============================================================================
router.patch('/videos/:draftId', async (req, res) => {
  try {
    const db = getServiceClient();

    const { data: draft, error } = await db
      .from('content_drafts')
      .select('id, status, campaign_payload')
      .eq('id', req.params.draftId)
      .eq('tenant_id', FGA_TENANT_ID)
      .eq('content_type', CONTENT_TYPE)
      .maybeSingle();
    if (error) throw error;
    if (!draft) return res.status(404).json({ success: false, error: 'Not found' });
    if (draft.status === 'posted') {
      return res.status(409).json({
        success: false,
        error: 'Cannot edit a draft that has already been published.',
      });
    }

    const { headline, body, hashtags, voiceover_full, video_prompt } = req.body || {};
    const patch = {};

    if (typeof headline === 'string') {
      patch.headline = headline.trim().slice(0, 200);
    }
    if (typeof body === 'string') {
      patch.body = body.trim().slice(0, 2000);
    }
    if (Array.isArray(hashtags)) {
      patch.hashtags = hashtags
        .map(h => String(h || '').replace(/^#+/, '').trim())
        .filter(Boolean)
        .slice(0, 12);
    }

    // Voiceover + video_prompt live inside campaign_payload.script.
    // Block edits to these once a render has been dispatched — once
    // Sora has the prompt, editing the stored copy is misleading
    // because the actual render is fixed.
    const wantsScriptEdit = typeof voiceover_full === 'string' || typeof video_prompt === 'string';
    if (wantsScriptEdit) {
      if (draft.status !== 'pending_review') {
        return res.status(409).json({
          success: false,
          error: `Voiceover and video prompt can only be edited while a draft is 'pending_review' (current status: ${draft.status}).`,
        });
      }
      const newPayload = { ...(draft.campaign_payload || {}) };
      const newScript = { ...(newPayload.script || {}) };
      if (typeof voiceover_full === 'string') {
        newScript.voiceover_full = voiceover_full.trim().slice(0, 1200);
      }
      if (typeof video_prompt === 'string') {
        newScript.video_prompt = video_prompt.trim().slice(0, 4000);
      }
      newPayload.script = newScript;
      patch.campaign_payload = newPayload;
    }

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ success: false, error: 'Nothing to update.' });
    }

    patch.updated_at = new Date().toISOString();

    const { data: updated, error: upErr } = await db
      .from('content_drafts')
      .update(patch)
      .eq('id', draft.id)
      .select()
      .single();
    if (upErr) throw upErr;

    log.info(`Edited draft ${draft.id}: ${Object.keys(patch).filter(k => k !== 'updated_at').join(', ')}`);
    res.json({ success: true, draft: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// DELETE /api/admin/marketing/videos/:draftId
//
// Permanently removes a draft. Also cleans up the Supabase Storage
// object if this was a Sora draft that finished staging. The OpenAI
// Sora video itself auto-expires on OpenAI's side after their TTL —
// no explicit delete call needed.
//
// Frees a quota slot (since the row is gone from content_drafts).
// ============================================================================
router.delete('/videos/:draftId', async (req, res) => {
  try {
    const db = getServiceClient();
    const { data: draft, error } = await db
      .from('content_drafts')
      .select('id, campaign_payload')
      .eq('id', req.params.draftId)
      .eq('tenant_id', FGA_TENANT_ID)
      .eq('content_type', CONTENT_TYPE)
      .maybeSingle();
    if (error) throw error;
    if (!draft) return res.status(404).json({ success: false, error: 'Not found' });

    // Best-effort: remove the Supabase Storage object for Sora drafts.
    // We don't fail the delete if storage cleanup errors — the draft
    // row is the source of truth, an orphan file just sits in storage
    // and can be GC'd later.
    const storagePath = draft.campaign_payload?.sora?.storage_path;
    if (storagePath) {
      const { error: stErr } = await db.storage
        .from('tenant-assets')
        .remove([storagePath]);
      if (stErr) {
        log.warn(`Storage cleanup failed for ${storagePath}: ${stErr.message}`);
      }
    }

    const { error: delErr } = await db
      .from('content_drafts')
      .delete()
      .eq('id', draft.id);
    if (delErr) throw delErr;

    log.info(`Deleted draft ${draft.id}`);

    // Return updated quota numbers so the frontend banner refreshes.
    const quota = await checkMarketingVideoQuota(db).catch(() => null);

    res.json({ success: true, deleted_id: draft.id, quota });
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

    // Resolve a publicly-fetchable video URL for Buffer.
    //
    // Sora drafts: campaign_payload.sora.public_video_url (Supabase
    //   Storage, no auth needed — Buffer can fetch directly).
    // Veo drafts: campaign_payload.veo.video_url (legacy — currently
    //   points at the Google Files API which requires a key Buffer
    //   doesn't have. This was broken pre-Sora; a separate pass needs
    //   to stage Veo output to Supabase the same way Sora does. For
    //   now we surface a clear error rather than failing silently.)
    let videoUrl = null;
    let publishabilityError = null;
    if (draft.campaign_payload?.sora?.public_video_url) {
      videoUrl = draft.campaign_payload.sora.public_video_url;
    } else if (draft.campaign_payload?.sora?.video_id) {
      publishabilityError = 'Sora render completed but not yet staged to public storage. Refresh and try again.';
    } else if (draft.campaign_payload?.veo?.video_url || draft.image_urls?.[0]) {
      publishabilityError = 'This is a legacy Veo draft. Publish-to-Buffer needs a public Supabase URL — Veo rendered URLs require an API key Buffer cannot use. Regenerate this draft on the Sora pipeline to publish.';
    }
    if (!videoUrl) {
      return res.status(409).json({
        success: false,
        error: publishabilityError || 'Video render not finished yet. Wait for status=completed before publishing.',
      });
    }

    // Default fan-out: both Instagram + Facebook (Facebook connected to
    // FGA's Buffer 2026-05-23). Caller can override with a specific list
    // in the request body if they want a single-channel publish.
    const platforms = Array.isArray(req.body?.platforms) && req.body.platforms.length
      ? req.body.platforms
      : ['instagram', 'facebook'];
    // Marketing caption: headline → body → tagline → hashtags. Tagline
    // is always the final brand line (per FGA brand rule). Avoid double-
    // appending if the AI-generated body already happened to include it.
    const bodyText = (draft.body || '').trim();
    const taglineLine = bodyText.endsWith(FGA_TAGLINE) ? null : FGA_TAGLINE;
    const text = [
      draft.headline,
      bodyText,
      taglineLine,
      (draft.hashtags || []).map(h => `#${h}`).join(' '),
    ].filter(Boolean).join('\n\n');

    // Buffer's createPost requires a poster thumbnail for video posts.
    // Lazy-generate one if the draft doesn't have it yet. Tracked in
    // local vars (NOT a separate DB write) so the final update at the
    // bottom of this handler can include the thumbnail fields in the
    // same campaign_payload merge as the publish_result. Doing two
    // separate updates was the prior bug — the second write used the
    // stale in-memory copy and overwrote the freshly-saved thumbnail.
    let thumbnailUrl = draft.campaign_payload?.sora?.thumbnail_url || null;
    let thumbnailPath = draft.campaign_payload?.sora?.thumbnail_path || null;
    const thumbnailWasGenerated = !thumbnailUrl;
    if (!thumbnailUrl) {
      try {
        const thumb = await generateAndUploadThumbnail(db, draft.id, videoUrl);
        thumbnailUrl = thumb.public_url;
        thumbnailPath = thumb.storage_path;
        log.info(`Generated thumbnail for ${draft.id}: ${thumbnailUrl}`);
      } catch (e) {
        log.error(`Thumbnail generation failed for ${draft.id}: ${e.message}`);
        return res.status(500).json({
          success: false,
          error: `Could not generate video thumbnail required by Buffer: ${e.message}`,
        });
      }
    }

    const published = [];
    const failures = [];
    for (const platform of platforms) {
      try {
        const r = await publishToFgaBuffer(
          {
            platform,
            text,
            mediaUrls: [videoUrl],
            mediaKind: 'video',
            thumbnailUrl,
          },
          { scheduledAt: req.body?.scheduled_at || null, addToQueue: !req.body?.scheduled_at },
        );
        published.push({ platform, post_id: r.id, status: r.status });
      } catch (e) {
        failures.push({ platform, error: e.message });
      }
    }

    // Move draft to 'approved' (then 'posted' if Buffer accepted any post).
    // Single atomic write merges:
    //   - the original campaign_payload from when this request started
    //   - any thumbnail fields freshly generated above
    //   - the publish_result
    // so neither path overwrites the other.
    const allOk = failures.length === 0;
    const next = allOk ? 'posted' : (published.length ? 'approved' : draft.status);
    const mergedSora = {
      ...(draft.campaign_payload?.sora || {}),
      ...(thumbnailWasGenerated ? { thumbnail_url: thumbnailUrl, thumbnail_path: thumbnailPath } : {}),
    };
    await db.from('content_drafts').update({
      status: next,
      approved_by: req.user?.id || null,
      posted_at: published.length ? new Date().toISOString() : null,
      campaign_payload: {
        ...draft.campaign_payload,
        sora: mergedSora,
        publish_result: { published, failures, requested_at: new Date().toISOString() },
      },
    }).eq('id', draft.id);

    res.json({ success: failures.length === 0, published, failures });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// Prompt templates — moved out of the route handler for readability.
// SORA_SYSTEM_PROMPT is the active path; VEO_SYSTEM_PROMPT_LEGACY is the
// rollback path when VIDEO_PROVIDER=veo.
// ============================================================================

const SORA_SYSTEM_PROMPT = `You write 12-second cinematic promotional videos for First Gen Automate (FGA), a done-for-you business operating system installed for small businesses with 1-5 employees.

══════════════════════════════════════════════════════════════
ABSOLUTE RULE #1 — NO TIGHT CLOSE-UPS OF HUMAN FACES
══════════════════════════════════════════════════════════════
The issue is FRAMING DISTANCE, not face presence. Faces ARE allowed
and ENCOURAGED — humans connect with humans. What breaks is when an
AI-rendered face FILLS the frame: tight eyes, lip-level close-up,
extreme close-up smile. Those drop into the uncanny valley.

✓ ALLOWED — faces in these framings are fine and look great:
    - WIDE shots (full body or fuller, face is small in frame)
    - MEDIUM shots (waist-up, face occupies ~1/6 of frame)
    - MEDIUM CLOSE-UPS (chest-up, conversational distance, face ~1/4 of frame)
    - 3/4 angles where the face is partly turned
    - Background figures in soft focus, face visible but not the subject
    - Two-shots with operator + customer / operator + dog, etc.

✗ FORBIDDEN — these specific framings look uncanny on AI renders:
    "extreme close-up of [her/his] face"
    "close-up of [her/his] face" (use 'medium close-up' instead)
    "tight on the eyes" / "extreme close-up of the eyes"
    "macro lens on [her/his] mouth/lips/smile"
    Any direction where the face fills more than ~1/3 of the frame.

✓ DEFAULT TO MEDIUM AND WIDE SHOTS. The operator's face being
  visible at conversational distance is fine — it humanizes the brand.
  Just don't write "close-up" or "extreme close-up" of a face.

✓ ENDING BEATS (the last 1s of a scene): when you want a punctuation
  shot at the end of a scene, you have lots of options:
    - The operator's HANDS at work (close-up of hands is FINE)
    - A TELLING OBJECT — phone face-down, dark screen, water droplet
    - The operator in MEDIUM shot looking off-camera at the work
    - Wide shot pulling back to reveal the workspace
    - The CUSTOMER / PRODUCT / FINISHED RESULT
  These are stronger than face close-ups anyway — they tell a story.

This rule applies to EVERY scene of EVERY render. Use medium and
wider framings on people; reserve true close-ups for hands, tools,
objects, and the work itself.

══════════════════════════════════════════════════════════════

Every video follows the EXACT same 3-scene structure across a SINGLE 12-second Sora 2 Pro render. You NEVER deviate from this framework — only the dynamic content inside each scene changes per module / niche.

NOTE ON THE 3-SCENE DESIGN (2026-05-26 rework):
  The earlier framework was 4 scenes × ~6s designed for a 25-second
  Veo clip. When the platform moved to Sora 2 Pro (capped at 12s on
  this account), 4 scenes got crammed into 3 seconds each — too fast
  for Sora to render distinct shots, and too tight on voiceover. This
  3-scene × 4s framework gives Sora room to actually deliver each shot
  AND fits a natural 30-word voiceover across 12 seconds.

CRITICAL — VOICEOVER LENGTH BUDGET
==============================================================
Total voiceover MUST be ≤ 36 words across the entire 12 seconds.
That's ~180 wpm — confident narration pace with a small safety margin
under Sora's tested 200 wpm ceiling. Anything longer risks overrunning
the 12s clip and getting cut off mid-sentence, wasting Sora credits.
There is NO retry inside Sora — the cap is real.

Per-scene budget (HARD ceilings — after substitution, count words):
  Scene 1: ≤ 14 words AFTER \${target_niche} substitution
  Scene 2: ≤ 15 words AFTER [PAIN POINT] + \${selected_module} substitution
  Scene 3: 7 words FIXED (the FGA tagline, no substitution)

After you write the lines, count the words yourself. Output the
count in the JSON's \`voiceover_word_count\` field. If your count
is > 36, REWRITE before returning JSON.

==============================================================
THE 12-SECOND 3-SCENE FRAMEWORK
==============================================================

  SCENE 1 — 0:00 to 0:04 — STAT HOOK
    Visual: A high-action, visually unmistakable shot of an owner-operator in the \${target_niche} actively doing their core trade. The niche must be visually identifiable in the first half second — not generic small-biz B-roll. Use MEDIUM or WIDE shots of the operator — the operator's face is fine at conversational distance, just don't write "close-up" of the face. End the 4-second beat on a close-up of a TELLING OBJECT or HANDS that telegraphs the operator is busy / unaware of the lost opportunity: phone face-down on a counter, screen dark; customer's feet walking away through the door; a "We're Open" sign while a missed call rings in the background.
    Voiceover (≤14 words, niche-AGNOSTIC — addresses every small-business owner):
      Format:     "Just started your business? [STAT]% of customers [behavior] before they book."
      Variation:  "Running a business? [STAT]% of customers [behavior] before they book."

    CRITICAL — DO NOT name the niche in the voiceover.
    The VISUAL shows the niche (dog groomer, plumber, trainer, etc.).
    The AUDIO speaks to every small-business owner so the same message
    lands no matter which niche is on screen. This was a deliberate
    decision 2026-05-26 — marketing is to ALL small businesses, the
    niche-specific visual is what hooks each viewer.

    Use "Just started your business?" by default; switch to "Running a
    business?" only if the visual makes clear the operator is established
    (busy crew, polished workshop, etc.).

    PICK [STAT] AND [behavior] FROM THE MODULE→STAT TABLE BELOW. Never invent numbers.

    MODULE → STAT + BEHAVIOR REFERENCE (use the row that matches \${selected_module}):
      - Website / Done-For-You Website     →  STAT: 76,  behavior: "check your site"
      - AI Voice Receptionist              →  STAT: 62,  behavior: "won't leave a voicemail"
      - Missed Call Text-Back              →  STAT: 62,  behavior: "won't call back if you miss them"
      - AI Chat Agent                      →  STAT: 44,  behavior: "leave without an instant reply"
      - Speed-to-Lead                      →  STAT: 78,  behavior: "buy from whoever answers first"
      - Lead Capture & CRM                 →  STAT: 40,  behavior: "ghost when their info is mishandled"
      - Follow-Up Sequences                →  STAT: 80,  behavior: "need five touches before they buy"
      - Review Requests                    →  STAT: 93,  behavior: "read reviews before they book"
      - Referral Engine                    →  STAT: 92,  behavior: "trust a referral over an ad"
      - Referral Partner Outreach          →  STAT: 65,  behavior: "of work comes from referrals you don't have"
      - Branded Mobile App                 →  STAT: 88,  behavior: "stay loyal to brands with an app"
      - Content Engine                     →  STAT: 70,  behavior: "research you on social first"
      - Content Approval & Scheduling      →  STAT: 70,  behavior: "research you on social first"
      - Prospecting Engine                 →  STAT: 50,  behavior: "of leads die before you call"
      - Lead Scoring                       →  STAT: 50,  behavior: "of your time goes to leads that never close"
      - AI Voice Receptionist (Scale)      →  STAT: 62,  behavior: "won't leave a voicemail"

  SCENE 2 — 0:04 to 0:08 — FGA LIFT (PUNCHY SOLUTION)
    Visual: Two-beat cut.
      Beat A (0:04-0:06): The SPECIFIC operational pain point \${selected_module} is built to eliminate. Deduce the correct bottleneck from the module name. Reference anchors:
        - AI Voice Receptionist      → phone ringing on a busy job site, owner's hands full, missed-call screen
        - AI Chat Agent              → website chat widget unanswered, customer bouncing to a competitor's tab
        - Website / Done-For-You Website → DIY page loading slow next to a competitor's site
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
      Beat B (0:06-0:08): Quick cut to the FGA mobile interface showing \${selected_module} running on autopilot — clean dark UI, the operator's phone lighting up with a clear text-brief notification proving the task was handled. End on the operator's HANDS picking up the phone, OR a MEDIUM shot of the operator looking down at the screen with a small confident smile (medium framing, NOT a tight close-up of the face).
    Voiceover (≤15 words AFTER substitutions — short, declarative, no marketing fluff):
      Format:     "[PROBLEM STATE]. First Gen Automate [solves it in 2-3 words]."
      Module-specific examples (these are TARGETS — match this terse rhythm; brand name must be spoken in full):
        - Website / Done-For-You Website   → "No site? You're invisible. First Gen Automate builds yours."
        - AI Voice Receptionist            → "Miss the call, lose the job. First Gen Automate answers it."
        - Missed Call Text-Back            → "Missed call? First Gen Automate texts back instantly."
        - AI Chat Agent                    → "No reply, they bounce. First Gen Automate chats 24/7."
        - Speed-to-Lead                    → "First reply wins. First Gen Automate replies in seconds."
        - Lead Capture & CRM               → "Lost leads cost cash. First Gen Automate captures every one."
        - Follow-Up Sequences               → "Forget to follow up? First Gen Automate never does."
        - Review Requests                   → "Reviews drive bookings. First Gen Automate asks for you."
        - Referral Engine                   → "Referrals fade fast. First Gen Automate chases them down."
        - Branded Mobile App                → "Apps build loyalty. First Gen Automate ships yours."
        - Content Engine                    → "Empty feed? First Gen Automate posts for you."
        - Prospecting Engine                → "Cold leads pile up. First Gen Automate prospects nightly."
        - Lead Scoring                      → "Chasing wrong leads burns hours. First Gen Automate scores them."
      NEVER use these phrases: "let us help", "we'll handle", "trust us", "powerful", "seamless".
      No fluff. Two sentences max. Period after each.

  SCENE 3 — 0:08 to 0:12 — PAYOFF + TAGLINE
    Visual: Tight cinematic tracking shot of the FINAL outcome for THIS niche — a finished, satisfied result that visually screams \${target_niche} (e.g., plumber: gleaming new install; personal trainer: thriving studio; Etsy seller: stack of boxed orders; auto detailer: showroom-shine finish). Hold this niche-outcome shot for the FULL four seconds — do NOT add any "FGA" text, watermarks, logos, or wordmarks of any kind. The real FGA brand end card is composited in post-production by our server-side ffmpeg pass over the last 1.5 seconds. Leave the visual canvas clean.
    Voiceover (verbatim, EXACTLY 7 words, NEVER deviate, NEVER add filler, NEVER change punctuation):
      "Automate the Overhead, Focus on the Work."

==============================================================
SORA VOICEOVER DIRECTION (CRITICAL)
==============================================================
This 12-second clip is rendered by OpenAI Sora 2 Pro with native spoken audio. The video_prompt MUST instruct Sora to speak the voiceover lines aloud using a SPECIFIC voice profile:

  Voice: confident, grounded, professional male voice
  Tone:  helpful business partner explaining something the listener
         already half-knows — NOT a high-pressure salesman, NOT corporate
         narrator, NOT energetic infomercial pitchman
  Pace:  natural narration speed, ~160 wpm, with small breath pauses
         between sentences. Trust the silence.
  Energy: calm authority. The kind of voice that makes you nod along
         rather than reach for the mute button.

Use phrasing like: "Voiceover (confident grounded male voice, trusted-advisor tone, paced naturally with small pauses): '...'" at the start of each scene's visual description inside video_prompt.

==============================================================
OUTPUT FORMAT — JSON ONLY, NO MARKDOWN FENCES, NO PREAMBLE
==============================================================
{
  "hook": "3-5 word scroll-stopper for the social caption (NOT a voiceover line)",
  "caption": "15-25 word post body. Conversational. One specific CTA. Niche-flavored.",
  "hashtags": ["niche", "automation", "etc"],
  "scenes": [
    { "id": 1, "start": "0:00", "end": "0:04", "clip": "single", "visual": "1-sentence shot description: niche-specific work (operator from behind / hands / wide) + a TELLING OBJECT close-up at the end (NEVER a face)", "voiceover": "the Scene 1 voiceover — niche-AGNOSTIC, addresses every small-business owner (≤14 words)" },
    { "id": 2, "start": "0:04", "end": "0:08", "clip": "single", "visual": "1-sentence shot describing both beats: bottleneck for THIS module then FGA UI relief beat", "voiceover": "the Scene 2 voiceover with [PAIN] and \${selected_module} filled in (≤15 words)" },
    { "id": 3, "start": "0:08", "end": "0:12", "clip": "single", "visual": "1-sentence shot of the niche-specific payoff (NO logos/wordmarks — branding added in post)", "voiceover": "the verbatim FGA tagline (7 words, no substitutions)" }
  ],
  "voiceover_full": "the full 4-scene voiceover script as ONE continuous string, with all dynamic insertions filled in. Used for caption / overlay reference. MUST be the concatenation of the 4 scene voiceovers (substitutions applied) separated by single spaces — nothing more, nothing less.",
  "voiceover_word_count": <integer — count the words in voiceover_full after substitutions. MUST be ≤ 36. If your count exceeds 36, REWRITE shorter before returning JSON.>,
  "video_prompt": "ONE dense paragraph (160-220 words) that Sora 2 Pro will turn into the 12-second clip. MUST encode the 3-scene structure with explicit timed cuts AND embedded voiceover directives. Format: 'SCENE 1 (0-4s): [visual]. Voiceover (confident grounded male voice, trusted-advisor tone, paced naturally): \"...\" CUT TO. SCENE 2 (4-8s): [visual — two beats, the bottleneck then the FGA UI relief]. Voiceover: \"...\" CUT TO. SCENE 3 (8-12s): [visual — niche-specific payoff, NO logos]. Voiceover: \"...\"' Specify camera moves (handheld push-in, overhead, dolly, tracking shot), lighting (golden hour, fluorescent shop, soft window, neon glow), and the EXACT visible moment in Scene 2 Beat B when the FGA module fires on the phone. Vertical 9:16, cinematic color grading."
}

==============================================================
RULES
==============================================================
- NEVER SHOW HUMAN FACES IN CLOSE-UP. AI-generated faces in close-up
    (especially the eyes) drop straight into the uncanny valley — they
    look "off" in a way that hurts the brand even when everything else
    in the shot is great. Hard rules:
      ✓ Show operators from BEHIND, in PROFILE at a distance, or as
        SILHOUETTES against a light source.
      ✓ Focus on HANDS at work, tools in motion, the workspace, the
        product, the finished result.
      ✓ Wide and medium shots where the face is small in the frame and
        not the visual subject are fine.
      ✗ NEVER write "close-up of [her/his/their] face", "her smiling face",
        "his confident expression", "tight on the eyes", or anything that
        directs Sora's camera at a face from <6 feet away.
      ✗ NEVER describe a person looking directly at camera at close range.
    This rule applies to EVERY scene — Scenes 1, 2, AND 3.
- BRAND NAME — VOICEOVER MUST SAY "First Gen Automate" IN FULL.
    Never use "FGA" in any spoken voiceover line — it sounds like a stock ticker, not a brand.
    In the visual / scene descriptions inside video_prompt you may use "FGA" as shorthand for brevity,
    but every QUOTED voiceover line inside the video_prompt must say "First Gen Automate" out loud.
    The same rule applies to the voiceover_full field.
    Acceptable spoken forms: "First Gen Automate", "First Gen Automate builds your site",
    "First Gen Automate handles it for you". Never spoken: "FGA", "F-G-A".
- Tight to the niche. A plumber's clip ≠ a personal trainer's ≠ an Etsy seller's. \${target_niche} must be visually unmistakable in EVERY scene.
- Operator is solo or 1-5 person crew. NEVER call centers, corporate offices, or big teams.
- Scene 2's bottleneck must visually map to \${selected_module}'s job — don't show "stressed at desk" if the module is Review Requests or Referral Engine.
- The voiceover lines are FIXED — do NOT improvise alternates or "punch them up." The total word count is tuned to 12 seconds at natural pace; ad-libbing will overrun.
- The video_prompt is the SINGLE most important field — Sora reads ONLY this. The scenes array is for the admin UI.
- The voiceover directives inside video_prompt are what causes Sora to speak. Sora won't speak unless explicitly told to.
- ABSOLUTELY NO LOGOS OR WORDMARKS IN THE RENDER. Do not instruct Sora to generate "FGA wordmark", "FGA logo", "First Gen Automate logo", brand text overlays, watermarks, or any other typographic branding. Our server-side ffmpeg pass composites the real FGA brand end-card over the last 1.5 seconds AFTER Sora finishes. The Sora-rendered final 3 seconds (Scene 4) must be a clean cinematic shot with NO brand text of any kind — otherwise the post overlay collides with whatever fake mark Sora invented and the result is unprofessional.
- Output ONLY the JSON object. No markdown fences. No commentary before or after.`;

const VEO_SYSTEM_PROMPT_LEGACY = `You write 16-second cinematic promotional videos for First Gen Automate (FGA), a done-for-you business operating system installed for small businesses with 1-5 employees.

Every video you write follows the EXACT same 4-scene structure across TWO 8-second Veo renders. You NEVER deviate from this framework — only the dynamic content inside each scene changes per module / niche.

==============================================================
THE 16-SECOND FRAMEWORK (4 scenes × 4 seconds, across 2 Veo clips)
==============================================================

  BASE CLIP (0-8s) — FOCUS + FRICTION
  ────────────────────────────────────
  SCENE 1 — 0:00 to 0:04 — THE FOCUS
    Visual: A high-action, visually unmistakable shot of an owner-operator in the \${target_niche} actively doing their core trade.

  SCENE 2 — 0:04 to 0:08 — THE BOTTLENECK
    Visual: The SPECIFIC operational pain point that \${selected_module} is built to eliminate. Reference module→bottleneck mapping in the project canon.

  Voiceover skeleton (0-8s — used for caption / overlay text only; Veo does NOT speak):
    "When you're busy running your \${target_niche} business, you can't waste time fighting manual [SPECIFIC PAIN POINT]."

  EXTENSION CLIP (8-16s) — LIFT + PAYOFF
  ───────────────────────────────────────
  SCENE 3 — 0:08 to 0:12 — THE FGA AUTOMATION LIFT
    Visual: Close-up of the FGA mobile interface running \${selected_module} on autopilot; the operator's phone receives a text-brief notification.

  SCENE 4 — 0:12 to 0:16 — THE PAYOFF + CTA
    Visual: Cinematic tracking shot of the FINAL outcome for THIS niche + FGA wordmark overlay.

  Voiceover skeleton (8-16s — last sentence MUST be the FGA tagline verbatim):
    "That's why First Gen Automate runs your \${selected_module} on autopilot. Automate the Overhead, Focus on the Work."

==============================================================
OUTPUT FORMAT — JSON ONLY
==============================================================
{
  "hook": "3-5 word scroll-stopper",
  "caption": "15-25 word post body. One CTA.",
  "hashtags": ["niche", "automation"],
  "scenes": [
    { "id": 1, "start": "0:00", "end": "0:04", "clip": "base",      "visual": "...", "voiceover": "" },
    { "id": 2, "start": "0:04", "end": "0:08", "clip": "base",      "visual": "...", "voiceover": "" },
    { "id": 3, "start": "0:08", "end": "0:12", "clip": "extension", "visual": "...", "voiceover": "" },
    { "id": 4, "start": "0:12", "end": "0:16", "clip": "extension", "visual": "...", "voiceover": "" }
  ],
  "voiceover_base":      "verbatim 0-8s voiceover with pain point filled in",
  "voiceover_extension": "verbatim 8-16s voiceover with \${selected_module} filled in",
  "base_video_prompt":      "140-200 word cinematic prompt for the FIRST 8s clip (scenes 1-2). 'SCENE 1 (0-4s): [...]. CUT TO. SCENE 2 (4-8s): [...].' NO spoken dialogue.",
  "extension_video_prompt": "140-200 word cinematic prompt for the SECOND 8s clip (scenes 3-4). Must begin with continuity anchor: 'Continuing seamlessly from the previous shot of the [SAME operator/setting], ...' Times are RELATIVE to this clip. NO spoken dialogue."
}

==============================================================
RULES
==============================================================
- Tight to the niche; operator is 1-5 person crew.
- Output ONLY JSON, no fences.`;

/**
 * Builds the user message for either provider's system prompt.
 */
function buildUserMessage({ provider, module, niche, category, trimmedConcept }) {
  const baseFields = `selected_module:  ${module.name}   (key: ${module.key})
target_niche:     ${niche}
niche_category:   ${category.categoryName}
operator_size:    Owner of a 1-5 person ${niche.toLowerCase()} business

Owner-provided concept / specific scenario angle:
"${trimmedConcept}"`;

  if (provider === 'sora') {
    return `${baseFields}

Write the 4-act 25-second script + single Sora 2 Pro cinematic prompt with EMBEDDED VOICEOVER DIRECTIVES for THIS exact module / niche / concept combo. Adhere strictly to the framework — only the visual descriptions and the Act 2 pain-point bracket change. The Sora prompt MUST tell the model to speak the voiceover lines aloud. Output the JSON now.`;
  }

  // Veo legacy
  return `${baseFields}

Write the 4-scene 16-second script + TWO Veo cinematic prompts (base + extension) for THIS exact module / niche / concept combo. Adhere strictly to the framework — only the visual descriptions and the Scene 2 pain-point bracket change. Output the JSON now.`;
}

// ============================================================================
// 2026-06-09 — AUTO CONCEPT (AI-assisted campaign generation)
//
// Lets the FGA owner pick just a module and receive a complete promo
// concept package without manually writing the scenario. Runs IN
// PARALLEL to the existing Guided Creation flow — same quota gate, same
// content_drafts table, same render dispatch, same publish path.
//
// What's different from /generate-video:
//   - Owner does NOT supply concept text or niche
//   - System auto-selects niche (anti-recent-rotation against last 8
//     marketing video drafts to avoid repetition)
//   - Claude is asked for the full concept PACKAGE — audience, pain
//     point, marketing angle, scenario, hook, plus the existing
//     hook/caption/scenes/voiceover/video_prompt
//   - Persisted with creation_mode='auto_concept' so Recent Promos can
//     show which path produced each draft.
// ============================================================================

// Module marketing profiles — drive niche selection and concept prompting.
// Built from FGA documentation (CLAUDE.md, business runbooks, module
// descriptions). Each profile gives Claude concrete, niche-specific raw
// material to ground the generated scenario in.
const MODULE_PROFILES = {
  voice_receptionist: {
    purpose: 'Answer calls, capture lead info, prevent missed opportunities, route by intent.',
    pains: ['Missed calls while on a job', 'Owner driving between jobs', 'No dedicated receptionist', 'After-hours leads vanish', 'Slow response loses the booking'],
    scenarios: ['Owner is on a roof / under a sink / in the back of a service truck when phone rings', 'Two leads call within a minute of each other', 'Saturday-morning emergency request'],
    bestNiches: ['Tree Services', 'HVAC', 'Roofing', 'Plumbing', 'Cleaning Services', 'Landscaping', 'Auto Repair', 'General Contractors'],
    ctas: ['Never miss the next opportunity', 'Capture every lead', 'Keep working while FGA answers'],
    avoid: ['Guaranteed leads', 'Guaranteed revenue', 'Guaranteed close rates'],
    tone: 'Direct, working-class, no-nonsense',
  },
  chat_agent: {
    purpose: '24/7 site chat that answers prospect questions and captures leads without owner attention.',
    pains: ['Website visitors leave without contact info', 'Common questions repeat 50x', 'Owner can\'t monitor chat live'],
    scenarios: ['Visitor lands on services page late at night', 'Same FAQ asked all week', 'Chat captures contact before bounce'],
    bestNiches: ['Real Estate', 'Insurance', 'Med Spa', 'Dental', 'Financial Planning', 'Business Coaching'],
    ctas: ['Turn site visits into bookings', 'Answer in seconds, even at midnight'],
    avoid: ['Guaranteed conversions', 'Replace your sales team'],
    tone: 'Professional, modern, premium',
  },
  website: {
    purpose: 'Done-for-you branded website. Owner uploads photos, FGA builds and updates.',
    pains: ['Old GoDaddy site looks like 2010', 'No site at all, just a Facebook page', 'Owner doesn\'t have time to update'],
    scenarios: ['Customer Googles business, finds nothing', 'Competitor has a polished site', 'Wedding-style "before/after" of a website rebuild'],
    bestNiches: ['Tree Services', 'HVAC', 'Plumbing', 'Cleaning Services', 'Auto Repair', 'Landscaping', 'Pressure Washing'],
    ctas: ['Get a website without the headache', 'Look like the real deal'],
    avoid: ['Guaranteed traffic', 'Guaranteed SEO rankings'],
    tone: 'Confident, premium, grounded',
  },
  lead_capture: {
    purpose: 'Central CRM that organizes leads from web, calls, texts, and forms.',
    pains: ['Leads scattered across Gmail / sticky notes / phone screenshots', 'Forgot to follow up', 'Can\'t tell who came from where'],
    scenarios: ['Owner scrolling phone trying to find a lead from last week', 'Multiple leads from same week, no one called back'],
    bestNiches: ['Roofing', 'Real Estate', 'Insurance', 'HVAC', 'General Contractors'],
    ctas: ['Every lead in one place', 'Nothing slips through'],
    avoid: ['Guaranteed conversions'],
    tone: 'Direct, organized, calming',
  },
  speed_to_lead: {
    purpose: 'Instant SMS response when a new lead hits the system.',
    pains: ['Lead chose competitor who answered first', 'Owner saw form fill 4 hours later', '78% of buyers go with whoever answers first'],
    scenarios: ['Form fill while owner is mid-job, SMS goes out automatically', 'Lead replies and books before owner is back to the truck'],
    bestNiches: ['Roofing', 'HVAC', 'Plumbing', 'Tree Services', 'Auto Repair', 'Real Estate'],
    ctas: ['Beat your competitors to the lead', 'Respond in seconds, not hours'],
    avoid: ['Guaranteed bookings', 'Guaranteed first-place finish'],
    tone: 'Urgent, direct',
  },
  missed_call_textback: {
    purpose: 'When the owner can\'t answer, system texts the caller automatically.',
    pains: ['Missed call = missed job', 'No voicemail = caller moves on', 'Owner can\'t text back fast enough'],
    scenarios: ['Owner on ladder, phone rings, can\'t answer, text fires from system', 'Caller responds to text and books'],
    bestNiches: ['Tree Services', 'HVAC', 'Plumbing', 'Roofing', 'Cleaning Services', 'Auto Repair', 'Pest Control'],
    ctas: ['Turn missed calls into booked jobs', 'Get back to every caller'],
    avoid: ['Guaranteed leads'],
    tone: 'Direct, no-nonsense',
  },
  follow_up_sequences: {
    purpose: 'Automated follow-up for estimates, leads, past customers.',
    pains: ['Forgot to follow up on the estimate', 'Past customer never contacted again', 'Manual follow-up takes hours'],
    scenarios: ['Estimate sent Monday, system follows up Friday', 'Annual maintenance reminder to past customer'],
    bestNiches: ['HVAC', 'Plumbing', 'Roofing', 'Pest Control', 'Cleaning Services', 'Auto Repair'],
    ctas: ['Stop letting estimates die', 'Reactivate past customers'],
    avoid: ['Guaranteed close rates'],
    tone: 'Practical, helpful',
  },
  content_engine: {
    purpose: 'AI generates social posts from real job photos owner uploads.',
    pains: ['No time to post', 'Camera roll has 200 job photos doing nothing', 'Inconsistent posting kills the algorithm'],
    scenarios: ['Owner finishes a job, snaps 3 photos, system writes the caption and schedules the post', 'Before/after pulled from yesterday\'s job'],
    bestNiches: ['Tree Services', 'Landscaping', 'Cleaning Services', 'Pressure Washing', 'Auto Detailing', 'Roofing'],
    ctas: ['Turn job photos into marketing', 'Post consistently without thinking'],
    avoid: ['Guaranteed followers', 'Guaranteed engagement'],
    tone: 'Conversational, encouraging',
  },
  content_approval: {
    purpose: 'Owner approves AI-drafted posts from phone, system schedules to Buffer.',
    pains: ['Approval friction', 'Brand voice drift', 'No time for studio sessions'],
    scenarios: ['Owner on lunch break swiping through 5 drafts, approving 4', 'One-tap rejection sends draft back for revision'],
    bestNiches: ['Real Estate', 'Med Spa', 'Dental', 'Personal Training', 'Boutique Retail'],
    ctas: ['Approve content in 30 seconds', 'Stay in control without the work'],
    avoid: ['Guaranteed virality'],
    tone: 'Calm, premium',
  },
  review_requests: {
    purpose: 'Automatically asks happy customers for a 5-star review after job completion.',
    pains: ['Forgot to ask', 'Awkward to ask in person', 'Google reviews trickle in'],
    scenarios: ['Job completes, system texts customer 24h later asking for review', 'Review goes live the next day'],
    bestNiches: ['HVAC', 'Plumbing', 'Roofing', 'Auto Repair', 'Cleaning Services', 'Med Spa', 'Dental'],
    ctas: ['Build your reputation on autopilot', 'Get the 5-star reviews you earn'],
    avoid: ['Guaranteed 5-star rating', 'Guaranteed review volume'],
    tone: 'Confident, warm',
  },
  branded_app: {
    purpose: 'Owner gets a real branded iOS/Android app with their business name and logo.',
    pains: ['Owner thinks apps cost $50k', 'Competitors don\'t have one — differentiator'],
    scenarios: ['Owner showing a customer "yeah, that\'s my app on the App Store"', 'Crew using the app on a job site'],
    bestNiches: ['Tree Services', 'HVAC', 'Plumbing', 'Cleaning Services', 'Real Estate', 'Med Spa'],
    ctas: ['Your business gets its own app', 'Look like the real deal'],
    avoid: ['Guaranteed downloads'],
    tone: 'Confident, premium, slight pride',
  },
  referral_engine: {
    purpose: 'Turns happy customers into referral sources.',
    pains: ['Best customers never refer', 'No formal referral process', 'Word of mouth not measured'],
    scenarios: ['Past customer gets a referral ask after a great review', 'Tracking which customers send the most leads'],
    bestNiches: ['Real Estate', 'Insurance', 'Med Spa', 'Personal Training', 'Financial Planning'],
    ctas: ['Turn customers into a referral team', 'Stop leaving referrals on the table'],
    avoid: ['Guaranteed referrals'],
    tone: 'Warm, professional',
  },
  referral_outreach: {
    purpose: 'Keep referral partners (realtors, contractors) engaged automatically.',
    pains: ['Partner relationships go cold', 'No consistent touchpoint'],
    scenarios: ['Realtor partner gets monthly tip from system', 'Insurance broker stays top of mind'],
    bestNiches: ['Real Estate', 'Insurance', 'Financial Planning', 'Roofing'],
    ctas: ['Keep partners warm without lifting a finger'],
    avoid: ['Guaranteed partnerships'],
    tone: 'Professional, networking-oriented',
  },
  prospecting_engine: {
    purpose: 'Automatically finds and reaches out to new prospects in the owner\'s area.',
    pains: ['Owner doesn\'t have time to cold-prospect', 'No idea who to reach out to'],
    scenarios: ['Owner sleeping while system messages 15 new prospects', 'Morning text: 3 replies waiting'],
    bestNiches: ['Real Estate', 'Insurance', 'B2B services', 'Roofing (storm areas)'],
    ctas: ['Prospects in your pipeline by morning', 'Cold outreach on autopilot'],
    avoid: ['Guaranteed appointments', 'Guaranteed close'],
    tone: 'Tactical, calm',
  },
  lead_scoring: {
    purpose: 'Automatically ranks leads so owner knows who to call back first.',
    pains: ['Calling cold leads while hot leads sit', 'No way to prioritize'],
    scenarios: ['Owner pulls up dashboard, top 3 leads are flagged hot', 'System learns from past closes'],
    bestNiches: ['Real Estate', 'Insurance', 'Roofing', 'HVAC', 'B2B services'],
    ctas: ['Call the right lead first', 'Stop wasting time on cold leads'],
    avoid: ['Guaranteed accuracy'],
    tone: 'Practical, sharp',
  },
};

function moduleProfile(key) {
  return MODULE_PROFILES[key] || {
    purpose: 'FGA automation module',
    pains: ['Manual work eating up the day'],
    scenarios: ['Owner finishes a job, opens the app, FGA has handled the followups'],
    bestNiches: ['Tree Services', 'HVAC', 'Plumbing'],
    ctas: ['Run on autopilot'],
    avoid: ['Guaranteed outcomes'],
    tone: 'Direct',
  };
}

// Pick a niche that isn't repeating recent campaigns for this module.
async function pickAutoNiche(db, moduleKey, requestedNiche) {
  if (requestedNiche && String(requestedNiche).trim()) return String(requestedNiche).trim();
  const profile = moduleProfile(moduleKey);
  const candidates = profile.bestNiches.length ? profile.bestNiches.slice() : ['Tree Services', 'HVAC', 'Plumbing'];
  // Anti-repeat: pull last 8 promos for THIS module and remove their niches
  // from the candidate pool. If that empties the list, fall back to the full
  // candidate list (better to repeat than to fail).
  try {
    const { data: recent } = await db
      .from('content_drafts')
      .select('campaign_payload, created_at')
      .eq('tenant_id', FGA_TENANT_ID)
      .eq('content_type', CONTENT_TYPE)
      .order('created_at', { ascending: false })
      .limit(8);
    const usedNiches = new Set();
    for (const d of recent || []) {
      const cp = d.campaign_payload || {};
      if (cp?.module?.key === moduleKey && cp?.niche?.niche) {
        usedNiches.add(String(cp.niche.niche).toLowerCase());
      }
    }
    const fresh = candidates.filter((n) => !usedNiches.has(n.toLowerCase()));
    const pool = fresh.length ? fresh : candidates;
    return pool[Math.floor(Math.random() * pool.length)];
  } catch (_) {
    return candidates[Math.floor(Math.random() * candidates.length)];
  }
}

function buildAutoConceptUserMessage({ module, niche, category, profile, tone, contentGoal, platform, specialInstruction }) {
  const baseFields = `selected_module:  ${module.name}   (key: ${module.key})
target_niche:     ${niche}
niche_category:   ${category.categoryName}
operator_size:    Owner of a 1-5 person ${niche.toLowerCase()} business`;

  const pains = (profile.pains || []).slice(0, 4).map((p) => `  - ${p}`).join('\n');
  const scenarios = (profile.scenarios || []).slice(0, 3).map((s) => `  - ${s}`).join('\n');
  const ctas = (profile.ctas || []).slice(0, 3).map((c) => `  - "${c}"`).join('\n');
  const avoid = (profile.avoid || []).map((a) => `  - ${a}`).join('\n');
  const opts = [];
  if (tone) opts.push(`Tone preference: ${tone}`);
  if (contentGoal) opts.push(`Content goal: ${contentGoal}`);
  if (platform) opts.push(`Platform: ${platform}`);
  if (specialInstruction) opts.push(`Special instruction (preserve verbatim throughout regen): ${specialInstruction}`);

  return `${baseFields}

MODULE INTELLIGENCE — use this as grounding material, do NOT echo it back literally:
  Core purpose: ${profile.purpose}
  Common pain points:
${pains}
  Believable scenarios:
${scenarios}
  Suitable CTAs:
${ctas}
  Claims to AVOID (these are dishonest — never make them):
${avoid}
  Default tone: ${profile.tone}

${opts.length ? opts.join('\n') + '\n' : ''}
This is AUTO CONCEPT mode — the owner did NOT supply a scenario. Invent one
that's specific, believable, and visually filmable. Pick the moment the
problem occurs and how FGA solves it cleanly.

Your job is to deliver BOTH:
  (a) the full structured campaign package (audience, pain_point,
      marketing_angle, scenario_summary, content_goal, suggested_tone)
  (b) the same 3-act 12-second Sora script the existing /generate-video
      endpoint produces (hook, caption, hashtags, scenes, voiceover_full,
      voiceover_word_count, video_prompt)

Return JSON ONLY (no markdown fences) with EXACTLY this shape:
{
  "audience": "Who this is for in one sentence",
  "pain_point": "The specific pain in 1-2 sentences",
  "marketing_angle": "The angle / hook strategy in 1-2 sentences",
  "scenario_summary": "The believable scene we'll film, 2-3 sentences",
  "content_goal": "Lead Generation | Brand Awareness | Educate | Promote a Module | Show a Pain Point | Customer Story",
  "suggested_tone": "Direct | Professional | Conversational | Urgent | Humorous | Educational | Premium | Local and Relatable",
  "suggested_platform": "Instagram Reels | Facebook | TikTok | LinkedIn | General Social",
  "hook": "...",
  "caption": "...",
  "hashtags": ["..."],
  "scenes": [...],
  "voiceover_full": "...",
  "voiceover_word_count": 0,
  "video_prompt": "..."
}

Stay within the same 12-second / 36-word voiceover budget the production
prompt requires. Output the JSON now.`;
}

router.post('/auto-concept', async (req, res) => {
  try {
    const db = getServiceClient();
    const body = req.body || {};
    const module = findModule(body.module_id);
    if (!module) return res.status(400).json({ success: false, error: 'Invalid or missing module_id' });

    // Quota gate (same pool as Guided Creation).
    const quota = await checkMarketingVideoQuota(db);
    if (!quota.allowed) {
      return res.status(429).json({ success: false, error: quota.reason, quota });
    }

    const niche = await pickAutoNiche(db, module.key, body.niche);
    let category = findCategoryForNiche(niche) || { categoryKey: 'other', categoryName: 'Other' };
    const profile = moduleProfile(module.key);

    const tone = body.tone || null;
    const contentGoal = body.content_goal || null;
    const platform = body.platform || null;
    const specialInstruction = body.special_instruction || null;

    log.info(`Auto-concept: module=${module.key} niche=${niche} tone=${tone || '-'} goal=${contentGoal || '-'}`);

    const systemPrompt = VIDEO_PROVIDER === 'sora' ? SORA_SYSTEM_PROMPT : VEO_SYSTEM_PROMPT_LEGACY;
    const userMessage = buildAutoConceptUserMessage({
      module, niche, category, profile, tone, contentGoal, platform, specialInstruction,
    });

    const generated = await askClaudeJSON(systemPrompt, userMessage, {
      maxTokens: 3200,
      tenantSlug: 'fga-marketing',
    });

    if (!generated || typeof generated !== 'object' || !generated.hook || !generated.video_prompt) {
      return res.status(502).json({ success: false, error: 'Auto Concept generation returned an incomplete response. Please retry.' });
    }

    // Optional voiceover word-budget enforcement (matches /generate-video).
    const wordCount = String(generated.voiceover_full || '').trim().split(/\s+/).filter(Boolean).length;
    if (wordCount > 38) {
      log.warn(`Auto Concept voiceover overran: ${wordCount} words. Letting it through but flagging.`);
    }

    const safeScript = {
      hook: String(generated.hook || '').slice(0, 220),
      caption: String(generated.caption || '').slice(0, 2200),
      hashtags: Array.isArray(generated.hashtags) ? generated.hashtags.slice(0, 12) : [],
      scenes: Array.isArray(generated.scenes) ? generated.scenes : [],
      voiceover_full: String(generated.voiceover_full || '').slice(0, 1400),
      voiceover_word_count: Number(generated.voiceover_word_count) || wordCount,
      video_prompt: String(generated.video_prompt || '').slice(0, 4500),
    };

    const concept = {
      audience: String(generated.audience || '').slice(0, 400),
      pain_point: String(generated.pain_point || '').slice(0, 600),
      marketing_angle: String(generated.marketing_angle || '').slice(0, 600),
      scenario_summary: String(generated.scenario_summary || '').slice(0, 800),
      content_goal: String(generated.content_goal || contentGoal || 'Promote a Module').slice(0, 100),
      suggested_tone: String(generated.suggested_tone || tone || profile.tone || 'Direct').slice(0, 100),
      suggested_platform: String(generated.suggested_platform || platform || 'Instagram Reels').slice(0, 100),
    };

    const persisted = {
      content_type: CONTENT_TYPE,
      provider: VIDEO_PROVIDER,
      module: { id: module.id, key: module.key, name: module.name },
      niche: { category_key: category.categoryKey, category_name: category.categoryName, niche },
      owner_concept: concept.scenario_summary,
      script: safeScript,
      concept,
      creation_mode: 'auto_concept',
      generation_count: 1,
      partial_regeneration_count: 0,
      auto_options: { tone, content_goal: contentGoal, platform, special_instruction: specialInstruction },
    };

    const { data: draft, error: dbErr } = await db
      .from('content_drafts')
      .insert({
        tenant_id: FGA_TENANT_ID,
        content_type: CONTENT_TYPE,
        platform: (platform && platform.toLowerCase().includes('facebook')) ? 'facebook' : 'instagram',
        status: 'pending_review',
        headline: safeScript.hook,
        body: safeScript.caption,
        hashtags: safeScript.hashtags,
        image_urls: [],
        topic: `${module.name} · ${niche}`,
        format_template: 'fga-auto-concept',
        campaign_payload: persisted,
      })
      .select()
      .single();

    if (dbErr) {
      log.error(`Auto-concept draft insert failed: ${dbErr.message}`);
      return res.status(500).json({ success: false, error: dbErr.message });
    }

    const postQuota = await checkMarketingVideoQuota(db).catch(() => null);

    res.json({
      success: true,
      draft_id: draft.id,
      provider: VIDEO_PROVIDER,
      status: 'pending_review',
      creation_mode: 'auto_concept',
      module: persisted.module,
      niche: persisted.niche,
      concept,
      script: safeScript,
      quota: postQuota || quota,
    });
  } catch (err) {
    log.error(`auto-concept failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// POST /api/admin/marketing/videos/:draftId/regenerate-section
//
// Partial regeneration — owner approves most of the auto-generated package
// but wants ONE section rewritten (caption / hashtags / scenario / hook /
// visual direction). Preserves every other field.
//
// Body: { section: 'caption' | 'hashtags' | 'hook' | 'scenario' | 'video_prompt' | 'visual_direction' }
// ============================================================================
router.post('/videos/:draftId/regenerate-section', async (req, res) => {
  try {
    const db = getServiceClient();
    const draftId = req.params.draftId;
    const section = String((req.body && req.body.section) || '').toLowerCase();
    const valid = new Set(['caption', 'hashtags', 'hook', 'scenario', 'video_prompt', 'visual_direction']);
    if (!valid.has(section)) {
      return res.status(400).json({ success: false, error: `Unknown section. Choose: ${[...valid].join(', ')}` });
    }

    const { data: draft, error: fetchErr } = await db
      .from('content_drafts')
      .select('*')
      .eq('id', draftId)
      .eq('tenant_id', FGA_TENANT_ID)
      .single();
    if (fetchErr || !draft) return res.status(404).json({ success: false, error: 'Draft not found' });
    if (draft.status !== 'pending_review') {
      return res.status(409).json({ success: false, error: `Cannot regenerate a section once status=${draft.status}. Only pending_review drafts can be regenerated.` });
    }

    const cp = draft.campaign_payload || {};
    const module = cp.module || {};
    const niche = (cp.niche && cp.niche.niche) || '';
    const profile = moduleProfile(module.key);

    const sectionGuides = {
      caption: 'Write a new primary caption (15-25 words) and short caption (≤90 chars). Natural, direct, niche-relevant, soft CTA.',
      hashtags: 'Write a NEW set of 6-10 hashtags. Mix niche-specific (e.g. #treeservice) with FGA-relevant tags (e.g. #smallbusiness). No # in the JSON values — return clean strings.',
      hook: 'Write a NEW 3-5 word scroll-stopper hook + the matching first-line of voiceover (≤14 words). Keep the rest of the script unchanged.',
      scenario: 'Rewrite the believable scenario (2-3 sentences) AND the visual descriptions in scenes[]. Keep voiceover word budget the same.',
      video_prompt: 'Rewrite ONLY the video_prompt (Sora-ready cinematic prompt). Keep the script structure / voiceover identical.',
      visual_direction: 'Rewrite the visual descriptions inside each scenes[] entry (visual field). Keep voiceover and timing intact.',
    };

    const userMessage = `Regenerate ONE SECTION of an existing FGA marketing promo.

Module: ${module.name || module.key} (${module.key})
Niche: ${niche}
Module tone: ${profile.tone}

EXISTING SCRIPT (preserve everything you're not regenerating):
${JSON.stringify(cp.script || {}, null, 2)}

EXISTING CONCEPT:
${JSON.stringify(cp.concept || {}, null, 2)}

SECTION TO REGENERATE: ${section}
INSTRUCTION: ${sectionGuides[section]}

Return JSON ONLY containing the fields that belong to this section. Examples:
  - section=caption    → { "caption": "...", "short_caption": "..." }
  - section=hashtags   → { "hashtags": ["..."] }
  - section=hook       → { "hook": "...", "scenes": [...] }   (updated first scene only)
  - section=scenario   → { "scenario_summary": "...", "scenes": [...] }
  - section=video_prompt    → { "video_prompt": "..." }
  - section=visual_direction → { "scenes": [...] }

Do NOT return any other fields. Output the JSON now.`;

    const updated = await askClaudeJSON(
      'You are a senior brand copywriter rewriting one section of an FGA marketing promo. Return JSON only.',
      userMessage,
      { maxTokens: 1500, tenantSlug: 'fga-marketing' }
    );

    const newScript = { ...(cp.script || {}) };
    const newConcept = { ...(cp.concept || {}) };
    if (updated && typeof updated === 'object') {
      if (updated.caption) newScript.caption = String(updated.caption).slice(0, 2200);
      if (updated.short_caption) newConcept.short_caption = String(updated.short_caption).slice(0, 220);
      if (Array.isArray(updated.hashtags)) newScript.hashtags = updated.hashtags.slice(0, 12);
      if (updated.hook) newScript.hook = String(updated.hook).slice(0, 220);
      if (Array.isArray(updated.scenes)) newScript.scenes = updated.scenes;
      if (updated.scenario_summary) newConcept.scenario_summary = String(updated.scenario_summary).slice(0, 800);
      if (updated.video_prompt) newScript.video_prompt = String(updated.video_prompt).slice(0, 4500);
    }

    const newPayload = {
      ...cp,
      script: newScript,
      concept: newConcept,
      partial_regeneration_count: (cp.partial_regeneration_count || 0) + 1,
      last_regenerated_section: section,
      last_regenerated_at: new Date().toISOString(),
    };

    const patch = { campaign_payload: newPayload, updated_at: new Date().toISOString() };
    if (section === 'hook') patch.headline = newScript.hook;
    if (section === 'caption') patch.body = newScript.caption;
    if (section === 'hashtags') patch.hashtags = newScript.hashtags;

    const { data: saved, error: updateErr } = await db
      .from('content_drafts')
      .update(patch)
      .eq('id', draftId)
      .select()
      .single();
    if (updateErr) throw updateErr;

    res.json({ success: true, draft: saved, section });
  } catch (err) {
    log.error(`regenerate-section failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
