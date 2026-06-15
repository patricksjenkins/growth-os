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
 *   SORA_SECONDS       (optional, default '12' — sora-2-pro on this OpenAI
 *                       account accepts ONLY '4' | '8' | '12'. Public docs
 *                       claim '10'|'15'|'25' but the API rejects those
 *                       with invalid_value here. Higher-tier accounts
 *                       may unlock longer durations.)
 */

require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const { createLogger } = require('../core/logger');
// AI-safety guard + agent context for usage/cost tracking. Defensive requires
// so a missing safety layer can never break a render.
let guard = { afterCall: async () => {} };
try { guard = require('../core/ai-safety/guard'); } catch (_) { /* optional */ }
let getAgentContext = () => ({});
try { ({ getAgentContext } = require('../core/agent-context')); } catch (_) { /* optional */ }
let FGA_TENANT_ID = null;
try { ({ FGA_TENANT_ID } = require('../core/config')); } catch (_) { /* optional */ }

// Estimated Sora cost per second of video (USD). sora-2-pro standard is ~$0.30
// (720p) / $0.50 (1024p) / $0.70 (1080p) per second. We derive from the render
// width unless SORA_COST_PER_SECOND overrides it.
function soraPerSecondRate(size) {
  if (process.env.SORA_COST_PER_SECOND) return Number(process.env.SORA_COST_PER_SECOND);
  const w = parseInt(String(size || '').split('x')[0], 10) || 1024;
  if (w <= 720) return 0.30;
  if (w <= 1024) return 0.50;
  return 0.70;
}

// Public URL of the FGA brand logo staged in Supabase. Used by the
// ffmpeg overlay step to composite a real FGA wordmark as a full-screen
// end-card over the last ~1.5 seconds of every Sora render. Override
// with FGA_LOGO_URL env var if the brand asset moves.
const FGA_LOGO_URL = process.env.FGA_LOGO_URL ||
  'https://ffvezmgvwpohbsbigcdb.supabase.co/storage/v1/object/public/tenant-assets/fga-marketing/_assets/logo.jpeg';

// Background color of the end-card frame behind the logo. Picked to
// match the dark FGA admin theme (midnight blue).
const FGA_LOGO_CARD_BG = process.env.FGA_LOGO_CARD_BG || '#0B1120';

// Default moment to start showing the end-card, in seconds from the
// start of the clip. For a 12-second total render, t=10.5 gives a
// 1.5-second card. Override per-call if needed.
const FGA_LOGO_OVERLAY_START = Number(process.env.FGA_LOGO_OVERLAY_START) || 10.5;

const SORA_BASE = 'https://api.openai.com/v1/videos';
const SORA_MODEL = process.env.SORA_MODEL || 'sora-2-pro';
const SORA_SIZE = process.env.SORA_SIZE || '1024x1792';
const SORA_SECONDS = process.env.SORA_SECONDS || '12';

// Documented-valid sora-2-pro seconds on this account, in descending
// order of preference. Used by the route-handler fallback chain when
// the API rejects the requested value with invalid_value.
const SORA_SECONDS_FALLBACKS = ['12', '8', '4'];

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

  // Record the video generation as an AI usage event with an estimated cost so
  // it shows up on the Usage & Costs ledger (the bulk of media spend). Sora
  // bills on generation, so we record at queue time. Fire-and-forget.
  const effSeconds = Number(data.seconds || seconds) || 0;
  const effSize = data.size || size;
  const estimatedCostUsd = Math.round(effSeconds * soraPerSecondRate(effSize) * 10000) / 10000;
  const ctx = getAgentContext();
  guard.afterCall({
    provider: 'openai', model: data.model || model, operationType: 'video_generation',
    tenantId: opts.tenantId || ctx.tenantId || FGA_TENANT_ID || null,
    agentName: opts.agentName || ctx.agentName || 'marketing-studio',
    isAutomated: opts.isAutomated !== false,
    requestSource: 'integrations/sora.js:generateSoraVideo',
    estimatedCostUsd,
  }, { outcome: 'success' }).catch(() => {});

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
 * Run ffmpeg to overlay a full-screen logo card on the last ~1.5s of
 * an mp4. Designed for the Marketing Studio end-card brand pass.
 *
 * The filter:
 *   1. Scale the logo to fit a 1024x1792 frame, preserve aspect, pad
 *      the remainder with a solid dark FGA brand color (#0B1120).
 *   2. Overlay that card on top of the source video, but ONLY while
 *      t >= startSeconds. The original video plays underneath for
 *      0..startSeconds, then is fully covered for the remainder.
 *
 * Audio is passed through unmodified — Sora's spoken voiceover keeps
 * playing during the end card.
 *
 * Throws if ffmpeg isn't installed (Railway's Dockerfile installs it;
 * local dev needs `brew install ffmpeg`). Caller is expected to catch
 * and fall back to the raw uncomposited mp4.
 */
async function applyFullScreenLogoOverlay(inputPath, logoUrl, outputPath, opts = {}) {
  const log = createLogger('ffmpeg-overlay', 'fga-marketing');
  const startSeconds = Number(opts.startSeconds) || FGA_LOGO_OVERLAY_START;
  const bg = opts.backgroundColor || FGA_LOGO_CARD_BG;
  const W = 1024, H = 1792;

  // Download the logo to /tmp once. ffmpeg can fetch http inputs but
  // local files are more reliable across container restarts.
  const tmpLogo = path.join(os.tmpdir(), `fga-logo-${Date.now()}.jpeg`);
  const resp = await axios.get(logoUrl, { responseType: 'stream', timeout: 30000 });
  if (resp.status >= 400) throw new Error(`Logo fetch failed: ${resp.status}`);
  await pipeline(resp.data, fs.createWriteStream(tmpLogo));

  const filter =
    `[1:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
    `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${bg}[card];` +
    `[0:v][card]overlay=0:0:enable='gte(t,${startSeconds})'[outv]`;

  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-i', inputPath,
    '-i', tmpLogo,
    '-filter_complex', filter,
    '-map', '[outv]',
    '-map', '0:a?',     // pass audio through if present (Sora voiceover)
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'fast',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    '-y',
    outputPath,
  ];

  log.info(`ffmpeg overlay: start=${startSeconds}s bg=${bg} → ${outputPath}`);

  await new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    ff.stderr.on('data', d => stderr += d.toString());
    ff.on('error', err => reject(err));   // typically ENOENT if ffmpeg missing
    ff.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`));
    });
  });

  // Cleanup the staged logo file (the output mp4 stays for the caller).
  fs.unlink(tmpLogo, () => { /* best-effort */ });
}

/**
 * Download the completed Sora mp4, optionally composite an FGA logo
 * end card over the last ~1.5 seconds, and upload to public Supabase
 * Storage. Returns the public URL Buffer can fetch.
 *
 * Why: Buffer's createPost mutation fetches mediaUrls server-side. The
 * OpenAI `/v1/videos/:id/content` endpoint requires Bearer auth, so
 * Buffer would 401. By staging the bytes (with brand overlay) to a
 * public Supabase bucket we hand Buffer a clean public URL with no
 * API key in sight and the real FGA wordmark already baked in.
 *
 * Storage path: tenant-assets/fga-marketing/{draftId}.mp4
 * Cache: 1 year (mp4 is immutable once rendered).
 *
 * The overlay step is best-effort: if ffmpeg is missing or errors, we
 * log a warning and upload the raw Sora mp4 instead. The caller can
 * inspect the return value's `with_overlay` flag.
 *
 * @param {SupabaseClient} db        service-role Supabase client
 * @param {string} videoId           Sora video id (for OpenAI fetch)
 * @param {string} draftId           content_drafts.id (for storage path)
 * @param {Object} [opts]
 * @param {boolean} [opts.skipOverlay]  set true to skip the ffmpeg step
 * @returns {Promise<{ public_url, storage_path, bytes, with_overlay }>}
 */
async function uploadSoraToStorage(db, videoId, draftId, opts = {}) {
  const log = createLogger('sora-upload', 'fga-marketing');

  // 1. Fetch the raw mp4 from OpenAI and write to /tmp.
  const upstream = await fetchSoraVideoBytes(videoId);
  if (upstream.status >= 400) {
    throw new Error(`Failed to fetch Sora content (${upstream.status})`);
  }
  const tmpRaw = path.join(os.tmpdir(), `sora-${draftId}-raw.mp4`);
  await pipeline(upstream.data, fs.createWriteStream(tmpRaw));

  // 2. Apply FGA logo overlay (best-effort).
  let finalPath = tmpRaw;
  let withOverlay = false;
  const tmpOverlaid = path.join(os.tmpdir(), `sora-${draftId}-overlaid.mp4`);
  if (!opts.skipOverlay) {
    try {
      await applyFullScreenLogoOverlay(tmpRaw, FGA_LOGO_URL, tmpOverlaid, opts);
      finalPath = tmpOverlaid;
      withOverlay = true;
      log.success(`FGA brand overlay composited`);
    } catch (e) {
      // ffmpeg missing or filter error — fall back to raw mp4.
      log.warn(`Logo overlay skipped (uploading raw Sora mp4): ${e.message}`);
    }
  }

  // 3. Read final mp4 into a Buffer for Supabase upload.
  const mp4Buffer = fs.readFileSync(finalPath);
  const bytes = mp4Buffer.length;

  // 4. Upload to public Supabase Storage (upsert overwrites prior).
  const storagePath = `fga-marketing/${draftId}.mp4`;
  const { error: upErr } = await db.storage
    .from('tenant-assets')
    .upload(storagePath, mp4Buffer, {
      contentType: 'video/mp4',
      cacheControl: '31536000',  // 1 year
      upsert: true,
    });

  // 5. Cleanup temp files regardless of upload outcome.
  fs.unlink(tmpRaw, () => {});
  if (finalPath !== tmpRaw) fs.unlink(finalPath, () => {});

  if (upErr) {
    throw new Error(`Supabase upload failed: ${upErr.message}`);
  }

  const { data: pub } = db.storage
    .from('tenant-assets')
    .getPublicUrl(storagePath);

  log.success(`Staged Sora mp4 to public storage: ${pub.publicUrl} (${bytes} bytes, overlay=${withOverlay})`);
  return { public_url: pub.publicUrl, storage_path: storagePath, bytes, with_overlay: withOverlay };
}

/**
 * Lazy-generate a poster thumbnail (JPEG) from a public mp4 URL and
 * upload to public Supabase Storage. Used for Buffer video publishes —
 * Buffer's createPost mutation requires a thumbnailUrl for video posts
 * on Instagram/Reels.
 *
 * Storage path: tenant-assets/fga-marketing/{draftId}-thumb.jpg
 * Frame: extracted at t=middle (~half the clip duration) so the
 *        thumbnail shows the bottleneck/lift beat, not the FGA card.
 *
 * @param {SupabaseClient} db
 * @param {string} draftId           used for the storage filename
 * @param {string} videoUrl          public mp4 URL (Supabase Storage)
 * @param {Object} [opts]
 * @param {number} [opts.atSeconds]  override the seek time (default 5.5s)
 * @returns {Promise<{ public_url, storage_path, bytes }>}
 */
async function generateAndUploadThumbnail(db, draftId, videoUrl, opts = {}) {
  const log = createLogger('sora-thumb', 'fga-marketing');
  const atSeconds = Number(opts.atSeconds) || 5.5;
  const tmpVideo = path.join(os.tmpdir(), `sora-${draftId}-thumbsrc.mp4`);
  const tmpThumb = path.join(os.tmpdir(), `sora-${draftId}-thumb.jpg`);

  // Download the mp4 to /tmp (ffmpeg with -ss on http inputs is much
  // slower than seeking a local file).
  const resp = await axios.get(videoUrl, { responseType: 'stream', timeout: 60000 });
  if (resp.status >= 400) throw new Error(`Thumb source fetch failed: ${resp.status}`);
  await pipeline(resp.data, fs.createWriteStream(tmpVideo));

  // Extract one JPEG frame at t=atSeconds.
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-ss', String(atSeconds),
    '-i', tmpVideo,
    '-frames:v', '1',
    '-q:v', '2',         // high quality JPEG (1-31, lower is better)
    '-y', tmpThumb,
  ];
  log.info(`ffmpeg thumb: frame@${atSeconds}s → ${tmpThumb}`);
  await new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    ff.stderr.on('data', d => stderr += d.toString());
    ff.on('error', err => reject(err));
    ff.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg thumb exited ${code}: ${stderr.slice(-300)}`));
    });
  });

  // Upload thumbnail to Supabase.
  const buf = fs.readFileSync(tmpThumb);
  const storagePath = `fga-marketing/${draftId}-thumb.jpg`;
  const { error: upErr } = await db.storage
    .from('tenant-assets')
    .upload(storagePath, buf, {
      contentType: 'image/jpeg',
      cacheControl: '31536000',
      upsert: true,
    });

  // Cleanup temp files.
  fs.unlink(tmpVideo, () => {});
  fs.unlink(tmpThumb, () => {});

  if (upErr) throw new Error(`Thumb upload failed: ${upErr.message}`);
  const { data: pub } = db.storage.from('tenant-assets').getPublicUrl(storagePath);
  log.success(`Thumbnail staged: ${pub.publicUrl} (${buf.length} bytes)`);
  return { public_url: pub.publicUrl, storage_path: storagePath, bytes: buf.length };
}

module.exports = {
  generateSoraVideo,
  pollSoraVideo,
  fetchSoraVideoBytes,
  uploadSoraToStorage,
  generateAndUploadThumbnail,
  SoraInvalidParamError,
  SORA_MODEL,
  SORA_SIZE,
  SORA_SECONDS,
  SORA_SECONDS_FALLBACKS,
};
