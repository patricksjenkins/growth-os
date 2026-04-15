/**
 * Growth OS — Social Engagement Agent
 * Scale-tier module: monitors social media comments, auto-likes, classifies,
 * and responds intelligently via Claude AI.
 *
 * Supported platforms: Facebook, Instagram (Meta Graph API), TikTok
 * Volume limit: 300 responses/month per Scale-tier tenant
 */

const { getServiceClient } = require('../db/client');
const { createLogger } = require('./logger');
const { askClaudeJSON, askClaude } = require('../integrations/claude');
const { isModuleEnabled } = require('./modules');

const log = createLogger('social-engagement');

const SCALE_TIER_MONTHLY_LIMIT = 300;
const META_GRAPH_BASE = 'https://graph.facebook.com/v19.0';
const TIKTOK_API_BASE = 'https://open.tiktokapis.com/v2';

// ---------------------------------------------------------------------------
// SocialEngagementAgent
// ---------------------------------------------------------------------------

class SocialEngagementAgent {
  constructor() {
    this.db = getServiceClient();
  }

  // -------------------------------------------------------------------------
  // Process All Tenants
  // -------------------------------------------------------------------------

  /**
   * Main entry point — iterate Scale-tier tenants and process their comments
   */
  async processAllTenants() {
    const { data: tenants, error } = await this.db
      .from('tenants')
      .select('id, business_name, slug, tier, modules, config')
      .eq('status', 'active')
      .eq('tier', 'scale');

    if (error) {
      log.error('Failed to fetch Scale-tier tenants', error);
      return { processed: 0, errors: [] };
    }

    const results = { processed: 0, errors: [] };

    for (const tenant of tenants || []) {
      if (!isModuleEnabled(tenant, 'social_engagement')) continue;

      try {
        await this.processTenant(tenant);
        results.processed++;
      } catch (err) {
        log.error(`Failed to process tenant ${tenant.slug}`, err);
        results.errors.push({ tenant_id: tenant.id, slug: tenant.slug, error: err.message });
      }
    }

    log.info('Social engagement run complete', results);
    return results;
  }

  /**
   * Process a single tenant's social comments across all connected platforms
   */
  async processTenant(tenant) {
    const tenantLog = createLogger('social-engagement', tenant.slug);
    const tenantConfig = this._buildTenantConfig(tenant);

    // Get connected platforms
    const { data: connections } = await this.db
      .from('social_platform_connections')
      .select('*')
      .eq('tenant_id', tenant.id);

    if (!connections || connections.length === 0) {
      tenantLog.info('No social platforms connected — skipping');
      return;
    }

    for (const conn of connections) {
      try {
        // Refresh token if needed
        const credentials = await this._ensureValidToken(conn);

        // Poll for new comments
        const comments = await this.pollComments(tenant.id, conn.platform, credentials);
        tenantLog.info(`Found ${comments.length} new comments on ${conn.platform}`);

        // Process each comment
        for (const comment of comments) {
          await this.handleComment(comment, tenantConfig, credentials);
        }
      } catch (err) {
        tenantLog.error(`Error processing ${conn.platform}`, err);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Poll Comments
  // -------------------------------------------------------------------------

  /**
   * Poll for new comments on a tenant's posts for a specific platform
   */
  async pollComments(tenantId, platform, credentials) {
    let rawComments = [];

    if (platform === 'facebook' || platform === 'instagram') {
      rawComments = await this._pollMetaComments(platform, credentials);
    } else if (platform === 'tiktok') {
      rawComments = await this._pollTikTokComments(credentials);
    }

    // Filter out already-processed comments
    const newComments = [];
    for (const comment of rawComments) {
      const { data: existing } = await this.db
        .from('social_comments')
        .select('id')
        .eq('tenant_id', tenantId)
        .eq('platform', platform)
        .eq('comment_id', comment.comment_id)
        .maybeSingle();

      if (!existing) {
        // Insert as pending
        const { data: inserted } = await this.db
          .from('social_comments')
          .insert({
            tenant_id: tenantId,
            platform,
            post_id: comment.post_id,
            comment_id: comment.comment_id,
            parent_comment_id: comment.parent_comment_id || null,
            author_name: comment.author_name,
            author_id: comment.author_id,
            content: comment.content,
            response_status: 'pending',
          })
          .select()
          .single();

        if (inserted) newComments.push(inserted);
      }
    }

    return newComments;
  }

  /**
   * Poll Meta Graph API for comments on Facebook/Instagram posts
   */
  async _pollMetaComments(platform, credentials) {
    const comments = [];
    const { access_token, page_id } = credentials;

    try {
      // Get recent posts
      const postsEndpoint = platform === 'instagram'
        ? `${META_GRAPH_BASE}/${page_id}/media?fields=id,caption,timestamp&limit=10&access_token=${access_token}`
        : `${META_GRAPH_BASE}/${page_id}/posts?fields=id,message,created_time&limit=10&access_token=${access_token}`;

      const postsRes = await fetch(postsEndpoint);
      const postsData = await postsRes.json();

      if (postsData.error) {
        throw new Error(`Meta API error: ${postsData.error.message}`);
      }

      for (const post of postsData.data || []) {
        // Get comments on each post
        const commentsEndpoint = `${META_GRAPH_BASE}/${post.id}/comments?fields=id,from,message,timestamp&limit=50&access_token=${access_token}`;
        const commentsRes = await fetch(commentsEndpoint);
        const commentsData = await commentsRes.json();

        for (const c of commentsData.data || []) {
          comments.push({
            post_id: post.id,
            comment_id: c.id,
            author_name: c.from?.name || 'Unknown',
            author_id: c.from?.id || null,
            content: c.message || '',
            parent_comment_id: null,
          });
        }
      }
    } catch (err) {
      log.error(`Meta API poll failed for ${platform}`, err);
    }

    return comments;
  }

  /**
   * Poll TikTok API for comments on videos
   */
  async _pollTikTokComments(credentials) {
    const comments = [];
    const { access_token } = credentials;

    try {
      // List user's videos
      const videosRes = await fetch(`${TIKTOK_API_BASE}/video/list/`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ max_count: 10 }),
      });
      const videosData = await videosRes.json();

      for (const video of videosData.data?.videos || []) {
        // Get comments for each video
        const commentsRes = await fetch(`${TIKTOK_API_BASE}/comment/list/`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            video_id: video.id,
            max_count: 50,
          }),
        });
        const commentsData = await commentsRes.json();

        for (const c of commentsData.data?.comments || []) {
          comments.push({
            post_id: video.id,
            comment_id: c.id,
            author_name: c.user?.display_name || 'Unknown',
            author_id: c.user?.user_id || null,
            content: c.text || '',
            parent_comment_id: c.parent_comment_id || null,
          });
        }
      }
    } catch (err) {
      log.error('TikTok API poll failed', err);
    }

    return comments;
  }

  // -------------------------------------------------------------------------
  // Classify Comment
  // -------------------------------------------------------------------------

  /**
   * Use Claude to classify a comment
   * @returns {{ classification: string, confidence: number }}
   */
  async classifyComment(comment, tenantConfig) {
    const systemPrompt = `You are a social media comment classifier for a ${tenantConfig.vertical || 'local'} business called "${tenantConfig.business_name}".

Classify the following comment into exactly one category:
- lead: Someone expressing interest in the business's services, asking about pricing, availability, or wanting to hire/book
- compliment: Positive feedback, praise, congratulations, or general support
- question: A neutral question about the business, process, or services (not a buying signal)
- negative: Complaints, negative feedback, criticism, or dissatisfaction
- spam: Irrelevant content, self-promotion, bots, or scam messages

Respond with JSON: { "classification": "<category>", "confidence": <0.0-1.0>, "reasoning": "<brief explanation>" }`;

    const userMessage = `Comment by "${comment.author_name}": "${comment.content}"`;

    try {
      const result = await askClaudeJSON(systemPrompt, userMessage, {
        tenantSlug: tenantConfig.slug,
        maxTokens: 256,
      });

      return {
        classification: result.classification,
        confidence: Math.min(1, Math.max(0, result.confidence || 0.8)),
        reasoning: result.reasoning || '',
      };
    } catch (err) {
      log.error('Comment classification failed', err);
      return { classification: 'question', confidence: 0.5, reasoning: 'Classification failed — defaulting' };
    }
  }

  // -------------------------------------------------------------------------
  // Generate Response
  // -------------------------------------------------------------------------

  /**
   * Use Claude to draft a response in the business's voice
   */
  async generateResponse(comment, classification, tenantConfig) {
    const voiceGuidance = tenantConfig.brand_voice
      ? `Voice/tone: ${tenantConfig.brand_voice}`
      : 'Voice/tone: Professional, friendly, and helpful. Keep it conversational.';

    const systemPrompt = `You are a social media manager for "${tenantConfig.business_name}", a ${tenantConfig.vertical || 'local'} business.

${voiceGuidance}

Rules:
- Keep responses short (1-3 sentences max for social media)
- Be genuine and human — no corporate speak
- For leads: express enthusiasm and invite them to DM or call
- For compliments: thank them warmly
- For questions: answer helpfully and invite follow-up
- Never be defensive or argumentative
- Include a call-to-action when appropriate
- Do NOT use hashtags in replies
- Do NOT start with "Hey!" every time — vary your openers`;

    const userMessage = `The following comment was classified as "${classification}".

Comment by "${comment.author_name}" on ${comment.platform}:
"${comment.content}"

Draft a reply:`;

    try {
      const response = await askClaude(systemPrompt, userMessage, {
        tenantSlug: tenantConfig.slug,
        maxTokens: 256,
        temperature: 0.8,
      });

      return response.trim().replace(/^["']|["']$/g, '');
    } catch (err) {
      log.error('Response generation failed', err);
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Like Comment
  // -------------------------------------------------------------------------

  /**
   * Auto-like a comment via platform API
   */
  async likeComment(platform, commentId, credentials) {
    try {
      if (platform === 'facebook' || platform === 'instagram') {
        const res = await fetch(`${META_GRAPH_BASE}/${commentId}/likes`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ access_token: credentials.access_token }),
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error.message);
        return { success: true };
      }

      if (platform === 'tiktok') {
        // TikTok API does not currently support liking comments programmatically
        // but we track the intent for when it becomes available
        log.info(`TikTok comment like not supported via API — skipping ${commentId}`);
        return { success: false, reason: 'not_supported' };
      }

      return { success: false, reason: 'unknown_platform' };
    } catch (err) {
      log.error(`Failed to like comment ${commentId} on ${platform}`, err);
      return { success: false, reason: err.message };
    }
  }

  // -------------------------------------------------------------------------
  // Respond to Comment
  // -------------------------------------------------------------------------

  /**
   * Post a reply to a comment via platform API
   */
  async respondToComment(platform, commentId, response, credentials) {
    try {
      if (platform === 'facebook' || platform === 'instagram') {
        const res = await fetch(`${META_GRAPH_BASE}/${commentId}/replies`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: response,
            access_token: credentials.access_token,
          }),
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error.message);
        return { success: true, reply_id: data.id };
      }

      if (platform === 'tiktok') {
        const res = await fetch(`${TIKTOK_API_BASE}/comment/reply/`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${credentials.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            comment_id: commentId,
            text: response,
          }),
        });
        const data = await res.json();
        if (data.error) throw new Error(JSON.stringify(data.error));
        return { success: true, reply_id: data.data?.comment_id };
      }

      return { success: false, reason: 'unknown_platform' };
    } catch (err) {
      log.error(`Failed to respond to comment ${commentId} on ${platform}`, err);
      return { success: false, reason: err.message };
    }
  }

  /**
   * Hide a comment via platform API (for spam)
   */
  async hideComment(platform, commentId, credentials) {
    try {
      if (platform === 'facebook' || platform === 'instagram') {
        const res = await fetch(`${META_GRAPH_BASE}/${commentId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            is_hidden: true,
            access_token: credentials.access_token,
          }),
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error.message);
        return { success: true };
      }

      // TikTok: no hide API — just track it
      log.info(`TikTok comment hide not supported — flagging ${commentId}`);
      return { success: false, reason: 'not_supported' };
    } catch (err) {
      log.error(`Failed to hide comment ${commentId} on ${platform}`, err);
      return { success: false, reason: err.message };
    }
  }

  // -------------------------------------------------------------------------
  // Handle Comment — Orchestrator
  // -------------------------------------------------------------------------

  /**
   * Full pipeline: like -> classify -> route (auto-respond / flag / hide)
   */
  async handleComment(comment, tenantConfig, credentials) {
    const tenantLog = createLogger('social-engagement', tenantConfig.slug);
    const tenantId = comment.tenant_id;

    try {
      // Step 1: Auto-like
      const likeResult = await this.likeComment(comment.platform, comment.comment_id, credentials);
      if (likeResult.success) {
        await this.db.from('social_comments').update({ liked: true }).eq('id', comment.id);
        await this._logAction(tenantId, 'like', comment.platform, comment.comment_id, { success: true });
      }

      // Step 2: Classify
      const { classification, confidence } = await this.classifyComment(comment, tenantConfig);
      await this.db
        .from('social_comments')
        .update({ classification, confidence_score: confidence })
        .eq('id', comment.id);
      await this._logAction(tenantId, 'classify', comment.platform, comment.comment_id, { classification, confidence });

      tenantLog.info(`Comment ${comment.comment_id}: ${classification} (${(confidence * 100).toFixed(0)}%)`);

      // Step 3: Route based on classification
      if (classification === 'spam') {
        // Hide spam
        await this.hideComment(comment.platform, comment.comment_id, credentials);
        await this.db.from('social_comments').update({ response_status: 'hidden' }).eq('id', comment.id);
        await this._logAction(tenantId, 'hide', comment.platform, comment.comment_id, { reason: 'spam' });
        return;
      }

      if (classification === 'negative') {
        // Flag for owner review — do not auto-respond
        const draftResponse = await this.generateResponse(comment, classification, tenantConfig);
        await this.db
          .from('social_comments')
          .update({
            response_text: draftResponse,
            response_status: 'flagged',
          })
          .eq('id', comment.id);
        await this._logAction(tenantId, 'flag', comment.platform, comment.comment_id, {
          reason: 'negative_comment',
          draft_response: draftResponse,
        });
        tenantLog.warn(`Flagged negative comment for review: ${comment.comment_id}`);
        return;
      }

      // Check volume limit before auto-responding
      const withinLimit = await this.checkVolumeLimit(tenantId);
      if (!withinLimit) {
        tenantLog.warn(`Monthly response limit reached for tenant ${tenantId}`);
        await this.db.from('social_comments').update({ response_status: 'flagged' }).eq('id', comment.id);
        return;
      }

      // Auto-respond to lead, compliment, question
      const response = await this.generateResponse(comment, classification, tenantConfig);
      if (!response) {
        tenantLog.warn(`No response generated for comment ${comment.comment_id}`);
        return;
      }

      const replyResult = await this.respondToComment(comment.platform, comment.comment_id, response, credentials);

      if (replyResult.success) {
        await this.db
          .from('social_comments')
          .update({
            response_text: response,
            response_status: 'auto_responded',
            responded_at: new Date().toISOString(),
          })
          .eq('id', comment.id);
        await this._logAction(tenantId, 'respond', comment.platform, comment.comment_id, {
          response,
          reply_id: replyResult.reply_id,
        });
      }

      // Step 4: If lead, capture into CRM
      if (classification === 'lead') {
        await this._captureLead(comment, tenantConfig);
      }
    } catch (err) {
      tenantLog.error(`Error handling comment ${comment.comment_id}`, err);
    }
  }

  // -------------------------------------------------------------------------
  // Volume Limit
  // -------------------------------------------------------------------------

  /**
   * Check if tenant is within their monthly response limit
   */
  async checkVolumeLimit(tenantId) {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const { count, error } = await this.db
      .from('social_comments')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .eq('response_status', 'auto_responded')
      .gte('responded_at', startOfMonth.toISOString());

    if (error) {
      log.error('Volume limit check failed', error);
      return true; // Fail open
    }

    return (count || 0) < SCALE_TIER_MONTHLY_LIMIT;
  }

  /**
   * Get current usage for the month
   */
  async getMonthlyUsage(tenantId) {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const { count } = await this.db
      .from('social_comments')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .eq('response_status', 'auto_responded')
      .gte('responded_at', startOfMonth.toISOString());

    return {
      used: count || 0,
      limit: SCALE_TIER_MONTHLY_LIMIT,
      remaining: Math.max(0, SCALE_TIER_MONTHLY_LIMIT - (count || 0)),
    };
  }

  // -------------------------------------------------------------------------
  // Lead Capture
  // -------------------------------------------------------------------------

  /**
   * Auto-capture a lead comment into the CRM leads table
   */
  async _captureLead(comment, tenantConfig) {
    try {
      const { data: lead, error } = await this.db
        .from('leads')
        .insert({
          tenant_id: comment.tenant_id,
          name: comment.author_name,
          lead_source: `social_${comment.platform}`,
          source_detail: `Comment on post ${comment.post_id}`,
          notes: `Social media comment: "${comment.content}"`,
          status: 'new',
          priority_tier: 'medium',
        })
        .select()
        .single();

      if (error) throw error;

      // Link lead to the comment
      await this.db
        .from('social_comments')
        .update({ lead_id: lead.id })
        .eq('id', comment.id);

      await this._logAction(comment.tenant_id, 'lead_capture', comment.platform, comment.comment_id, {
        lead_id: lead.id,
        author_name: comment.author_name,
      });

      log.success(`Lead captured from ${comment.platform} comment: ${comment.author_name}`);
      return lead;
    } catch (err) {
      log.error('Lead capture from social comment failed', err);
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Token Management
  // -------------------------------------------------------------------------

  /**
   * Ensure the OAuth token is still valid; refresh if expired
   */
  async _ensureValidToken(connection) {
    const now = new Date();
    const expiresAt = connection.expires_at ? new Date(connection.expires_at) : null;

    // If token is not expired (with 5 min buffer), return as-is
    if (!expiresAt || expiresAt > new Date(now.getTime() + 5 * 60 * 1000)) {
      return connection;
    }

    // Refresh the token
    log.info(`Refreshing ${connection.platform} token for tenant ${connection.tenant_id}`);

    if (connection.platform === 'facebook' || connection.platform === 'instagram') {
      return await this._refreshMetaToken(connection);
    } else if (connection.platform === 'tiktok') {
      return await this._refreshTikTokToken(connection);
    }

    return connection;
  }

  async _refreshMetaToken(connection) {
    try {
      const res = await fetch(
        `${META_GRAPH_BASE}/oauth/access_token?grant_type=fb_exchange_token&client_id=${process.env.META_APP_ID}&client_secret=${process.env.META_APP_SECRET}&fb_exchange_token=${connection.access_token}`
      );
      const data = await res.json();

      if (data.error) throw new Error(data.error.message);

      const expiresAt = new Date(Date.now() + (data.expires_in || 5184000) * 1000);

      await this.db
        .from('social_platform_connections')
        .update({
          access_token: data.access_token,
          expires_at: expiresAt.toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', connection.id);

      return { ...connection, access_token: data.access_token, expires_at: expiresAt.toISOString() };
    } catch (err) {
      log.error('Meta token refresh failed', err);
      return connection;
    }
  }

  async _refreshTikTokToken(connection) {
    try {
      const res = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_key: process.env.TIKTOK_CLIENT_KEY,
          client_secret: process.env.TIKTOK_CLIENT_SECRET,
          grant_type: 'refresh_token',
          refresh_token: connection.refresh_token,
        }),
      });
      const data = await res.json();

      if (data.error) throw new Error(JSON.stringify(data.error));

      const expiresAt = new Date(Date.now() + (data.expires_in || 86400) * 1000);

      await this.db
        .from('social_platform_connections')
        .update({
          access_token: data.access_token,
          refresh_token: data.refresh_token || connection.refresh_token,
          expires_at: expiresAt.toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', connection.id);

      return {
        ...connection,
        access_token: data.access_token,
        refresh_token: data.refresh_token || connection.refresh_token,
        expires_at: expiresAt.toISOString(),
      };
    } catch (err) {
      log.error('TikTok token refresh failed', err);
      return connection;
    }
  }

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  /**
   * Get engagement stats for a tenant
   */
  async getStats(tenantId) {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const [totalRes, respondedRes, flaggedRes, leadsRes, hiddenRes, platformRes] = await Promise.all([
      this.db
        .from('social_comments')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .gte('created_at', startOfMonth.toISOString()),
      this.db
        .from('social_comments')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .eq('response_status', 'auto_responded')
        .gte('created_at', startOfMonth.toISOString()),
      this.db
        .from('social_comments')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .eq('response_status', 'flagged'),
      this.db
        .from('social_comments')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .eq('classification', 'lead')
        .gte('created_at', startOfMonth.toISOString()),
      this.db
        .from('social_comments')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .eq('response_status', 'hidden')
        .gte('created_at', startOfMonth.toISOString()),
      this.db
        .from('social_comments')
        .select('platform', { count: 'exact' })
        .eq('tenant_id', tenantId)
        .gte('created_at', startOfMonth.toISOString()),
    ]);

    const total = totalRes.count || 0;
    const responded = respondedRes.count || 0;

    return {
      tenant_id: tenantId,
      period: 'current_month',
      total_comments: total,
      auto_responded: responded,
      flagged: flaggedRes.count || 0,
      leads_captured: leadsRes.count || 0,
      spam_hidden: hiddenRes.count || 0,
      response_rate: total > 0 ? Math.round((responded / total) * 100) : 0,
      volume_usage: await this.getMonthlyUsage(tenantId),
    };
  }

  // -------------------------------------------------------------------------
  // Approval Queue
  // -------------------------------------------------------------------------

  /**
   * Get flagged comments awaiting owner review
   */
  async getFlaggedComments(tenantId) {
    const { data, error } = await this.db
      .from('social_comments')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('response_status', 'flagged')
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data || [];
  }

  /**
   * Owner approves a flagged comment's draft response — sends it
   */
  async approveComment(commentId, credentials) {
    const { data: comment, error } = await this.db
      .from('social_comments')
      .select('*')
      .eq('id', commentId)
      .single();

    if (error || !comment) throw new Error('Comment not found');
    if (!comment.response_text) throw new Error('No draft response to approve');

    const result = await this.respondToComment(comment.platform, comment.comment_id, comment.response_text, credentials);

    if (result.success) {
      await this.db
        .from('social_comments')
        .update({
          response_status: 'auto_responded',
          responded_at: new Date().toISOString(),
        })
        .eq('id', commentId);

      await this._logAction(comment.tenant_id, 'approve', comment.platform, comment.comment_id, {
        response: comment.response_text,
      });
    }

    return result;
  }

  /**
   * Owner edits the draft and sends a custom response
   */
  async editAndRespond(commentId, editedResponse, credentials) {
    const { data: comment, error } = await this.db
      .from('social_comments')
      .select('*')
      .eq('id', commentId)
      .single();

    if (error || !comment) throw new Error('Comment not found');

    const result = await this.respondToComment(comment.platform, comment.comment_id, editedResponse, credentials);

    if (result.success) {
      await this.db
        .from('social_comments')
        .update({
          response_text: editedResponse,
          response_status: 'auto_responded',
          responded_at: new Date().toISOString(),
        })
        .eq('id', commentId);

      await this._logAction(comment.tenant_id, 'respond', comment.platform, comment.comment_id, {
        response: editedResponse,
        edited: true,
      });
    }

    return result;
  }

  /**
   * Owner dismisses a flagged comment
   */
  async dismissComment(commentId) {
    const { data: comment } = await this.db
      .from('social_comments')
      .select('tenant_id, platform, comment_id')
      .eq('id', commentId)
      .single();

    await this.db
      .from('social_comments')
      .update({ response_status: 'dismissed' })
      .eq('id', commentId);

    if (comment) {
      await this._logAction(comment.tenant_id, 'dismiss', comment.platform, comment.comment_id, {});
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  _buildTenantConfig(tenant) {
    return {
      tenant_id: tenant.id,
      business_name: tenant.business_name,
      slug: tenant.slug,
      vertical: tenant.config?.vertical || tenant.vertical || 'local_business',
      brand_voice: tenant.config?.brand_voice || null,
      modules: tenant.modules || {},
    };
  }

  async _logAction(tenantId, actionType, platform, commentId, details = {}) {
    try {
      await this.db.from('social_engagement_log').insert({
        tenant_id: tenantId,
        action_type: actionType,
        platform,
        comment_id: commentId,
        details,
      });
    } catch (err) {
      log.error('Failed to log social action', err);
    }
  }
}

module.exports = { SocialEngagementAgent };
