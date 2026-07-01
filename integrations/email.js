/**
 * Growth OS — Email Integration
 * Sends transactional emails via Resend using platform-level API key.
 * All emails sent from patrick@firstgenautomate.com (or configured FROM address).
 */

const fs = require('fs');
const path = require('path');
const { createLogger } = require('../core/logger');
const {
  preflightOutbound, TenantIdentityError,
} = require('../core/tenant-email-identity');

const log = createLogger('email');

/** Minimal HTML→text for a plain-text alternative part (deliverability). */
function htmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&middot;/gi, '·')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
}

/** Record a safety-blocked send as an owner attention item (non-fatal). */
async function recordBlockedSend(tenant, { to, subject, err }) {
  try {
    const { db } = require('../db/client');
    const tenantId = tenant && tenant.id;
    if (!tenantId) return;
    await db.from('notifications').insert({
      tenant_id: tenantId,
      category: 'email_identity_blocked',
      priority: 'high',
      title: 'Email blocked — tenant identity not safe to send',
      message: `A customer email to ${Array.isArray(to) ? to.join(', ') : to} ("${subject}") was blocked: ${err.reason || err.message}. It was NOT sent from First Gen Automate. Fix the tenant email identity and it will send.`,
      metadata: { code: err.code, reason: err.reason, missing: err.missing || null, violation: err.violation || null, to, subject },
      status: 'pending',
    });
    await db.from('activity_log').insert({
      tenant_id: tenantId, agent: 'email-guardrail', action: 'send_blocked_failed_safe',
      level: 'error', metadata: { code: err.code, reason: err.reason, to, subject },
    }).catch(() => {});
  } catch (e) {
    log.warn(`recordBlockedSend failed: ${e.message}`);
  }
}

/** List-Unsubscribe header pointed at the tenant's own reply inbox. */
function listUnsubHeaders(identity) {
  if (!identity || !identity.reply_to) return {};
  return { 'List-Unsubscribe': `<mailto:${identity.reply_to}?subject=unsubscribe>` };
}

// Platform-level Resend client (one API key for all tenants)
// Lazy-loaded to avoid crashing at require time if resend package isn't available
let Resend = null;
let resendClient = null;

function getResend() {
  if (!resendClient) {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      log.warn('RESEND_API_KEY not set — emails will be logged but not sent');
      return null;
    }
    try {
      if (!Resend) Resend = require('resend').Resend;
      resendClient = new Resend(apiKey);
    } catch (err) {
      log.warn(`resend package not available — emails will be logged but not sent: ${err.message}`);
      return null;
    }
  }
  return resendClient;
}

// Default sender
const DEFAULT_FROM = process.env.EMAIL_FROM || 'Patrick at First Gen Automate <patrick@firstgenautomate.com>';

// ---------------------------------------------------------------------------
// Template loader — reads HTML templates and replaces {{variables}}
// ---------------------------------------------------------------------------

const templateCache = {};

function loadTemplate(templateName) {
  if (templateCache[templateName]) return templateCache[templateName];

  const templatePath = path.join(__dirname, '..', 'templates', 'emails', `${templateName}.html`);

  if (!fs.existsSync(templatePath)) {
    throw new Error(`Email template not found: ${templateName} (${templatePath})`);
  }

  const html = fs.readFileSync(templatePath, 'utf-8');
  templateCache[templateName] = html;
  return html;
}

function renderTemplate(templateName, variables = {}) {
  let html = loadTemplate(templateName);

  // Replace all {{variable_name}} placeholders
  for (const [key, value] of Object.entries(variables)) {
    const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
    html = html.replace(regex, value || '');
  }

  // Warn about any remaining unreplaced variables
  const remaining = html.match(/\{\{(\w+)\}\}/g);
  if (remaining) {
    log.warn(`Unreplaced template variables in ${templateName}: ${remaining.join(', ')}`);
  }

  return html;
}

// ---------------------------------------------------------------------------
// Template-to-subject mapping
// ---------------------------------------------------------------------------

const TEMPLATE_SUBJECTS = {
  'welcome':                'Welcome to Growth OS — Your System is Being Built',
  'system-building':        'Growth OS Update — Your System is Taking Shape',
  'content-ready':          'Your Content is Ready for Review',
  'app-ready':              'Your App is Ready — Let\'s Walk Through It',
  'go-live':                'You\'re Live! Your Growth OS System is Active',
  'check-in-2week':         'How\'s Everything Going? Your 2-Week Check-In',
  'check-in-30day':         'Your First Month with Growth OS — Here\'s What Happened',
  'check-in-60day':         'Two Months In — Your Growth OS Results',
  'platform-daily-digest':  'FGA Daily Digest',
};

// ---------------------------------------------------------------------------
// sendEmail — sends a single email
// ---------------------------------------------------------------------------

async function sendEmail(to, subject, htmlBody, options = {}) {
  let from = options.from || DEFAULT_FROM;
  let replyTo = options.replyTo || null;
  let plainText = options.text || null;
  let extraHeaders = { ...(options.headers || {}) };

  // Demo-mode guard — a demo tenant should never send real emails.
  if (options.tenant) {
    const { isDemoTenant, demoMockResponse } = require('./demo-guard');
    if (isDemoTenant(options.tenant)) {
      log.info(`[demo] Email mocked — would have sent to ${to}: "${subject}"`);
      return demoMockResponse('email', { status: 'sent', to, subject });
    }
  }

  // === Tenant identity guardrail (P0 cross-tenant bleed fix) ===
  // Runs at the single choke point every email flows through. For a
  // CUSTOMER-facing email on a non-platform tenant this forces the tenant's own
  // verified From/Reply-To/signature and BLOCKS (never falls back to FGA) when
  // identity is missing/unverified or platform content is detected.
  if (options.tenant) {
    let tenant = options.tenant;
    if (!tenant.config && tenant.id) {
      try {
        const { db } = require('../db/client');
        const { resolveTenant } = require('../core/tenant');
        tenant = (await resolveTenant(db, tenant.id)) || tenant;
      } catch (e) {
        log.warn(`identity gate: tenant resolve failed for ${tenant.id}: ${e.message}`);
      }
    }
    try {
      const gate = preflightOutbound({
        tenant, audience: options.audience, to, subject,
        html: htmlBody, text: plainText, from: options.from, replyTo: options.replyTo,
        ownership: options.ownership,
      });
      from = gate.from || from;
      replyTo = gate.replyTo || replyTo;
      if (gate.mode === 'customer') {
        if (!plainText) plainText = htmlToText(htmlBody);
        extraHeaders = { ...listUnsubHeaders(gate.identity), ...extraHeaders };
      }
    } catch (err) {
      if (err instanceof TenantIdentityError) {
        log.error(`BLOCKED customer email (${err.code}) to ${to}: ${err.reason}`);
        await recordBlockedSend(tenant, { to, subject, err });
        throw err; // failed_safe — do NOT send from FGA
      }
      throw err;
    }
  }

  // Per-tenant monthly cap enforcement. Skipped for platform-level
  // emails where caller didn't pass a tenant (onboarding, support, etc).
  if (options.tenant && options.tenant.id) {
    const { checkUsageOrThrow, notifyOwnerCapReached, UsageCapExceededError } = require('../core/usage-caps');
    try {
      await checkUsageOrThrow(options.tenant, 'email_send_count', 1);
    } catch (capErr) {
      if (capErr instanceof UsageCapExceededError) {
        log.warn(`Email cap hit for tenant ${options.tenant.id} (${capErr.used}/${capErr.cap}) — skipping send to ${to}`);
        notifyOwnerCapReached(options.tenant.id, 'email_send_count', capErr.used, capErr.cap);
      }
      throw capErr;
    }
  }

  const resend = getResend();

  if (!resend) {
    // Dev mode: log the email instead of sending
    log.info(`[DEV] Email to ${to}: "${subject}" (${htmlBody.length} chars)`);
    return { status: 'dev_logged', to, subject };
  }

  try {
    const { data, error } = await resend.emails.send({
      from,
      to: Array.isArray(to) ? to : [to],
      subject,
      html: htmlBody,
      // reply_to resolved by the identity gate for customer sends; FGA only for
      // platform/owner sends where no tenant reply-to applies.
      reply_to: replyTo || 'patrick@firstgenautomate.com',
      ...(plainText ? { text: plainText } : {}),
      // Custom headers (List-Unsubscribe etc.). Resend accepts { name: value }.
      ...(Object.keys(extraHeaders).length ? { headers: extraHeaders } : {}),
    });

    if (error) {
      log.error(`Failed to send email to ${to}: ${error.message}`);
      throw new Error(`Email send failed: ${error.message}`);
    }

    log.info(`Email sent to ${to}: "${subject}" (id: ${data.id})`);

    // Increment per-tenant counter (fire-and-forget)
    if (options.tenant && options.tenant.id) {
      const { incrementUsage } = require('../core/usage-caps');
      incrementUsage(options.tenant.id, 'email_send_count', 1).catch(() => {});
    }
    // Usage-based cost on the ledger (provider=resend). Per-email; override
    // RESEND_EMAIL_COST_USD. Counts recipients in this send.
    try {
      const recipients = Array.isArray(to) ? to.length : 1;
      require('../core/ai-safety/usage-tracker').recordUsage({
        tenantId: options.tenant?.id, provider: 'resend', model: 'email', operationType: 'email_send',
        estimatedCostUsd: Number(process.env.RESEND_EMAIL_COST_USD || 0.0004) * recipients,
        isAutomated: options.isAutomated !== false, requestSource: 'integrations/email.js:sendEmail',
      }).catch(() => {});
    } catch (_) { /* never break a send */ }

    return { status: 'sent', id: data.id, to, subject };
  } catch (err) {
    log.error(`Email error: ${err.message}`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// sendTemplateEmail — loads template, renders variables, sends
// ---------------------------------------------------------------------------

async function sendTemplateEmail(to, templateName, variables = {}, options = {}) {
  const subject = options.subject || TEMPLATE_SUBJECTS[templateName] || `Growth OS — ${templateName}`;
  const html = renderTemplate(templateName, variables);
  return sendEmail(to, subject, html, options);
}

// ---------------------------------------------------------------------------
// Onboarding email helpers — called from onboarding step handlers
// ---------------------------------------------------------------------------

async function sendWelcomeEmail(to, vars) {
  return sendTemplateEmail(to, 'welcome', vars);
}

async function sendBuildingEmail(to, vars) {
  return sendTemplateEmail(to, 'system-building', vars);
}

async function sendContentReadyEmail(to, vars) {
  return sendTemplateEmail(to, 'content-ready', vars);
}

async function sendAppReadyEmail(to, vars) {
  return sendTemplateEmail(to, 'app-ready', vars);
}

async function sendGoLiveEmail(to, vars) {
  return sendTemplateEmail(to, 'go-live', vars);
}

async function sendCheckInEmail(to, templateName, vars) {
  return sendTemplateEmail(to, templateName, vars);
}

module.exports = {
  sendEmail,
  sendTemplateEmail,
  sendWelcomeEmail,
  sendBuildingEmail,
  sendContentReadyEmail,
  sendAppReadyEmail,
  sendGoLiveEmail,
  sendCheckInEmail,
  renderTemplate,
  loadTemplate,
};
