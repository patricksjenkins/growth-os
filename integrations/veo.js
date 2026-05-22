/**
 * Growth OS — Google Veo Video Generation
 *
 * Uses the Gemini API surface (generativelanguage.googleapis.com) with
 * the same GOOGLE_API_KEY that powers Gemini Pro / Flash. Veo is async:
 * a generation request returns an operation handle; you poll the
 * operation until it completes with a downloadable video URI.
 *
 * Exports:
 *   - generateVeoVideo(prompt, options)  → { operation_name, model }
 *   - pollVeoOperation(operationName)    → { done, video_url, error }
 *
 * The route handler kicks off the generation and stores the operation
 * name on a content_drafts row. The same row is polled (lazily on draft
 * fetch, or by a worker) until done=true; then we persist the public
 * video URL and the FGA admin can review + approve to Buffer.
 *
 * Env:
 *   GOOGLE_API_KEY    (required) — same key used by gemini.js
 *   VEO_MODEL         (optional) — default 'veo-3.0-generate-001'
 *
 * Note: Veo via the Gemini API returns a Files API URI (files/...).
 * Direct download requires appending ?key=KEY. We translate the URI
 * into a public-style URL when storing on the draft so the admin UI
 * can show a preview without exposing the API key — see videoFileUrl().
 */

require('dotenv').config();
const axios = require('axios');
const { createLogger } = require('../core/logger');

const VEO_MODEL = process.env.VEO_MODEL || 'veo-3.0-generate-001';
const GEN_AI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * Kick off a Veo video generation.
 *
 * @param {string} prompt — cinematic text prompt
 * @param {Object} opts
 * @param {string} [opts.aspectRatio]   — '16:9' (default), '9:16', '1:1'
 * @param {number} [opts.durationSeconds] — clamped 5-30 by Veo
 * @param {string} [opts.tenantSlug]    — for logging
 * @returns {Promise<{ operation_name, model }>}
 */
async function generateVeoVideo(prompt, opts = {}) {
  const log = createLogger('veo', opts.tenantSlug);
  const model = opts.model || VEO_MODEL;
  const aspectRatio = opts.aspectRatio || '9:16';        // vertical for social
  const duration = Math.min(Math.max(opts.durationSeconds || 8, 5), 30);

  if (!process.env.GOOGLE_API_KEY) {
    throw new Error('GOOGLE_API_KEY not set — required for Veo video generation');
  }

  const url = `${GEN_AI_BASE}/models/${model}:predictLongRunning?key=${process.env.GOOGLE_API_KEY}`;

  log.info(`Kicking off Veo render: model=${model} aspect=${aspectRatio} duration=${duration}s`);

  let res;
  try {
    res = await axios.post(url, {
      instances: [{ prompt }],
      parameters: {
        aspectRatio,
        durationSeconds: duration,
        // The number of videos to generate. Default 1; cap at 1 to
        // keep token spend predictable. Admin can re-run if needed.
        sampleCount: 1,
      },
    }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 60000,
    });
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.message;
    log.error(`Veo generation request failed: ${detail}`);
    const e = new Error(`Veo generation failed: ${detail}`);
    e.status = err.response?.status || 500;
    throw e;
  }

  const operationName = res.data?.name;
  if (!operationName) {
    throw new Error(`Veo did not return an operation handle (response: ${JSON.stringify(res.data).slice(0, 200)})`);
  }

  log.success(`Veo render queued: ${operationName}`);
  return { operation_name: operationName, model };
}

/**
 * Check the status of a Veo render.
 *
 * @param {string} operationName  e.g. 'operations/abc123' or full URL fragment
 * @param {Object} [opts]
 * @returns {Promise<{ done: boolean, video_url: string|null, error: string|null, raw: any }>}
 */
async function pollVeoOperation(operationName, opts = {}) {
  const log = createLogger('veo-poll', opts.tenantSlug);
  if (!operationName) return { done: false, video_url: null, error: 'missing_operation', raw: null };
  if (!process.env.GOOGLE_API_KEY) {
    throw new Error('GOOGLE_API_KEY not set');
  }

  // Operation name may come back as 'models/.../operations/...' or
  // 'operations/...' depending on the Veo variant. The poll URL accepts
  // both as-is appended to v1beta/.
  const opPath = operationName.startsWith('http')
    ? operationName.replace(/^https?:\/\/[^/]+\/v1beta\//, '')
    : operationName;
  const url = `${GEN_AI_BASE}/${opPath}?key=${process.env.GOOGLE_API_KEY}`;

  let res;
  try {
    res = await axios.get(url, { timeout: 30000 });
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.message;
    log.warn(`Veo poll failed: ${detail}`);
    return { done: false, video_url: null, error: detail, raw: err.response?.data || null };
  }

  const data = res.data || {};
  if (!data.done) {
    return { done: false, video_url: null, error: null, raw: data };
  }

  // Done — but may have errored.
  if (data.error) {
    const msg = data.error.message || JSON.stringify(data.error);
    log.warn(`Veo operation finished with error: ${msg}`);
    return { done: true, video_url: null, error: msg, raw: data };
  }

  // Success — pull the file URI. Veo's response shape:
  //   response.generateVideoResponse.generatedSamples[0].video.uri
  // OR (older shape):
  //   response.generatedVideos[0].video.uri
  const resp = data.response || {};
  const samples =
    resp.generateVideoResponse?.generatedSamples ||
    resp.generatedVideos ||
    [];
  const firstUri = samples[0]?.video?.uri || samples[0]?.uri || null;

  if (!firstUri) {
    log.warn(`Veo operation done but no video URI in response: ${JSON.stringify(resp).slice(0, 200)}`);
    return { done: true, video_url: null, error: 'no_video_uri', raw: data };
  }

  const publicUrl = videoFileUrl(firstUri);
  log.success(`Veo render complete: ${firstUri}`);
  return { done: true, video_url: publicUrl, error: null, raw: data };
}

/**
 * Turn a Veo files/... URI into a fetchable URL. The Files API requires
 * the API key as a query param to download. For admin-only UI use we
 * embed it here — the URL is only ever served to platform_owner users
 * inside the admin portal, never published externally.
 *
 * If a tenant-facing path ever consumes these, swap to a server-proxy
 * that streams the bytes through and never exposes the key.
 */
function videoFileUrl(uri) {
  if (!uri) return null;
  if (uri.startsWith('http')) return uri;
  // Normalize 'files/...' or 'projects/.../files/...'
  const clean = uri.replace(/^\/+/, '');
  return `${GEN_AI_BASE}/${clean}?alt=media&key=${process.env.GOOGLE_API_KEY}`;
}

module.exports = {
  generateVeoVideo,
  pollVeoOperation,
  videoFileUrl,
  VEO_MODEL,
};
