/**
 * Growth OS — OpenAI Sora Video Generation
 *
 * Sora is OpenAI's text-to-video model. Used by the platform-owner
 * Marketing Studio to produce 25-second cinematic promos with native
 * spoken voiceover (a capability Veo lacked, forcing our prior
 * silent-clip two-step pipeline).
 *
 * Async API surface (same shape as Veo's predictLongRunning):
 *   POST /v1/videos                → { id, status: 'queued', ... }
 *   GET  /v1/videos/:id            → { id, status, progress, completed_at, error, ... }
 *   GET  /v1/videos/:id/content    → mp4 bytes (Content-Type: video/mp4)
 *
 * Auth: Bearer OPENAI_API_KEY.
 *
 * The platform-owner Marketing Studio is the ONLY caller; tenant
 * surfaces never reach this module. Cost guardrails live in
 * core/marketing-usage-caps.js — that gate runs BEFORE generateSoraVideo
 * is called.
 *
 * Env:
 *   OPENAI_API_KEY     (required)
 *   SORA_MODEL         (optional, default 'sora-2-pro')
 *   SORA_SIZE          (optional, default '1024x1792' vertical 9:16)
 *   SORA_SECONDS       (optional, default '25' — sora-2-pro documented values: 10|15|25)
 */

require('dotenv').config();
const axios = require('axios');
const { createLogger } = require('../core/logger');

const SORA_BASE = 'https://api.openai.com/v1/videos';
const SORA_MODEL = process.env.SORA_MODEL || 'sora-2-pro';
const SORA_SIZE = process.env.SORA_SIZE || '1024x1792';
const SORA_SECONDS = process.env.SORA_SECONDS || '25';

function authHeaders() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY not set — required for Sora video generation');
  return { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
}

class SoraInvalidParamError extends Error {
  constructor(param, message) {
    super(message);
    this.name = 'SoraInvalidParamError';
    this.invalidParam = param;
  }
}

/**
 * Kick off a Sora video generation.
 *
 * @param {string} prompt — cinematic text prompt with embedded voiceover instructions
 * @param {Object} [opts]
 * @param {string} [opts.model]    default sora-2-pro
 * @param {string} [opts.size]     default 1024x1792 (vertical 9:16 for Reels)
 * @param {string} [opts.seconds]  default '25' — sora-2-pro accepts '10' | '15' | '25'
 * @returns {Promise<{ id, status, model, seconds, size }>}
 */
async function generateSoraVideo(prompt, opts = {}) {
  const log = createLogger('sora', opts.tenantSlug);
  const model = opts.model || SORA_MODEL;
  const size = opts.size || SORA_SIZE;
  const seconds = String(opts.seconds || SORA_SECONDS);

  if (!prompt || String(prompt).trim().length < 10) {
    throw new Error('Sora prompt is too short');
  }

  log.info(`Kicking off Sora render: model=${model} size=${size} seconds=${seconds}`);

  let res;
  try {
    res = await axios.post(SORA_BASE, {
      prompt,
      model,
      size,
      seconds,
    }, {
      headers: authHeaders(),
      timeout: 60000,
    });
  } catch (err) {
    const apiError = err.response?.data?.error || {};
    const detail = apiError.message || err.message;
    const status = err.response?.status || 500;
    log.warn(`Sora generation request failed (${status}): ${detail}`);

    // Surface known invalid-param errors as a typed exception so the
    // route handler can attempt a graceful fallback (e.g. drop from 20s
    // to 15s) without burning a render.
    if (status === 400 && apiError.param) {
      throw new SoraInvalidParamError(apiError.param, detail);
    }
    const e = new Error(`Sora generation failed: ${detail}`);
    e.status = status;
    throw e;
  }

  const data = res.data || {};
  if (!data.id) {
    throw new Error(`Sora did not return a video id (response: ${JSON.stringify(data).slice(0, 200)})`);
  }

  log.success(`Sora render queued: ${data.id} (status=${data.status})`);
  return {
    id: data.id,
    status: data.status || 'queued',
    model: data.model || model,
    seconds: String(data.seconds || seconds),
    size: data.size || size,
    created_at: data.created_at || null,
  };
}

/**
 * Check the status of a Sora render.
 *
 * @param {string} videoId  e.g. 'video_abc123'
 * @returns {Promise<{ id, status, progress, completed_at, error, raw }>}
 *   status is one of: 'queued' | 'in_progress' | 'completed' | 'failed'
 */
async function pollSoraVideo(videoId, opts = {}) {
  const log = createLogger('sora-poll', opts.tenantSlug);
  if (!videoId) return { id: null, status: 'missing', progress: 0, completed_at: null, error: 'missing_video_id', raw: null };

  let res;
  try {
    res = await axios.get(`${SORA_BASE}/${videoId}`, {
      headers: authHeaders(),
      timeout: 30000,
    });
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.message;
    log.warn(`Sora poll failed: ${detail}`);
    return { id: videoId, status: 'unknown', progress: 0, completed_at: null, error: detail, raw: err.response?.data || null };
  }

  const data = res.data || {};
  return {
    id: data.id || videoId,
    status: data.status || 'unknown',
    progress: typeof data.progress === 'number' ? data.progress : 0,
    completed_at: data.completed_at || null,
    error: data.error ? (data.error.message || JSON.stringify(data.error)) : null,
    seconds: data.seconds || null,
    size: data.size || null,
    model: data.model || null,
    raw: data,
  };
}

/**
 * Stream the mp4 bytes for a completed Sora render.
 *
 * Returns an axios response object with .data as a readable stream.
 * Caller is responsible for piping to res / writing to disk and for
 * checking upstream.status before consuming the stream.
 *
 * @param {string} videoId
 * @returns {Promise<axios.AxiosResponse>}
 */
async function fetchSoraVideoBytes(videoId) {
  if (!videoId) throw new Error('fetchSoraVideoBytes requires a video id');
  return axios.get(`${SORA_BASE}/${videoId}/content`, {
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    responseType: 'stream',
    timeout: 90000,
    validateStatus: () => true,
  });
}

/**
 * Download the completed Sora mp4 and upload it to a public Supabase
 * Storage bucket. Returns the public URL.
 *
 * Why: Buffer's createPost mutation fetches mediaUrls server-side. The
 * OpenAI `/v1/videos/:id/content` endpoint requires Bearer auth, so
 * Buffer would 401. By staging the bytes to a public Supabase bucket
 * we hand Buffer (and any future external consumer) a clean public URL
 * with no API key in sight.
 *
 * Storage path: tenant-assets/fga-marketing/{draftId}.mp4
 * Cache: 1 year (mp4 is immutable once rendered).
 *
 * @param {SupabaseClient} db        service-role Supabase client
 * @param {string} videoId           Sora video id (for OpenAI fetch)
 * @param {string} draftId           content_drafts.id (for storage path)
 * @returns {Promise<{ public_url, storage_path, bytes }>}
 */
async function uploadSoraToStorage(db, videoId, draftId) {
  const log = createLogger('sora-upload', 'fga-marketing');
  const upstream = await fetchSoraVideoBytes(videoId);
  if (upstream.status >= 400) {
    throw new Error(`Failed to fetch Sora content (${upstream.status})`);
  }

  // Buffer the stream into a Buffer (Supabase upload needs a Blob /
  // Buffer / ArrayBuffer, not a Node stream).
  const chunks = [];
  await new Promise((resolve, reject) => {
    upstream.data.on('data', c => chunks.push(c));
    upstream.data.on('end', resolve);
    upstream.data.on('error', reject);
  });
  const mp4Buffer = Buffer.concat(chunks);
  const bytes = mp4Buffer.length;

  const storagePath = `fga-marketing/${draftId}.mp4`;
  const { error: upErr } = await db.storage
    .from('tenant-assets')
    .upload(storagePath, mp4Buffer, {
      contentType: 'video/mp4',
      cacheControl: '31536000',  // 1 year
      upsert: true,              // re-renders overwrite cleanly
    });
  if (upErr) {
    throw new Error(`Supabase upload failed: ${upErr.message}`);
  }

  const { data: pub } = db.storage
    .from('tenant-assets')
    .getPublicUrl(storagePath);

  log.success(`Staged Sora mp4 to public storage: ${pub.publicUrl} (${bytes} bytes)`);
  return { public_url: pub.publicUrl, storage_path: storagePath, bytes };
}

module.exports = {
  generateSoraVideo,
  pollSoraVideo,
  fetchSoraVideoBytes,
  uploadSoraToStorage,
  SoraInvalidParamError,
  SORA_MODEL,
  SORA_SIZE,
  SORA_SECONDS,
};
