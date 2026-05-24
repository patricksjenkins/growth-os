/**
 * Growth OS — Email Agent API Routes
 * Scale-tier: inbox monitoring, AI classification, auto-response, owner approval queue
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { requireModule } = require('../../core/modules');
const { EmailAgent } = require('../../core/email-agent');
const { getServiceClient } = require('../../db/client');

const agent = new EmailAgent();

// V1 hardening (2026-05-24): the OAuth `state` parameter used to be a
// plain base64-encoded JSON blob. Anyone could craft a state for any
// tenant and finish an OAuth flow that bound the attacker's Gmail to a
// victim's tenant. We now sign the state with HMAC-SHA256 keyed off
// OAUTH_STATE_SECRET (an env var) and reject any callback whose state
// doesn't verify or has expired (10-min TTL).
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
function getOauthStateSecret() {
  const secret = process.env.OAUTH_STATE_SECRET;
  if (!secret || secret.length < 32) {
    // Fall back to SUPABASE_SERVICE_ROLE_KEY which we know is set and is
    // already high-entropy. Logging a warning makes the misconfiguration
    // visible without breaking the OAuth flow.
    console.warn('[email-agent] OAUTH_STATE_SECRET missing or short; falling back to service role key for HMAC');
    return process.env.SUPABASE_SERVICE_ROLE_KEY || 'INSECURE_FALLBACK_DO_NOT_USE_IN_PROD';
  }
  return secret;
}
function signOauthState(payload) {
  const body = Buffer.from(JSON.stringify({ ...payload, iat: Date.now() })).toString('base64url');
  const sig = crypto
    .createHmac('sha256', getOauthStateSecret())
    .update(body)
    .digest('base64url');
  return `${body}.${sig}`;
}
function verifyOauthState(stateStr) {
  if (typeof stateStr !== 'string' || !stateStr.includes('.')) return null;
  const [body, sig] = stateStr.split('.', 2);
  if (!body || !sig) return null;
  const expected = crypto
    .createHmac('sha256', getOauthStateSecret())
    .update(body)
    .digest('base64url');
  // Constant-time compare to avoid timing leak.
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let parsed;
  try { parsed = JSON.parse(Buffer.from(body, 'base64url').toString()); }
  catch { return null; }
  if (!parsed.iat || Date.now() - parsed.iat > OAUTH_STATE_TTL_MS) return null;
  return parsed;
}

// All routes require email_agent module
router.use(requireModule('email_agent'));

// V1 hardening (2026-05-24): every handler in this router previously read
// the tenant from req.params.tenantId without verifying it matched
// req.tenantId (set by tenantMiddleware from the JWT). An authenticated user
// on tenant A could read tenant B's emails just by changing the URL.
//
// This middleware enforces the match. The :tenantId URL parameter is left
// in the routes only for backwards-compat with the existing mobile + web
// callers; if it doesn't match the JWT-derived tenant, we 403.
function enforceTenantMatch(req, res, next) {
  const urlTenant = req.params.tenantId;
  if (urlTenant && req.tenantId && urlTenant !== req.tenantId) {
    return res.status(403).json({
      success: false,
      error: 'Cross-tenant access denied. URL tenant_id does not match your session.',
    });
  }
  next();
}
router.use('/messages/:tenantId', enforceTenantMatch);
router.use('/messages/:tenantId/flagged', enforceTenantMatch);
router.use('/stats/:tenantId', enforceTenantMatch);
router.use('/connect/:tenantId', enforceTenantMatch);

// ---------------------------------------------------------------------------
// List Processed Emails
// ---------------------------------------------------------------------------

/**
 * GET /api/email/messages/:tenantId
 * List processed emails — filterable by status, classification, provider
 */
router.get('/messages/:tenantId', async (req, res) => {
  try {
    const db = getServiceClient();
    let query = db
      .from('email_messages')
      .select('*')
      .eq('tenant_id', req.params.tenantId)
      .order('created_at', { ascending: false })
      .limit(parseInt(req.query.limit) || 100);

    if (req.query.status) {
      query = query.eq('response_status', req.query.status);
    }
    if (req.query.classification) {
      query = query.eq('classification', req.query.classification);
    }
    if (req.query.provider) {
      query = query.eq('provider', req.query.provider);
    }

    const { data: messages, error } = await query;
    if (error) throw error;

    res.json({ success: true, messages, count: messages.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Flagged Emails (Owner Approval Queue)
// ---------------------------------------------------------------------------

/**
 * GET /api/email/messages/:tenantId/flagged
 * Get emails needing owner review
 */
router.get('/messages/:tenantId/flagged', async (req, res) => {
  try {
    const messages = await agent.getFlaggedEmails(req.params.tenantId);
    res.json({ success: true, messages, count: messages.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Approve Flagged Email
// ---------------------------------------------------------------------------

/**
 * POST /api/email/messages/:messageId/approve
 * Owner approves the AI-drafted response and sends it
 */
router.post('/messages/:messageId/approve', async (req, res) => {
  try {
    const db = getServiceClient();

    // Get the email to find tenant and provider
    const { data: email, error: fetchErr } = await db
      .from('email_messages')
      .select('tenant_id, provider')
      .eq('id', req.params.messageId)
      .single();

    if (fetchErr || !email) {
      return res.status(404).json({ success: false, error: 'Email not found' });
    }

    // Get provider credentials
    const { data: conn } = await db
      .from('email_connections')
      .select('*')
      .eq('tenant_id', email.tenant_id)
      .eq('provider', email.provider)
      .single();

    if (!conn) {
      return res.status(400).json({ success: false, error: 'Email provider not connected' });
    }

    const result = await agent.approveEmail(req.params.messageId, conn);
    res.json({ success: result.success, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Edit & Send Response
// ---------------------------------------------------------------------------

/**
 * POST /api/email/messages/:messageId/edit
 * Owner edits the response and sends it
 * Body: { response: "edited response text" }
 */
router.post('/messages/:messageId/edit', async (req, res) => {
  try {
    const { response } = req.body;
    if (!response || !response.trim()) {
      return res.status(400).json({ success: false, error: 'Response text is required' });
    }

    const db = getServiceClient();

    const { data: email, error: fetchErr } = await db
      .from('email_messages')
      .select('tenant_id, provider')
      .eq('id', req.params.messageId)
      .single();

    if (fetchErr || !email) {
      return res.status(404).json({ success: false, error: 'Email not found' });
    }

    const { data: conn } = await db
      .from('email_connections')
      .select('*')
      .eq('tenant_id', email.tenant_id)
      .eq('provider', email.provider)
      .single();

    if (!conn) {
      return res.status(400).json({ success: false, error: 'Email provider not connected' });
    }

    const result = await agent.editAndRespond(req.params.messageId, response.trim(), conn);
    res.json({ success: result.success, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Dismiss / Archive Email
// ---------------------------------------------------------------------------

/**
 * POST /api/email/messages/:messageId/dismiss
 * Owner dismisses/archives a flagged email
 */
router.post('/messages/:messageId/dismiss', async (req, res) => {
  try {
    await agent.dismissEmail(req.params.messageId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Email Agent Stats
// ---------------------------------------------------------------------------

/**
 * GET /api/email/stats/:tenantId
 * Email agent stats: processed, auto-responded, leads captured
 */
router.get('/stats/:tenantId', async (req, res) => {
  try {
    const stats = await agent.getStats(req.params.tenantId);
    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// OAuth: Connect Inbox
// ---------------------------------------------------------------------------

/**
 * POST /api/email/connect/:tenantId
 * Initiate OAuth flow for an email provider
 * Body: { provider: "gmail" | "outlook" }
 */
router.post('/connect/:tenantId', async (req, res) => {
  try {
    const { provider } = req.body;
    if (!['gmail', 'outlook'].includes(provider)) {
      return res.status(400).json({ success: false, error: 'Invalid provider. Use: gmail, outlook' });
    }

    const tenantId = req.params.tenantId;
    // Signed + time-limited state — only this server can mint a valid one.
    const state = signOauthState({ tenant_id: tenantId, provider });

    let authUrl;

    if (provider === 'gmail') {
      const scopes = [
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.send',
        'https://www.googleapis.com/auth/gmail.modify',
      ].join(' ');

      authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${process.env.GOOGLE_CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.GOOGLE_REDIRECT_URI || `${process.env.APP_URL}/api/email/callback`)}&response_type=code&scope=${encodeURIComponent(scopes)}&state=${state}&access_type=offline&prompt=consent`;
    } else if (provider === 'outlook') {
      const scopes = [
        'https://graph.microsoft.com/Mail.ReadWrite',
        'https://graph.microsoft.com/Mail.Send',
        'offline_access',
      ].join(' ');

      authUrl = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=${process.env.MICROSOFT_CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.MICROSOFT_REDIRECT_URI || `${process.env.APP_URL}/api/email/callback`)}&response_type=code&scope=${encodeURIComponent(scopes)}&state=${state}`;
    }

    res.json({ success: true, auth_url: authUrl });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// OAuth: Callback
// ---------------------------------------------------------------------------

/**
 * GET /api/email/callback
 * OAuth callback handler — exchanges code for tokens and stores them
 */
router.get('/callback', async (req, res) => {
  try {
    const { code, state, error: oauthError } = req.query;

    if (oauthError) {
      return res.status(400).json({ success: false, error: `OAuth error: ${oauthError}` });
    }

    if (!code || !state) {
      return res.status(400).json({ success: false, error: 'Missing code or state' });
    }

    // Verify signed state — rejects forged or expired callbacks.
    const stateData = verifyOauthState(state);
    if (!stateData) {
      return res.status(400).json({ success: false, error: 'Invalid, forged, or expired state parameter' });
    }
    const { tenant_id, provider } = stateData;

    if (provider === 'gmail') {
      // Exchange code for tokens
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: process.env.GOOGLE_CLIENT_ID,
          client_secret: process.env.GOOGLE_CLIENT_SECRET,
          redirect_uri: process.env.GOOGLE_REDIRECT_URI || `${process.env.APP_URL}/api/email/callback`,
          grant_type: 'authorization_code',
        }),
      });
      const tokenData = await tokenRes.json();

      if (tokenData.error) {
        return res.status(400).json({ success: false, error: tokenData.error_description || tokenData.error });
      }

      // Get user's email address
      const profileRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      const profileData = await profileRes.json();

      await agent.connectInbox(tenant_id, 'gmail', {
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_in: tokenData.expires_in,
        email_address: profileData.emailAddress,
      });
    } else if (provider === 'outlook') {
      // Exchange code for tokens
      const tokenRes = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: process.env.MICROSOFT_CLIENT_ID,
          client_secret: process.env.MICROSOFT_CLIENT_SECRET,
          redirect_uri: process.env.MICROSOFT_REDIRECT_URI || `${process.env.APP_URL}/api/email/callback`,
          grant_type: 'authorization_code',
          scope: 'https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send offline_access',
        }),
      });
      const tokenData = await tokenRes.json();

      if (tokenData.error) {
        return res.status(400).json({ success: false, error: tokenData.error_description || tokenData.error });
      }

      // Get user's email address
      const profileRes = await fetch('https://graph.microsoft.com/v1.0/me', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      const profileData = await profileRes.json();

      await agent.connectInbox(tenant_id, 'outlook', {
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_in: tokenData.expires_in,
        email_address: profileData.mail || profileData.userPrincipalName,
      });
    }

    // Redirect to app with success
    const appUrl = process.env.APP_URL || 'https://app.firstgenautomate.com';
    res.redirect(`${appUrl}/settings/email?connected=${provider}&status=success`);
  } catch (err) {
    const appUrl = process.env.APP_URL || 'https://app.firstgenautomate.com';
    res.redirect(`${appUrl}/settings/email?status=error&message=${encodeURIComponent(err.message)}`);
  }
});

module.exports = router;
