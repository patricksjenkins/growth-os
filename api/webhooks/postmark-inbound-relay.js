/**
 * Postmark inbound relay for the 923A Coins Command Center.
 *
 * Why this exists: the 923A inbound-email webhook runs on Vercel, which
 * rejects any request body over ~4.5 MB before the function runs. Factory
 * replies carrying CNC renders and mockups are routinely 5-30 MB as base64
 * JSON, so they were dropped at the door with no trace on our side
 * (Q-0466 2026-08-30, Q-0802 2026-09-10, "we are not receiving the CNC
 * emails" 2026-09-23). Railway has no such ceiling.
 *
 * Flow: Postmark POSTs the full inbound JSON here. Small bodies are forwarded
 * byte-for-byte. Large ones have each attachment's base64 Content moved into
 * Supabase Storage (same project the Command Center uses) and replaced with a
 * short-lived signed ContentUrl; the Vercel webhook fetches those back (its
 * outbound fetch has no size cap) and files them exactly as live mail. Staged
 * files are removed once the upstream call returns.
 *
 * Env (Railway): POSTMARK_RELAY_SECRET   shared with Postmark via ?secret=
 *                FGA_923A_INBOUND_URL    the Command Center webhook (may carry
 *                                        its own ?secret=)
 *                INBOUND_RELAY_SECRET    optional; sent as x-relay-secret so
 *                                        the webhook can trust the relay
 *                                        without the URL secret
 *                POSTMARK_RELAY_BUCKET   staging bucket (default project-proofs)
 */

'use strict';

const express = require('express');
const crypto = require('crypto');
const { createLogger } = require('../../core/logger');
const { getServiceClient } = require('../../db/client');

const router = express.Router();
const log = createLogger('postmark-inbound-relay');

const PASSTHROUGH_BYTES = 3 * 1024 * 1024;   // under Vercel's ceiling with room to spare
const MAX_BODY = '80mb';                      // Postmark caps inbound mail at 35 MB (~47 MB base64)
const SIGNED_URL_TTL_S = 2 * 60 * 60;

function timingEq(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

function safeName(name) {
  return String(name || 'file').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'file';
}

/** A raw body this size or smaller goes straight through untouched. */
function needsStaging(rawLength) {
  return !(Number.isFinite(rawLength) && rawLength > 0 && rawLength <= PASSTHROUGH_BYTES);
}

/**
 * Move every attachment's base64 Content into storage. Pure apart from the
 * injected `upload(path, buffer, contentType)` and `signedUrl(path)` so the
 * mapping is testable without Supabase. Returns the slim payload plus the
 * staged paths for cleanup.
 */
async function stagePayload(payload, { messageId, upload, signedUrl }) {
  const src = Array.isArray(payload && payload.Attachments) ? payload.Attachments : [];
  const slim = [];
  const staged = [];
  let i = 0;
  for (const a of src) {
    if (!a) continue;
    const content = a.Content || a.Data;
    const { Content, Data, ...rest } = a;
    if (!content) { slim.push(rest); continue; }
    const buf = Buffer.from(String(content), 'base64');
    const path = `inbound-relay/${safeName(messageId)}/${i++}-${safeName(a.Name)}`;
    await upload(path, buf, a.ContentType || 'application/octet-stream');
    const url = await signedUrl(path);
    staged.push(path);
    slim.push({ ...rest, ContentLength: buf.length, ContentUrl: url });
  }
  return { slim: { ...payload, Attachments: slim }, staged };
}

function storageDeps(bucket) {
  const supabase = getServiceClient();
  return {
    upload: async (path, buf, contentType) => {
      const { error } = await supabase.storage.from(bucket).upload(path, buf, { contentType, upsert: true });
      if (error) throw new Error(`stage upload ${path}: ${error.message || error}`);
    },
    signedUrl: async (path) => {
      const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, SIGNED_URL_TTL_S);
      if (error || !data || !data.signedUrl) throw new Error(`stage sign ${path}: ${(error && error.message) || 'no url'}`);
      return data.signedUrl;
    },
    remove: async (paths) => {
      if (!paths.length) return;
      const { error } = await supabase.storage.from(bucket).remove(paths);
      if (error) log.warn('stage cleanup failed', { error: error.message || String(error), count: paths.length });
    },
  };
}

router.post('/', express.json({ limit: MAX_BODY, verify: (req, _res, buf) => { req.rawBody = buf; } }), async (req, res) => {
  const expected = process.env.POSTMARK_RELAY_SECRET;
  if (!expected) return res.status(503).json({ error: 'relay not configured' });
  if (!timingEq(req.query.secret, expected)) return res.status(401).json({ error: 'unauthorized' });
  const target = process.env.FGA_923A_INBOUND_URL;
  if (!target) return res.status(503).json({ error: 'FGA_923A_INBOUND_URL not set' });

  const payload = req.body && typeof req.body === 'object' ? req.body : {};
  const messageId = String(payload.MessageID || crypto.randomUUID());
  const rawLength = req.rawBody ? req.rawBody.length : 0;
  const bucket = process.env.POSTMARK_RELAY_BUCKET || 'project-proofs';
  let deps = null;
  let staged = [];
  let body = req.rawBody;

  try {
    if (needsStaging(rawLength)) {
      deps = storageDeps(bucket);
      const out = await stagePayload(payload, { messageId, upload: deps.upload, signedUrl: deps.signedUrl });
      staged = out.staged;
      body = Buffer.from(JSON.stringify(out.slim));
    }
    const headers = { 'Content-Type': 'application/json' };
    if (process.env.INBOUND_RELAY_SECRET) headers['x-relay-secret'] = process.env.INBOUND_RELAY_SECRET;
    const upstream = await fetch(target, { method: 'POST', headers, body, signal: AbortSignal.timeout(55000) });
    const text = await upstream.text();
    log.info('relayed inbound', { messageId, rawLength, staged: staged.length, upstream: upstream.status });
    // A non-2xx from the webhook must surface as non-2xx here so Postmark
    // keeps retrying while whatever broke is fixed.
    return res.status(upstream.ok ? 200 : 502).json({
      ok: upstream.ok, relayed: true, staged: staged.length, upstream: upstream.status, upstream_body: text.slice(0, 500),
    });
  } catch (err) {
    log.error('relay failed', { messageId, rawLength, error: err.message });
    return res.status(502).json({ ok: false, relayed: false, error: err.message });
  } finally {
    if (deps && staged.length) deps.remove(staged).catch(() => {});
  }
});

module.exports = router;
module.exports.stagePayload = stagePayload;
module.exports.needsStaging = needsStaging;
module.exports.PASSTHROUGH_BYTES = PASSTHROUGH_BYTES;
