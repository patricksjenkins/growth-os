/**
 * Growth OS — Email Agent API Routes
 * Scale-tier: inbox monitoring, AI classification, auto-response, owner approval queue
 */

const express = require('express');
const router = express.Router();
const { requireModule } = require('../../core/modules');
const { EmailAgent } = require('../../core/email-agent');
const { getServiceClient } = require('../../db/client');

const agent = new EmailAgent();

// All routes require email_agent module
router.use(requireModule('email_agent'));

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
    const state = Buffer.from(JSON.stringify({ tenant_id: tenantId, provider })).toString('base64url');

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

    // Decode state
    let stateData;
    try {
      stateData = JSON.parse(Buffer.from(state, 'base64url').toString());
    } catch {
      return res.status(400).json({ success: false, error: 'Invalid state parameter' });
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
