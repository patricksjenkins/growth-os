/**
 * Growth OS — Social Engagement API Routes
 * Scale-tier: comment monitoring, classification, auto-response, owner approval queue
 */

const express = require('express');
const router = express.Router();
const { requireModule } = require('../../core/modules');
const { SocialEngagementAgent } = require('../../core/social-engagement');
const { getServiceClient } = require('../../db/client');

const agent = new SocialEngagementAgent();

// All routes require social_engagement module
router.use(requireModule('social_engagement'));

// V1 hardening (2026-05-24): same cross-tenant URL-param fix as
// email-agent.js. Handlers previously trusted req.params.tenantId without
// verifying it matched req.tenantId (set by tenantMiddleware from the JWT).
// Note: the social_engagement module was retired in the 2026-05-17 launch
// swap, so in practice these routes return 403 at requireModule above for
// every tenant. The hardening is here for defense in depth in case the
// module gets re-enabled on any tenant.
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
router.use('/comments/:tenantId', enforceTenantMatch);
router.use('/comments/:tenantId/flagged', enforceTenantMatch);
router.use('/stats/:tenantId', enforceTenantMatch);

// ---------------------------------------------------------------------------
// List Comments
// ---------------------------------------------------------------------------

/**
 * GET /api/social/comments/:tenantId
 * List comments — filterable by status, platform, classification
 */
router.get('/comments/:tenantId', async (req, res) => {
  try {
    const db = getServiceClient();
    let query = db
      .from('social_comments')
      .select('*')
      .eq('tenant_id', req.params.tenantId)
      .order('created_at', { ascending: false })
      .limit(parseInt(req.query.limit) || 100);

    if (req.query.status) {
      query = query.eq('response_status', req.query.status);
    }
    if (req.query.platform) {
      query = query.eq('platform', req.query.platform);
    }
    if (req.query.classification) {
      query = query.eq('classification', req.query.classification);
    }

    const { data: comments, error } = await query;
    if (error) throw error;

    res.json({ success: true, comments, count: comments.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Flagged Comments (Owner Approval Queue)
// ---------------------------------------------------------------------------

/**
 * GET /api/social/comments/:tenantId/flagged
 * Get flagged comments needing owner review
 */
router.get('/comments/:tenantId/flagged', async (req, res) => {
  try {
    const comments = await agent.getFlaggedComments(req.params.tenantId);
    res.json({ success: true, comments, count: comments.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Approve Flagged Comment
// ---------------------------------------------------------------------------

/**
 * POST /api/social/comments/:commentId/approve
 * Owner approves the AI-drafted response and sends it
 */
router.post('/comments/:commentId/approve', async (req, res) => {
  try {
    const db = getServiceClient();

    // Get the comment to find tenant and platform
    const { data: comment, error: fetchErr } = await db
      .from('social_comments')
      .select('tenant_id, platform')
      .eq('id', req.params.commentId)
      .single();

    if (fetchErr || !comment) {
      return res.status(404).json({ success: false, error: 'Comment not found' });
    }

    // Get platform credentials
    const { data: conn } = await db
      .from('social_platform_connections')
      .select('*')
      .eq('tenant_id', comment.tenant_id)
      .eq('platform', comment.platform)
      .single();

    if (!conn) {
      return res.status(400).json({ success: false, error: 'Platform not connected' });
    }

    const result = await agent.approveComment(req.params.commentId, conn);
    res.json({ success: result.success, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Edit & Send Response
// ---------------------------------------------------------------------------

/**
 * POST /api/social/comments/:commentId/edit
 * Owner edits the response and sends it
 * Body: { response: "edited response text" }
 */
router.post('/comments/:commentId/edit', async (req, res) => {
  try {
    const { response } = req.body;
    if (!response || !response.trim()) {
      return res.status(400).json({ success: false, error: 'Response text is required' });
    }

    const db = getServiceClient();

    const { data: comment, error: fetchErr } = await db
      .from('social_comments')
      .select('tenant_id, platform')
      .eq('id', req.params.commentId)
      .single();

    if (fetchErr || !comment) {
      return res.status(404).json({ success: false, error: 'Comment not found' });
    }

    const { data: conn } = await db
      .from('social_platform_connections')
      .select('*')
      .eq('tenant_id', comment.tenant_id)
      .eq('platform', comment.platform)
      .single();

    if (!conn) {
      return res.status(400).json({ success: false, error: 'Platform not connected' });
    }

    const result = await agent.editAndRespond(req.params.commentId, response.trim(), conn);
    res.json({ success: result.success, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Dismiss Flagged Comment
// ---------------------------------------------------------------------------

/**
 * POST /api/social/comments/:commentId/dismiss
 * Owner dismisses a flagged comment (no action taken)
 */
router.post('/comments/:commentId/dismiss', async (req, res) => {
  try {
    await agent.dismissComment(req.params.commentId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Engagement Stats
// ---------------------------------------------------------------------------

/**
 * GET /api/social/stats/:tenantId
 * Engagement stats: comments handled, leads captured, response rate
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
// OAuth: Connect Platform
// ---------------------------------------------------------------------------

/**
 * POST /api/social/connect/:tenantId
 * Initiate OAuth flow for a social platform
 * Body: { platform: "facebook" | "instagram" | "tiktok" }
 */
router.post('/connect/:tenantId', async (req, res) => {
  try {
    const { platform } = req.body;
    if (!['facebook', 'instagram', 'tiktok'].includes(platform)) {
      return res.status(400).json({ success: false, error: 'Invalid platform. Use: facebook, instagram, tiktok' });
    }

    const tenantId = req.params.tenantId;
    const state = Buffer.from(JSON.stringify({ tenant_id: tenantId, platform })).toString('base64url');

    let authUrl;

    if (platform === 'facebook' || platform === 'instagram') {
      const scopes = platform === 'instagram'
        ? 'instagram_basic,instagram_manage_comments,pages_show_list,pages_manage_engagement'
        : 'pages_show_list,pages_read_engagement,pages_manage_engagement,pages_manage_posts';

      authUrl = `https://www.facebook.com/v19.0/dialog/oauth?client_id=${process.env.META_APP_ID}&redirect_uri=${encodeURIComponent(process.env.META_REDIRECT_URI || `${process.env.APP_URL}/api/social/callback`)}&scope=${scopes}&state=${state}&response_type=code`;
    } else if (platform === 'tiktok') {
      authUrl = `https://www.tiktok.com/v2/auth/authorize/?client_key=${process.env.TIKTOK_CLIENT_KEY}&scope=video.list,comment.list,comment.list.manage&response_type=code&redirect_uri=${encodeURIComponent(process.env.TIKTOK_REDIRECT_URI || `${process.env.APP_URL}/api/social/callback`)}&state=${state}`;
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
 * GET /api/social/callback
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

    const { tenant_id, platform } = stateData;
    const db = getServiceClient();

    if (platform === 'facebook' || platform === 'instagram') {
      // Exchange code for access token
      const tokenRes = await fetch(
        `https://graph.facebook.com/v19.0/oauth/access_token?client_id=${process.env.META_APP_ID}&redirect_uri=${encodeURIComponent(process.env.META_REDIRECT_URI || `${process.env.APP_URL}/api/social/callback`)}&client_secret=${process.env.META_APP_SECRET}&code=${code}`
      );
      const tokenData = await tokenRes.json();

      if (tokenData.error) {
        return res.status(400).json({ success: false, error: tokenData.error.message });
      }

      // Exchange for long-lived token
      const longTokenRes = await fetch(
        `https://graph.facebook.com/v19.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${process.env.META_APP_ID}&client_secret=${process.env.META_APP_SECRET}&fb_exchange_token=${tokenData.access_token}`
      );
      const longTokenData = await longTokenRes.json();

      // Get page info
      const pagesRes = await fetch(
        `https://graph.facebook.com/v19.0/me/accounts?access_token=${longTokenData.access_token || tokenData.access_token}`
      );
      const pagesData = await pagesRes.json();
      const page = pagesData.data?.[0]; // Use first page

      const expiresAt = new Date(Date.now() + (longTokenData.expires_in || 5184000) * 1000);

      await db.from('social_platform_connections').upsert({
        tenant_id,
        platform,
        access_token: page?.access_token || longTokenData.access_token || tokenData.access_token,
        page_id: page?.id || null,
        page_name: page?.name || null,
        scopes: (tokenData.scope || '').split(',').filter(Boolean),
        expires_at: expiresAt.toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'tenant_id,platform' });
    } else if (platform === 'tiktok') {
      // Exchange code for access token
      const tokenRes = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_key: process.env.TIKTOK_CLIENT_KEY,
          client_secret: process.env.TIKTOK_CLIENT_SECRET,
          code,
          grant_type: 'authorization_code',
          redirect_uri: process.env.TIKTOK_REDIRECT_URI || `${process.env.APP_URL}/api/social/callback`,
        }),
      });
      const tokenData = await tokenRes.json();

      if (tokenData.error) {
        return res.status(400).json({ success: false, error: JSON.stringify(tokenData.error) });
      }

      const expiresAt = new Date(Date.now() + (tokenData.expires_in || 86400) * 1000);

      await db.from('social_platform_connections').upsert({
        tenant_id,
        platform: 'tiktok',
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        scopes: (tokenData.scope || '').split(',').filter(Boolean),
        expires_at: expiresAt.toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'tenant_id,platform' });
    }

    // Redirect back to the admin Integrations page (the only integrations UI
    // that exists; the old app.firstgenautomate.com fallback was NXDOMAIN and
    // /settings/social was never a real route).
    const appUrl = process.env.APP_URL || 'https://www.firstgenautomate.com';
    res.redirect(`${appUrl}/admin/integrations?connected=${platform}&status=success`);
  } catch (err) {
    const appUrl = process.env.APP_URL || 'https://www.firstgenautomate.com';
    res.redirect(`${appUrl}/admin/integrations?status=error&message=${encodeURIComponent(err.message)}`);
  }
});

module.exports = router;
