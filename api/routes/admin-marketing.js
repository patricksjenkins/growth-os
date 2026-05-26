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
    const VOICEOVER_WORD_CAP = 30;

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
          `  Scene 1 (0:00-0:04): ≤11 words AFTER substitution\n` +
          `  Scene 2 (0:04-0:08): ≤12 words AFTER substitution\n` +
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

    // ── Step 2: Kick off the render (provider-switched) ──────────
    //
    // Sora path (default): one 25-second clip with native spoken
    //   voiceover. No two-step pipeline, no extension call, no playlist
    //   stitching at publish time.
    //
    // Veo path (VIDEO_PROVIDER=veo): legacy two-step base+extension
    //   pipeline. Kept intact for rollback if Sora has an outage.
    let renderState = null;
    if (VIDEO_PROVIDER === 'sora') {
      let soraId = null;
      let soraError = null;
      let soraStatus = 'queued';
      let requestedSeconds = SORA_SECONDS;

      // Sora seconds fallback chain — walk down through documented-valid
      // values when the API rejects the requested duration with
      // invalid_value. Each rejected POST is FREE (validation error,
      // no render started). On this OpenAI account sora-2-pro accepts
      // only '4' | '8' | '12'; the public docs claim 10|15|25 but
      // those return 400 here.
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
            continue;   // try next value in the chain
          }
          // Non-validation error → record and stop trying.
          soraError = e.message || String(e);
          log.warn(`Sora kickoff failed (script saved anyway): ${soraError}`);
          break;
        }
      }
      if (!succeeded && !soraError) {
        soraError = 'All documented seconds values were rejected by Sora.';
      }

      renderState = {
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
    } else {
      // ── Legacy Veo two-step pipeline (rollback path) ──────────
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
        veoError = e.message || String(e);
        log.warn(`Veo base kickoff failed (script saved anyway): ${veoError}`);
      }
      renderState = {
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
          // back-compat mirrors of the old top-level shape
          operation_name: operationName,
          status: operationName ? 'rendering' : 'failed',
          video_url: null,
        },
      };
    }

    // Persist provider-specific render state on campaign_payload.{sora|veo}.
    const persisted = { content_type: CONTENT_TYPE };
    persisted.module = { id: module.id, key: module.key, name: module.name };
    persisted.niche = { category_key: category.categoryKey, category_name: category.categoryName, niche };
    persisted.owner_concept = trimmedConcept;
    persisted.script = safeScript;
    persisted.provider = renderState.provider;
    if (renderState.sora) persisted.sora = renderState.sora;
    if (renderState.veo) persisted.veo = renderState.veo;

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

    const providerLogTag = renderState.provider === 'sora'
      ? `Sora id: ${renderState.sora?.video_id || 'none'}`
      : `Veo op: ${renderState.veo?.base?.operation_name || 'none'}`;
    log.success(`Promo draft created: ${draft.id} (${providerLogTag})`);

    // Refresh quota numbers AFTER the insert so the response carries
    // the updated counter the frontend will use to render the banner.
    const postQuota = await checkMarketingVideoQuota(db).catch(() => null);

    res.json({
      success: true,
      draft_id: draft.id,
      provider: renderState.provider,
      sora: renderState.sora || null,
      veo: renderState.veo || null,
      script: safeScript,
      quota: postQuota || quota,
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
Total voiceover MUST be ≤ 30 words across the entire 12 seconds.
That's 150 wpm — natural narration pace WITH small breath pauses.
Anything longer overruns the 12s clip and gets cut off mid-sentence,
wasting Sora render credits. There is NO retry inside Sora — the
cap is real.

Per-scene budget (HARD ceilings — after substitution, count words):
  Scene 1: ≤ 11 words AFTER \${target_niche} substitution
  Scene 2: ≤ 12 words AFTER [PAIN POINT] + \${selected_module} substitution
  Scene 3: 7 words FIXED (the FGA tagline, no substitution)

After you write the lines, count the words yourself. Output the
count in the JSON's \`voiceover_word_count\` field. If your count
is > 30, REWRITE before returning JSON.

==============================================================
THE 12-SECOND 3-SCENE FRAMEWORK
==============================================================

  SCENE 1 — 0:00 to 0:04 — STAT HOOK
    Visual: A high-action, visually unmistakable shot of an owner-operator in the \${target_niche} actively doing their core trade. The niche must be visually identifiable in the first half second — not generic small-biz B-roll. End the 4-second beat on a close-up that telegraphs the operator is busy / unaware of the lost opportunity (customer walking away, phone face-down, screen dark).
    Voiceover (≤11 words AFTER \${target_niche} substituted, hard statistic up front, no preamble):
      Format:     "[STAT]% of customers [behavior] before they book."
      Primary:    "[STAT]% of \${target_niche} customers [behavior] before they book."
      Fallback if niche pushes over 11 words: "[STAT]% of customers [behavior] before they book."
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
      Beat B (0:06-0:08): Quick cut to the FGA mobile interface showing \${selected_module} running on autopilot — clean dark UI, the operator's phone lighting up with a clear text-brief notification proving the task was handled. End on the operator's face, calm and confident.
    Voiceover (≤12 words AFTER substitutions — short, declarative, no marketing fluff):
      Format:     "[PROBLEM STATE]. FGA [solves it in 2-3 words]."
      Module-specific examples (these are TARGETS — match this terse rhythm):
        - Website / Done-For-You Website   → "No site? You're invisible. FGA builds yours."
        - AI Voice Receptionist            → "Miss the call, lose the job. FGA answers it."
        - Missed Call Text-Back            → "Missed call? FGA texts back instantly."
        - AI Chat Agent                    → "No reply, they bounce. FGA chats 24/7."
        - Speed-to-Lead                    → "First reply wins. FGA replies in seconds."
        - Lead Capture & CRM               → "Lost leads cost cash. FGA captures every one."
        - Follow-Up Sequences               → "Forget to follow up? FGA never does."
        - Review Requests                   → "Reviews drive bookings. FGA asks for you."
        - Referral Engine                   → "Referrals fade fast. FGA chases them down."
        - Branded Mobile App                → "Apps build loyalty. FGA ships yours."
        - Content Engine                    → "Empty feed? FGA posts for you."
        - Prospecting Engine                → "Cold leads pile up. FGA prospects nightly."
        - Lead Scoring                      → "Chasing wrong leads burns hours. FGA scores them."
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
    { "id": 1, "start": "0:00", "end": "0:04", "clip": "single", "visual": "1-sentence shot description: niche-specific work + busy/overwhelmed close-up at the end", "voiceover": "the Scene 1 voiceover with \${target_niche} filled in (≤11 words)" },
    { "id": 2, "start": "0:04", "end": "0:08", "clip": "single", "visual": "1-sentence shot describing both beats: bottleneck for THIS module then FGA UI relief beat", "voiceover": "the Scene 2 voiceover with [PAIN] and \${selected_module} filled in (≤12 words)" },
    { "id": 3, "start": "0:08", "end": "0:12", "clip": "single", "visual": "1-sentence shot of the niche-specific payoff (NO logos/wordmarks — branding added in post)", "voiceover": "the verbatim FGA tagline (7 words, no substitutions)" }
  ],
  "voiceover_full": "the full 4-scene voiceover script as ONE continuous string, with all dynamic insertions filled in. Used for caption / overlay reference. MUST be the concatenation of the 4 scene voiceovers (substitutions applied) separated by single spaces — nothing more, nothing less.",
  "voiceover_word_count": <integer — count the words in voiceover_full after substitutions. MUST be ≤ 30. If your count exceeds 30, REWRITE shorter before returning JSON.>,
  "video_prompt": "ONE dense paragraph (160-220 words) that Sora 2 Pro will turn into the 12-second clip. MUST encode the 3-scene structure with explicit timed cuts AND embedded voiceover directives. Format: 'SCENE 1 (0-4s): [visual]. Voiceover (confident grounded male voice, trusted-advisor tone, paced naturally): \"...\" CUT TO. SCENE 2 (4-8s): [visual — two beats, the bottleneck then the FGA UI relief]. Voiceover: \"...\" CUT TO. SCENE 3 (8-12s): [visual — niche-specific payoff, NO logos]. Voiceover: \"...\"' Specify camera moves (handheld push-in, overhead, dolly, tracking shot), lighting (golden hour, fluorescent shop, soft window, neon glow), and the EXACT visible moment in Scene 2 Beat B when the FGA module fires on the phone. Vertical 9:16, cinematic color grading."
}

==============================================================
RULES
==============================================================
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

module.exports = router;
