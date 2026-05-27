/**
 * Growth OS — Gemini Integration
 *
 * Two surfaces:
 *  1. generateImage()      — text→image for post graphics + app icons
 *  2. askGeminiAnalyze()   — multimodal analyze for "+ Request Post" media
 *                            (image + video understanding, audio transcription)
 *
 * Both share GOOGLE_API_KEY but use different models.
 */

require('dotenv').config();
const axios = require('axios');
const { createLogger } = require('../core/logger');

const GEMINI_IMAGE_MODEL  = process.env.GEMINI_IMAGE_MODEL  || 'gemini-3-pro-image-preview';
// Flash is faster + cheaper for image-only analysis. Pro handles video
// with audio transcription + multi-speaker nuance.
const GEMINI_VISION_MODEL = process.env.GEMINI_VISION_MODEL || 'gemini-2.5-flash';
const GEMINI_VIDEO_MODEL  = process.env.GEMINI_VIDEO_MODEL  || 'gemini-2.5-pro';

/**
 * Generate an image using Gemini API
 * @param {string} prompt - Image generation prompt
 * @param {Object} options
 * @returns {Buffer} Image buffer (PNG/JPEG)
 */
async function generateImage(prompt, options = {}) {
  const log = createLogger('gemini', options.tenant?.slug || options.tenantSlug);
  const model = options.model || GEMINI_IMAGE_MODEL;

  // Per-tenant monthly cap. Pass options.tenant to enforce.
  if (options.tenant && options.tenant.id) {
    const {
      checkUsageOrThrow, incrementUsage, notifyOwnerCapReached, UsageCapExceededError,
    } = require('../core/usage-caps');
    try {
      await checkUsageOrThrow(options.tenant, 'image_gen_count', 1);
    } catch (capErr) {
      if (capErr instanceof UsageCapExceededError) {
        log.warn(`Image-gen cap hit for tenant ${options.tenant.id} (${capErr.used}/${capErr.cap}) — skipping generation`);
        notifyOwnerCapReached(options.tenant.id, 'image_gen_count', capErr.used, capErr.cap);
      }
      throw capErr;
    }
  }

  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GOOGLE_API_KEY}`;

  log.info(`Generating image with ${model}...`);

  // 2026-05-26 (REVISED after probing): gemini-3-pro-image-preview
  // ONLY honors aspectRatio '1:1' on this account. Every other value
  // ('4:5', '9:16', '16:9', '4:3', '3:4') causes the API to return a
  // response with NO image (text-only), which broke every photo-based
  // format. We now default to NOT passing aspectRatio (Gemini's
  // default is square 1024×1024) and let Sharp do any portrait/landscape
  // crop downstream. Callers can pass options.aspectRatio if they
  // want to try — but be ready to handle "No image in response".
  const generationConfig = { responseModalities: ['IMAGE', 'TEXT'] };
  if (options.aspectRatio) {
    generationConfig.imageConfig = { aspectRatio: options.aspectRatio };
  }

  // V1 hardening (2026-05-24): wrap in withRetry so transient 429/503 from
  // Gemini doesn't kill the whole content-generation job.
  const { withRetry } = require('./_retry');
  const response = await withRetry(
    () => axios.post(geminiUrl, {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig
    }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 120000
    }),
    {
      attempts: 3,
      onRetry: (err, attempt, delayMs) =>
        console.warn(`[gemini:image] retry ${attempt} in ${delayMs}ms: ${err.message}`),
    }
  );

  const parts = response.data?.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find(p => p.inlineData?.mimeType?.startsWith('image/'));
  const imageBase64 = imagePart?.inlineData?.data;

  if (!imageBase64) {
    const textPart = parts.find(p => p.text);
    const errorDetail = textPart?.text || 'No image in response';
    throw new Error(`No image returned from Gemini API: ${errorDetail}`);
  }

  log.success('Image generated');

  // Increment counter after successful generation (fire-and-forget)
  if (options.tenant && options.tenant.id) {
    try {
      const { incrementUsage } = require('../core/usage-caps');
      incrementUsage(options.tenant.id, 'image_gen_count', 1).catch(() => {});
    } catch (_) { /* never let usage tracking break a generation */ }
  }

  return Buffer.from(imageBase64, 'base64');
}

/**
 * askGeminiAnalyze — describe uploaded media for the content-generation
 * pipeline. Returns a structured visual brief that Claude then uses to
 * write the actual social post.
 *
 * Why Gemini and not Claude vision? Native video + audio in one call,
 * no ffmpeg keyframe extraction, no separate transcription service.
 *
 * @param {Object} params
 * @param {('single'|'before_after'|'video')} params.kind
 * @param {string[]} params.mediaUrls  - public Supabase Storage URLs
 * @param {string[]} [params.mimeTypes] - parallel to mediaUrls; defaults
 *                                        to image/jpeg or video/mp4
 * @param {string} params.userTopic    - owner's typed theme/topic
 * @param {Object} [params.options]
 * @param {Object} [params.options.tenant]    - for logging
 * @param {string} [params.options.tenantSlug]
 * @returns {Promise<Object>} structured visual brief JSON
 */
async function askGeminiAnalyze({ kind, mediaUrls, mimeTypes, userTopic, options = {} }) {
  const log = createLogger('gemini-analyze', options.tenant?.slug || options.tenantSlug);

  if (!Array.isArray(mediaUrls) || mediaUrls.length === 0) {
    throw new Error('askGeminiAnalyze requires at least one mediaUrl');
  }
  if (!['single', 'before_after', 'video'].includes(kind)) {
    throw new Error(`askGeminiAnalyze: unknown kind "${kind}"`);
  }

  // Model selection — Flash for stills, Pro for video.
  const model = kind === 'video' ? GEMINI_VIDEO_MODEL : GEMINI_VISION_MODEL;

  // Default mime types — heuristic if caller didn't provide.
  const mimes = mediaUrls.map((url, i) => {
    if (mimeTypes && mimeTypes[i]) return mimeTypes[i];
    if (kind === 'video') return 'video/mp4';
    const m = (url.match(/\.(png|jpe?g|webp|heic|heif)(?:\?|$)/i) || [])[1] || 'jpeg';
    return `image/${m === 'jpg' ? 'jpeg' : m.toLowerCase()}`;
  });

  // Order matters — the prompt references "first image is BEFORE,
  // second is AFTER" so for before_after we ALWAYS pass [before, after].
  const fileParts = mediaUrls.map((url, i) => ({
    fileData: { fileUri: url, mimeType: mimes[i] },
  }));

  const analysisPrompt = [
    `You are an analyst preparing a creative brief for a social-media copywriter.`,
    ``,
    `You will receive ${kind === 'before_after' ? 'two images (image 1 = BEFORE, image 2 = AFTER)' : kind === 'video' ? 'a short video file' : 'a single image'} uploaded by a small-business owner, along with a topic line they typed.`,
    ``,
    `Your job: produce a structured JSON brief describing what is VISUALLY${kind === 'video' ? ' (and audibly)' : ''} present in the media. The downstream writer will use this to compose the post — be specific and factual, not promotional.`,
    ``,
    `Output ONLY a JSON object matching this schema:`,
    `{`,
    `  "kind": "${kind}",`,
    `  "scene_description": "What is literally visible — be specific. Materials, fixtures, conditions, faces, settings. Two paragraphs max.",`,
    `  "transformation_summary": ${kind === 'before_after' ? '"Describe the change between BEFORE and AFTER."' : kind === 'video' ? '"Summarize what happens across the clip."' : 'null'},`,
    `  "spoken_words": ${kind === 'video' ? '"Full transcript of any audible speech. Empty string if silent or no audio."' : 'null'},`,
    `  "key_objects": ["array", "of", "concrete", "nouns"],`,
    `  "emotional_tone": "Two-word descriptor like 'urgent, capable' or 'warm, confident' or 'gritty, hardworking'.",`,
    `  "do_not_invent_warnings": "If the owner's topic line claims something not visible in the media (e.g. owner says 'finished in 3 hours' but you can't verify time), surface it as a short note. Empty string if topic and media are consistent."`,
    `}`,
    ``,
    `Rules:`,
    `- Describe what you see. Do not embellish or speculate beyond visible evidence.`,
    `- For before/after, image 1 is BEFORE and image 2 is AFTER. Always in that order.`,
    `- For video, weight what's visible AND what's said equally.`,
    `- If the owner's topic contradicts the media, list it in do_not_invent_warnings — the writer will soften the copy accordingly.`,
    ``,
    `Owner's topic line:`,
    `"${(userTopic || '').replace(/"/g, '\\"').slice(0, 600)}"`,
  ].join('\n');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GOOGLE_API_KEY}`;

  log.info(`Analyzing ${mediaUrls.length} ${kind === 'video' ? 'video' : 'image'}${mediaUrls.length === 1 ? '' : 's'} with ${model}`);

  let response;
  try {
    // V1 hardening (2026-05-24): wrap in withRetry. Gemini analyze takes
    // longer per request than image gen, and transient 429s are common
    // during peak hours.
    const { withRetry } = require('./_retry');
    response = await withRetry(
      () => axios.post(url, {
        contents: [{
          parts: [
            ...fileParts,
            { text: analysisPrompt },
          ],
        }],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.2, // factual description — keep it grounded
        },
      }, {
        headers: { 'Content-Type': 'application/json' },
        // Video can take a while to fetch + process; give it generous time.
        timeout: kind === 'video' ? 180000 : 60000,
      }),
      {
        attempts: 3,
        onRetry: (err, attempt, delayMs) =>
          console.warn(`[gemini:analyze] retry ${attempt} in ${delayMs}ms: ${err.message}`),
      }
    );
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.message;
    log.error(`Gemini analyze failed: ${detail}`);
    throw new Error(`Gemini media analysis failed: ${detail}`);
  }

  const parts = response.data?.candidates?.[0]?.content?.parts || [];
  const textPart = parts.find(p => typeof p.text === 'string');
  if (!textPart) {
    throw new Error('Gemini returned no text part in analyze response');
  }

  let brief;
  try {
    brief = JSON.parse(textPart.text);
  } catch (parseErr) {
    // responseMimeType=application/json should prevent this, but guard
    // anyway — try to extract a JSON object from the text blob.
    const m = textPart.text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error(`Gemini analyze returned non-JSON: ${textPart.text.slice(0, 200)}`);
    brief = JSON.parse(m[0]);
  }

  log.success(`Analyzed ${kind} — key_objects=[${(brief.key_objects || []).slice(0, 4).join(', ')}], warnings=${brief.do_not_invent_warnings ? 'yes' : 'none'}`);

  return brief;
}

module.exports = { generateImage, askGeminiAnalyze };
