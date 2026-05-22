/**
 * Growth OS — Admin Marketing Video Stream Proxy
 *
 * Single route: GET /api/admin-marketing-stream/:draftId?token=<supabase_jwt>
 *
 * Why a separate file from admin-marketing.js? Because <video src="..."> and
 * <a href="..." download> can only send a GET request — no Bearer header.
 * So the normal authMiddleware + adminMiddleware chain doesn't work. We
 * accept the Supabase access token as a query param and validate it
 * inline. The mount in server.js skips both middlewares.
 *
 * Security model:
 *   1. Token must be a valid Supabase JWT (verified via supabase.auth.getUser)
 *   2. Token's user.role must equal 'owner'
 *   3. Token's user.email must be in the ADMIN_EMAILS allowlist
 *   4. Draft must exist with content_type='video_promo' on the FGA tenant
 *   5. Only the Veo Files API URL stored on that draft is fetched —
 *      the request body cannot influence the upstream URL.
 *
 * Server-side fetches the Veo URL with GOOGLE_API_KEY appended,
 * streams the bytes back. Browser never sees the API key.
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');
const { getServiceClient } = require('../../db/client');
const { createLogger } = require('../../core/logger');

const log = createLogger('admin-marketing-stream');

const FGA_TENANT_ID = process.env.FGA_TENANT_ID || '30566ed6-026a-45e1-9502-029e6219df31';

const DEFAULT_ADMIN_EMAILS = [
  'owner@firstgenautomate.com',
  'patrick@firstgenautomate.com',
  'info@firstgenautomate.com',
];
function getAdminEmails() {
  const fromEnv = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
  return fromEnv.length ? fromEnv : DEFAULT_ADMIN_EMAILS.map(s => s.toLowerCase());
}

router.get('/:draftId', async (req, res) => {
  const token = String(req.query.token || '').trim();
  if (!token) {
    return res.status(401).type('text/plain').send('Missing token');
  }

  // Validate the Supabase JWT.
  let user;
  try {
    const supabase = getServiceClient();
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) {
      return res.status(401).type('text/plain').send('Invalid or expired token');
    }
    user = data.user;
  } catch (e) {
    return res.status(401).type('text/plain').send('Auth failed');
  }

  // Enforce platform-owner role.
  const role = user.app_metadata?.role || user.user_metadata?.role;
  const email = (user.email || '').toLowerCase();
  if (role !== 'owner' || !getAdminEmails().includes(email)) {
    return res.status(403).type('text/plain').send('Forbidden');
  }

  // Resolve the draft and the Veo file URL it points at.
  const db = getServiceClient();
  const { data: draft, error: dErr } = await db
    .from('content_drafts')
    .select('id, campaign_payload')
    .eq('id', req.params.draftId)
    .eq('tenant_id', FGA_TENANT_ID)
    .eq('content_type', 'video_promo')
    .maybeSingle();
  if (dErr) {
    return res.status(500).type('text/plain').send(dErr.message);
  }
  if (!draft) {
    return res.status(404).type('text/plain').send('Draft not found');
  }
  const veoUrl = draft.campaign_payload?.veo?.video_url || null;
  if (!veoUrl) {
    return res.status(409).type('text/plain').send('No video URL on draft yet');
  }

  // Append the API key for the upstream fetch. The key is server-only.
  let upstreamUrl;
  try {
    const u = new URL(veoUrl);
    // For generativelanguage.googleapis.com Files API, the alt=media query
    // param controls "stream bytes vs metadata". We pass through any
    // existing query params from Veo's response and ADD the key.
    u.searchParams.set('key', process.env.GOOGLE_API_KEY || '');
    if (!u.searchParams.has('alt')) u.searchParams.set('alt', 'media');
    upstreamUrl = u.toString();
  } catch (_) {
    return res.status(500).type('text/plain').send('Malformed video URL on draft');
  }

  // Stream the bytes back.
  let upstream;
  try {
    upstream = await axios.get(upstreamUrl, {
      responseType: 'stream',
      timeout: 90000,
      validateStatus: () => true,
    });
  } catch (e) {
    log.error(`Upstream Veo fetch failed: ${e.message}`);
    return res.status(502).type('text/plain').send('Upstream fetch failed');
  }
  if (upstream.status >= 400) {
    log.warn(`Upstream returned ${upstream.status} for draft ${draft.id}`);
    return res.status(upstream.status).type('text/plain').send('Upstream error');
  }

  // Pass through Content-Type so <video> can pick the right decoder.
  const ct = upstream.headers['content-type'] || 'video/mp4';
  res.setHeader('Content-Type', ct);
  if (upstream.headers['content-length']) {
    res.setHeader('Content-Length', upstream.headers['content-length']);
  }
  // Frontend uses ?download=1 to force the browser's download dialog;
  // otherwise the response is inline so the <video> element streams it.
  if (req.query.download === '1') {
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="fga-promo-${String(draft.id).slice(0, 8)}.mp4"`
    );
  }
  // Cache for an hour — same window as a Supabase access token. The
  // token rotates faster than Veo files expire anyway.
  res.setHeader('Cache-Control', 'private, max-age=3600');

  upstream.data.on('error', err => {
    log.warn(`Stream pipe error for draft ${draft.id}: ${err.message}`);
    try { res.end(); } catch { /* ignore */ }
  });
  upstream.data.pipe(res);
});

module.exports = router;
