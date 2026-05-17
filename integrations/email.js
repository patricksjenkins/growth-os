/**
 * Growth OS — Email Integration
 * Sends transactional emails via Resend using platform-level API key.
 * All emails sent from patrick@firstgenautomate.com (or configured FROM address).
 */

const fs = require('fs');
const path = require('path');
const { createLogger } = require('../core/logger');

const log = createLogger('email');

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
const DEFAULT_FROM = process.env.EMAIL_FROM || 'Patrick Jenkins <patrick@firstgenautomate.com>';

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
  const from = options.from || DEFAULT_FROM;

  // Demo-mode guard — a demo tenant should never send real emails.
  if (options.tenant) {
    const { isDemoTenant, demoMockResponse } = require('./demo-guard');
    if (isDemoTenant(options.tenant)) {
      log.info(`[demo] Email mocked — would have sent to ${to}: "${subject}"`);
      return demoMockResponse('email', { status: 'sent', to, subject });
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
      reply_to: options.replyTo || 'patrick@firstgenautomate.com',
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
