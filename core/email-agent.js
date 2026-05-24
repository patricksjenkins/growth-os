/**
 * Growth OS — Email Chief of Staff Agent
 * Scale-tier module: connects to owner's inbox, classifies emails,
 * auto-responds intelligently via Claude AI, and captures leads.
 *
 * Supported providers: Gmail (Google API), Outlook (Microsoft Graph API)
 * Volume limit: 500 responses/month per Scale-tier tenant
 */

const { getServiceClient } = require('../db/client');
const { createLogger } = require('./logger');
const { askClaudeJSON, askClaude } = require('../integrations/claude');
const { isModuleEnabled } = require('./modules');

const log = createLogger('email-agent');

const SCALE_TIER_MONTHLY_LIMIT = 500;
const AUTO_RESPOND_CONFIDENCE_THRESHOLD = 0.9;

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1';
const MS_GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

// ---------------------------------------------------------------------------
// EmailAgent
// ---------------------------------------------------------------------------

class EmailAgent {
  constructor() {
    this.db = getServiceClient();
  }

  // -------------------------------------------------------------------------
  // Process All Tenants
  // -------------------------------------------------------------------------

  /**
   * Main entry point — iterate Scale-tier tenants and process their inboxes
   */
  async processAllTenants() {
    // V1 hardening (2026-05-24): the previous select pulled `modules` and
    // `config` directly off the `tenants` table — those columns don't
    // exist there. They live in separate `tenant_modules` + `tenant_config`
    // tables and get flattened into the tenant object by
    // core/tenant.js#resolveTenant(). Without that flatten step,
    // `isModuleEnabled(tenant, 'email_agent')` ALWAYS returned false and
    // this whole agent loop was a silent no-op.
    const { resolveTenant } = require('./tenant');
    const { data: tenantRows, error } = await this.db
      .from('tenants')
      .select('id, slug, tier')
      .eq('status', 'active')
      .eq('tier', 'scale');

    if (error) {
      log.error('Failed to fetch Scale-tier tenants', error);
      return { processed: 0, errors: [] };
    }

    const results = { processed: 0, errors: [] };

    for (const tenantRow of tenantRows || []) {
      // Resolve full tenant (with modules + config + integrations) so
      // isModuleEnabled works against the flattened object.
      let tenant;
      try {
        tenant = await resolveTenant(this.db, tenantRow.id);
      } catch (resolveErr) {
        log.warn(`resolveTenant failed for ${tenantRow.slug}: ${resolveErr.message}`);
        continue;
      }
      if (!isModuleEnabled(tenant, 'email_agent')) continue;

      try {
        await this.processInbox(tenant.id, tenant);
        results.processed++;
      } catch (err) {
        log.error(`Failed to process inbox for ${tenant.slug}`, err);
        results.errors.push({ tenant_id: tenant.id, slug: tenant.slug, error: err.message });
      }
    }

    log.info('Email agent run complete', results);
    return results;
  }

  // -------------------------------------------------------------------------
  // Connect Inbox
  // -------------------------------------------------------------------------

  /**
   * Store OAuth tokens after completing the OAuth flow
   */
  async connectInbox(tenantId, provider, oauthTokens) {
    const { access_token, refresh_token, expires_in, email_address } = oauthTokens;
    const expiresAt = new Date(Date.now() + (expires_in || 3600) * 1000);

    const { data, error } = await this.db
      .from('email_connections')
      .upsert({
        tenant_id: tenantId,
        provider,
        access_token,
        refresh_token,
        email_address,
        expires_at: expiresAt.toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'tenant_id,provider' })
      .select()
      .single();

    if (error) throw new Error(`Failed to connect inbox: ${error.message}`);

    await this._logAction(tenantId, 'connect', provider, null, { email_address });
    log.success(`Connected ${provider} inbox for tenant ${tenantId}: ${email_address}`);

    return data;
  }

  // -------------------------------------------------------------------------
  // Fetch New Emails
  // -------------------------------------------------------------------------

  /**
   * Fetch unread emails from the connected inbox
   */
  async fetchNewEmails(tenantId) {
    const { data: connections } = await this.db
      .from('email_connections')
      .select('*')
      .eq('tenant_id', tenantId);

    if (!connections || connections.length === 0) {
      log.info(`No email connections for tenant ${tenantId}`);
      return [];
    }

    const allEmails = [];

    for (const conn of connections) {
      const credentials = await this._ensureValidToken(conn);

      try {
        let emails = [];
        if (conn.provider === 'gmail') {
          emails = await this._fetchGmailMessages(credentials);
        } else if (conn.provider === 'outlook') {
          emails = await this._fetchOutlookMessages(credentials);
        }

        // Filter out already-processed messages
        for (const email of emails) {
          const { data: existing } = await this.db
            .from('email_messages')
            .select('id')
            .eq('tenant_id', tenantId)
            .eq('provider', conn.provider)
            .eq('message_id', email.message_id)
            .maybeSingle();

          if (!existing) {
            const { data: inserted } = await this.db
              .from('email_messages')
              .insert({
                tenant_id: tenantId,
                provider: conn.provider,
                message_id: email.message_id,
                thread_id: email.thread_id,
                from_address: email.from_address,
                from_name: email.from_name,
                to_address: email.to_address,
                subject: email.subject,
                body_preview: email.body_preview,
                response_status: 'pending',
              })
              .select()
              .single();

            if (inserted) allEmails.push(inserted);
          }
        }
      } catch (err) {
        log.error(`Error fetching emails from ${conn.provider} for tenant ${tenantId}`, err);
      }
    }

    return allEmails;
  }

  /**
   * Fetch unread messages from Gmail API
   */
  async _fetchGmailMessages(credentials) {
    const { access_token, email_address } = credentials;
    const emails = [];

    try {
      // List unread messages
      const listRes = await fetch(
        `${GMAIL_API_BASE}/users/me/messages?q=is:unread+in:inbox&maxResults=20`,
        { headers: { Authorization: `Bearer ${access_token}` } }
      );
      const listData = await listRes.json();

      if (listData.error) throw new Error(listData.error.message);

      for (const msg of listData.messages || []) {
        // Get full message details
        const msgRes = await fetch(
          `${GMAIL_API_BASE}/users/me/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject`,
          { headers: { Authorization: `Bearer ${access_token}` } }
        );
        const msgData = await msgRes.json();

        const headers = msgData.payload?.headers || [];
        const getHeader = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';

        const fromRaw = getHeader('From');
        const fromMatch = fromRaw.match(/^(.+?)\s*<(.+?)>$/);

        emails.push({
          message_id: msg.id,
          thread_id: msg.threadId,
          from_address: fromMatch ? fromMatch[2] : fromRaw,
          from_name: fromMatch ? fromMatch[1].replace(/"/g, '').trim() : '',
          to_address: getHeader('To'),
          subject: getHeader('Subject'),
          body_preview: msgData.snippet || '',
        });
      }
    } catch (err) {
      log.error('Gmail fetch failed', err);
    }

    return emails;
  }

  /**
   * Fetch unread messages from Microsoft Graph API (Outlook)
   */
  async _fetchOutlookMessages(credentials) {
    const { access_token } = credentials;
    const emails = [];

    try {
      const res = await fetch(
        `${MS_GRAPH_BASE}/me/mailFolders/inbox/messages?$filter=isRead eq false&$top=20&$select=id,conversationId,from,toRecipients,subject,bodyPreview`,
        { headers: { Authorization: `Bearer ${access_token}` } }
      );
      const data = await res.json();

      if (data.error) throw new Error(data.error.message);

      for (const msg of data.value || []) {
        emails.push({
          message_id: msg.id,
          thread_id: msg.conversationId,
          from_address: msg.from?.emailAddress?.address || '',
          from_name: msg.from?.emailAddress?.name || '',
          to_address: msg.toRecipients?.[0]?.emailAddress?.address || '',
          subject: msg.subject || '',
          body_preview: msg.bodyPreview || '',
        });
      }
    } catch (err) {
      log.error('Outlook fetch failed', err);
    }

    return emails;
  }

  // -------------------------------------------------------------------------
  // Classify Email
  // -------------------------------------------------------------------------

  /**
   * Use Claude to classify an email
   * @returns {{ classification: string, confidence: number }}
   */
  async classifyEmail(email, tenantConfig) {
    const systemPrompt = `You are an email assistant for "${tenantConfig.business_name}", a ${tenantConfig.vertical || 'local'} business.

Classify the following email into exactly one category:
- lead_inquiry: Someone asking about services, pricing, wanting to book/hire, or expressing interest in becoming a customer
- customer_question: An existing customer asking about their order, project, timeline, or services they're already receiving
- vendor_solicitation: A vendor, salesperson, or recruiter trying to sell something or pitch a service
- important_personal: A personal or important message from a known contact, partner, or collaborator that needs the owner's direct attention
- spam: Marketing blasts, newsletters the owner didn't sign up for, phishing, or irrelevant bulk messages

Respond with JSON: { "classification": "<category>", "confidence": <0.0-1.0>, "reasoning": "<brief explanation>", "urgency": "low|medium|high" }`;

    const userMessage = `From: ${email.from_name} <${email.from_address}>
Subject: ${email.subject}
Preview: ${email.body_preview}`;

    try {
      const result = await askClaudeJSON(systemPrompt, userMessage, {
        tenantSlug: tenantConfig.slug,
        maxTokens: 256,
      });

      return {
        classification: result.classification,
        confidence: Math.min(1, Math.max(0, result.confidence || 0.7)),
        reasoning: result.reasoning || '',
        urgency: result.urgency || 'low',
      };
    } catch (err) {
      log.error('Email classification failed', err);
      return { classification: 'customer_question', confidence: 0.4, reasoning: 'Classification failed', urgency: 'low' };
    }
  }

  // -------------------------------------------------------------------------
  // Generate Response
  // -------------------------------------------------------------------------

  /**
   * Use Claude to draft an email response in the owner's voice
   */
  async generateEmailResponse(email, classification, tenantConfig) {
    const voiceGuidance = tenantConfig.email_voice
      ? `Voice/tone: ${tenantConfig.email_voice}`
      : tenantConfig.brand_voice
        ? `Voice/tone: ${tenantConfig.brand_voice}`
        : 'Voice/tone: Professional, warm, and concise. Sound like a real person, not a template.';

    const classificationGuidance = {
      lead_inquiry: 'This is a potential new customer. Be enthusiastic, answer their question, and invite them to book a call or get a quote. Include next steps.',
      customer_question: 'This is an existing customer. Be helpful and reassuring. If you do not know the specific answer, acknowledge their question and let them know the owner will follow up.',
      vendor_solicitation: 'Politely decline. Keep it brief — one sentence is fine.',
      important_personal: 'Be warm and personal. Acknowledge the message and let them know the owner will follow up personally.',
    };

    const systemPrompt = `You are the email assistant for "${tenantConfig.business_name}" (${tenantConfig.vertical || 'local business'}).
You draft email replies on behalf of the business owner.

${voiceGuidance}

${classificationGuidance[classification] || 'Respond helpfully.'}

Rules:
- Write in first person as the business owner
- Keep it concise — 3-5 sentences for most responses
- Be genuine and helpful
- Include a clear call-to-action when appropriate
- Sign off with just the first name or business name
- Do NOT include subject lines, just the body
- Do NOT use overly formal language`;

    const userMessage = `Email from ${email.from_name} <${email.from_address}>:
Subject: ${email.subject}
Body: ${email.body_preview}

Draft a reply:`;

    try {
      const response = await askClaude(systemPrompt, userMessage, {
        tenantSlug: tenantConfig.slug,
        maxTokens: 512,
        temperature: 0.7,
      });

      return response.trim();
    } catch (err) {
      log.error('Email response generation failed', err);
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Auto-Respond
  // -------------------------------------------------------------------------

  /**
   * Send auto-response via the appropriate provider
   */
  async autoRespond(email, response, credentials) {
    try {
      if (credentials.provider === 'gmail') {
        return await this._sendGmailReply(email, response, credentials);
      } else if (credentials.provider === 'outlook') {
        return await this._sendOutlookReply(email, response, credentials);
      }
      return { success: false, reason: 'unknown_provider' };
    } catch (err) {
      log.error(`Failed to auto-respond to email ${email.message_id}`, err);
      return { success: false, reason: err.message };
    }
  }

  /**
   * Send a reply via Gmail API
   */
  async _sendGmailReply(email, responseBody, credentials) {
    const { access_token } = credentials;

    // Build RFC 2822 email
    const rawEmail = [
      `To: ${email.from_address}`,
      `Subject: Re: ${email.subject}`,
      `In-Reply-To: ${email.message_id}`,
      `References: ${email.message_id}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      responseBody,
    ].join('\r\n');

    const encodedEmail = Buffer.from(rawEmail).toString('base64url');

    const res = await fetch(`${GMAIL_API_BASE}/users/me/messages/send`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        raw: encodedEmail,
        threadId: email.thread_id,
      }),
    });

    const data = await res.json();
    if (data.error) throw new Error(data.error.message);

    return { success: true, sent_message_id: data.id };
  }

  /**
   * Send a reply via Microsoft Graph API (Outlook)
   */
  async _sendOutlookReply(email, responseBody, credentials) {
    const { access_token } = credentials;

    const res = await fetch(`${MS_GRAPH_BASE}/me/messages/${email.message_id}/reply`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        comment: responseBody,
      }),
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error?.message || `HTTP ${res.status}`);
    }

    return { success: true };
  }

  // -------------------------------------------------------------------------
  // Flag for Review
  // -------------------------------------------------------------------------

  /**
   * Queue an email for owner review in the app
   */
  async flagForReview(email, summary, draftResponse, tenantId) {
    await this.db
      .from('email_messages')
      .update({
        response_text: draftResponse,
        response_status: 'flagged',
        processed_at: new Date().toISOString(),
      })
      .eq('id', email.id);

    await this._logAction(tenantId, 'flag', email.provider, email.message_id, {
      summary,
      draft_response: draftResponse,
    });

    log.info(`Flagged email ${email.message_id} for owner review`);
  }

  // -------------------------------------------------------------------------
  // Process Inbox — Orchestrator
  // -------------------------------------------------------------------------

  /**
   * Full pipeline for a single tenant's inbox
   */
  async processInbox(tenantId, tenant = null) {
    const tenantLog = createLogger('email-agent', tenant?.slug || tenantId);

    // Load tenant if not provided
    if (!tenant) {
      const { data } = await this.db
        .from('tenants')
        .select('id, business_name, slug, tier, modules, config')
        .eq('id', tenantId)
        .single();
      tenant = data;
    }

    if (!tenant) {
      tenantLog.error('Tenant not found');
      return;
    }

    const tenantConfig = this._buildTenantConfig(tenant);

    // Get connections with valid credentials
    const { data: connections } = await this.db
      .from('email_connections')
      .select('*')
      .eq('tenant_id', tenantId);

    if (!connections || connections.length === 0) {
      tenantLog.info('No email connections — skipping');
      return;
    }

    // Fetch new emails
    const newEmails = await this.fetchNewEmails(tenantId);
    tenantLog.info(`Found ${newEmails.length} new emails to process`);

    for (const email of newEmails) {
      try {
        await this._processEmail(email, tenantConfig, connections);
      } catch (err) {
        tenantLog.error(`Error processing email ${email.message_id}`, err);
      }
    }
  }

  /**
   * Process a single email: classify -> route
   */
  async _processEmail(email, tenantConfig, connections) {
    const tenantLog = createLogger('email-agent', tenantConfig.slug);
    const tenantId = email.tenant_id;

    // Step 1: Classify
    const { classification, confidence, urgency } = await this.classifyEmail(email, tenantConfig);
    await this.db
      .from('email_messages')
      .update({
        classification,
        confidence_score: confidence,
        processed_at: new Date().toISOString(),
      })
      .eq('id', email.id);

    await this._logAction(tenantId, 'classify', email.provider, email.message_id, {
      classification,
      confidence,
      urgency,
    });

    tenantLog.info(`Email from ${email.from_address}: ${classification} (${(confidence * 100).toFixed(0)}%, ${urgency})`);

    // Step 2: Route based on classification
    if (classification === 'spam') {
      await this.db
        .from('email_messages')
        .update({ response_status: 'archived' })
        .eq('id', email.id);
      await this._logAction(tenantId, 'archive', email.provider, email.message_id, { reason: 'spam' });
      return;
    }

    if (classification === 'important_personal') {
      // Always flag for owner — never auto-respond to personal messages
      const draft = await this.generateEmailResponse(email, classification, tenantConfig);
      await this.flagForReview(email, `Important message from ${email.from_name}`, draft, tenantId);
      return;
    }

    if (classification === 'vendor_solicitation') {
      // Auto-respond with polite decline if confident
      if (confidence >= AUTO_RESPOND_CONFIDENCE_THRESHOLD) {
        const withinLimit = await this.checkVolumeLimit(tenantId);
        if (withinLimit) {
          const response = await this.generateEmailResponse(email, classification, tenantConfig);
          if (response) {
            const conn = connections.find(c => c.provider === email.provider);
            if (conn) {
              const result = await this.autoRespond(email, response, conn);
              if (result.success) {
                await this.db
                  .from('email_messages')
                  .update({
                    response_text: response,
                    response_status: 'auto_responded',
                  })
                  .eq('id', email.id);
                await this._logAction(tenantId, 'auto_respond', email.provider, email.message_id, {
                  response_preview: response.substring(0, 100),
                });
                return;
              }
            }
          }
        }
      }
      // Fall through to flag if auto-respond failed or low confidence
      await this.db.from('email_messages').update({ response_status: 'archived' }).eq('id', email.id);
      return;
    }

    // lead_inquiry or customer_question
    const response = await this.generateEmailResponse(email, classification, tenantConfig);

    if (confidence >= AUTO_RESPOND_CONFIDENCE_THRESHOLD) {
      // High confidence — auto-respond
      const withinLimit = await this.checkVolumeLimit(tenantId);
      if (withinLimit && response) {
        const conn = connections.find(c => c.provider === email.provider);
        if (conn) {
          const result = await this.autoRespond(email, response, conn);
          if (result.success) {
            await this.db
              .from('email_messages')
              .update({
                response_text: response,
                response_status: 'auto_responded',
              })
              .eq('id', email.id);
            await this._logAction(tenantId, 'auto_respond', email.provider, email.message_id, {
              response_preview: response.substring(0, 100),
            });

            // Capture lead if classified as lead_inquiry
            if (classification === 'lead_inquiry') {
              await this._captureLead(email, tenantConfig);
            }

            return;
          }
        }
      }
    }

    // Low confidence or volume limit reached — flag for review
    await this.flagForReview(
      email,
      `${classification}: ${email.subject}`,
      response,
      tenantId
    );

    // Still capture the lead even if flagged
    if (classification === 'lead_inquiry') {
      await this._captureLead(email, tenantConfig);
    }
  }

  // -------------------------------------------------------------------------
  // Volume Limit
  // -------------------------------------------------------------------------

  /**
   * Check if tenant is within their monthly auto-response limit
   */
  async checkVolumeLimit(tenantId) {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const { count, error } = await this.db
      .from('email_messages')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .eq('response_status', 'auto_responded')
      .gte('processed_at', startOfMonth.toISOString());

    if (error) {
      log.error('Email volume limit check failed', error);
      return true; // Fail open
    }

    return (count || 0) < SCALE_TIER_MONTHLY_LIMIT;
  }

  /**
   * Get current monthly usage
   */
  async getMonthlyUsage(tenantId) {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const { count } = await this.db
      .from('email_messages')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .eq('response_status', 'auto_responded')
      .gte('processed_at', startOfMonth.toISOString());

    return {
      used: count || 0,
      limit: SCALE_TIER_MONTHLY_LIMIT,
      remaining: Math.max(0, SCALE_TIER_MONTHLY_LIMIT - (count || 0)),
    };
  }

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  /**
   * Get email agent stats for a tenant
   */
  async getStats(tenantId) {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const [totalRes, autoRes, flaggedRes, leadsRes, archivedRes] = await Promise.all([
      this.db
        .from('email_messages')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .gte('created_at', startOfMonth.toISOString()),
      this.db
        .from('email_messages')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .eq('response_status', 'auto_responded')
        .gte('created_at', startOfMonth.toISOString()),
      this.db
        .from('email_messages')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .eq('response_status', 'flagged'),
      this.db
        .from('email_messages')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .eq('classification', 'lead_inquiry')
        .gte('created_at', startOfMonth.toISOString()),
      this.db
        .from('email_messages')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .eq('response_status', 'archived')
        .gte('created_at', startOfMonth.toISOString()),
    ]);

    const total = totalRes.count || 0;
    const autoResponded = autoRes.count || 0;

    return {
      tenant_id: tenantId,
      period: 'current_month',
      total_processed: total,
      auto_responded: autoResponded,
      flagged_for_review: flaggedRes.count || 0,
      leads_captured: leadsRes.count || 0,
      spam_archived: archivedRes.count || 0,
      auto_response_rate: total > 0 ? Math.round((autoResponded / total) * 100) : 0,
      volume_usage: await this.getMonthlyUsage(tenantId),
    };
  }

  // -------------------------------------------------------------------------
  // Approval Queue
  // -------------------------------------------------------------------------

  /**
   * Get flagged emails awaiting owner review
   */
  async getFlaggedEmails(tenantId) {
    const { data, error } = await this.db
      .from('email_messages')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('response_status', 'flagged')
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data || [];
  }

  /**
   * Owner approves a flagged email's draft response — sends it
   */
  async approveEmail(messageId, credentials) {
    const { data: email, error } = await this.db
      .from('email_messages')
      .select('*')
      .eq('id', messageId)
      .single();

    if (error || !email) throw new Error('Email not found');
    if (!email.response_text) throw new Error('No draft response to approve');

    const result = await this.autoRespond(email, email.response_text, credentials);

    if (result.success) {
      await this.db
        .from('email_messages')
        .update({
          response_status: 'auto_responded',
          processed_at: new Date().toISOString(),
        })
        .eq('id', messageId);

      await this._logAction(email.tenant_id, 'approve', email.provider, email.message_id, {
        response_preview: email.response_text.substring(0, 100),
      });
    }

    return result;
  }

  /**
   * Owner edits the draft and sends a custom response
   */
  async editAndRespond(messageId, editedResponse, credentials) {
    const { data: email, error } = await this.db
      .from('email_messages')
      .select('*')
      .eq('id', messageId)
      .single();

    if (error || !email) throw new Error('Email not found');

    const result = await this.autoRespond(email, editedResponse, credentials);

    if (result.success) {
      await this.db
        .from('email_messages')
        .update({
          response_text: editedResponse,
          response_status: 'auto_responded',
          processed_at: new Date().toISOString(),
        })
        .eq('id', messageId);

      await this._logAction(email.tenant_id, 'approve', email.provider, email.message_id, {
        edited: true,
        response_preview: editedResponse.substring(0, 100),
      });
    }

    return result;
  }

  /**
   * Owner dismisses/archives a flagged email
   */
  async dismissEmail(messageId) {
    const { data: email } = await this.db
      .from('email_messages')
      .select('tenant_id, provider, message_id')
      .eq('id', messageId)
      .single();

    await this.db
      .from('email_messages')
      .update({ response_status: 'archived' })
      .eq('id', messageId);

    if (email) {
      await this._logAction(email.tenant_id, 'dismiss', email.provider, email.message_id, {});
    }
  }

  // -------------------------------------------------------------------------
  // Lead Capture
  // -------------------------------------------------------------------------

  /**
   * Auto-capture a lead email into the CRM leads table
   */
  async _captureLead(email, tenantConfig) {
    try {
      const { data: lead, error } = await this.db
        .from('leads')
        .insert({
          tenant_id: email.tenant_id,
          name: email.from_name || email.from_address,
          email: email.from_address,
          lead_source: `email_${email.provider}`,
          source_detail: `Email inquiry: ${email.subject}`,
          notes: `Email body preview: "${email.body_preview}"`,
          status: 'new',
          priority_tier: 'medium',
        })
        .select()
        .single();

      if (error) throw error;

      // Link lead to the email
      await this.db
        .from('email_messages')
        .update({ lead_id: lead.id })
        .eq('id', email.id);

      await this._logAction(email.tenant_id, 'lead_capture', email.provider, email.message_id, {
        lead_id: lead.id,
        from: email.from_address,
      });

      log.success(`Lead captured from email: ${email.from_name || email.from_address}`);
      return lead;
    } catch (err) {
      log.error('Lead capture from email failed', err);
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

    if (!expiresAt || expiresAt > new Date(now.getTime() + 5 * 60 * 1000)) {
      return connection;
    }

    log.info(`Refreshing ${connection.provider} token for tenant ${connection.tenant_id}`);

    if (connection.provider === 'gmail') {
      return await this._refreshGmailToken(connection);
    } else if (connection.provider === 'outlook') {
      return await this._refreshOutlookToken(connection);
    }

    return connection;
  }

  async _refreshGmailToken(connection) {
    try {
      const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: process.env.GOOGLE_CLIENT_ID,
          client_secret: process.env.GOOGLE_CLIENT_SECRET,
          refresh_token: connection.refresh_token,
          grant_type: 'refresh_token',
        }),
      });
      const data = await res.json();

      if (data.error) throw new Error(data.error_description || data.error);

      const expiresAt = new Date(Date.now() + (data.expires_in || 3600) * 1000);

      await this.db
        .from('email_connections')
        .update({
          access_token: data.access_token,
          expires_at: expiresAt.toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', connection.id);

      await this._logAction(connection.tenant_id, 'refresh_token', 'gmail', null, {});

      return { ...connection, access_token: data.access_token, expires_at: expiresAt.toISOString() };
    } catch (err) {
      log.error('Gmail token refresh failed', err);
      return connection;
    }
  }

  async _refreshOutlookToken(connection) {
    try {
      const res = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: process.env.MICROSOFT_CLIENT_ID,
          client_secret: process.env.MICROSOFT_CLIENT_SECRET,
          refresh_token: connection.refresh_token,
          grant_type: 'refresh_token',
          scope: 'https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send',
        }),
      });
      const data = await res.json();

      if (data.error) throw new Error(data.error_description || data.error);

      const expiresAt = new Date(Date.now() + (data.expires_in || 3600) * 1000);

      await this.db
        .from('email_connections')
        .update({
          access_token: data.access_token,
          refresh_token: data.refresh_token || connection.refresh_token,
          expires_at: expiresAt.toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', connection.id);

      await this._logAction(connection.tenant_id, 'refresh_token', 'outlook', null, {});

      return {
        ...connection,
        access_token: data.access_token,
        refresh_token: data.refresh_token || connection.refresh_token,
        expires_at: expiresAt.toISOString(),
      };
    } catch (err) {
      log.error('Outlook token refresh failed', err);
      return connection;
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
      email_voice: tenant.config?.email_voice || null,
      owner_name: tenant.config?.owner_name || tenant.business_name,
      modules: tenant.modules || {},
    };
  }

  async _logAction(tenantId, actionType, provider, messageId, details = {}) {
    try {
      await this.db.from('email_agent_log').insert({
        tenant_id: tenantId,
        action_type: actionType,
        provider,
        message_id: messageId,
        details,
      });
    } catch (err) {
      log.error('Failed to log email action', err);
    }
  }
}

module.exports = { EmailAgent };
