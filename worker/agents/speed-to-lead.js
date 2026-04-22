/**
 * Growth OS — Speed-to-Lead Agent
 * Sends an immediate SMS to new leads within minutes of inquiry.
 *
 * Triggered by: lead creation (api/routes/leads.js enqueues job)
 * Requires: speed_to_lead module enabled, Twilio configured, lead has phone
 */

const { createLogger } = require('../../core/logger');
const { getConfig } = require('../../core/config');
const { db } = require('../../db/client');
const { sendSms, SmsCapExceededError } = require('../../integrations/twilio');
const { checkIdempotency, recordIdempotency, enqueueJob } = require('../../db/queries/jobs');

// Sweeper window — look back this far for uncontacted leads
const SWEEPER_WINDOW_MINUTES = 60;
const SWEEPER_LIMIT = 20;

/**
 * Render SMS template with lead data
 */
function renderTemplate(template, lead, tenant) {
  const businessName = getConfig(tenant, 'business_name', tenant.name || 'Our Team');
  return template
    .replace(/{name}/g, lead.name || 'there')
    .replace(/{business_name}/g, businessName)
    .replace(/{service_type}/g, lead.service_type || 'your needs');
}

/**
 * Sweeper mode — find recent uncontacted leads and enqueue per-lead jobs.
 * Runs when the cron fires the agent without a lead_id payload.
 * Acts as a safety net for leads inserted via imports, webhooks, or any path
 * that bypasses POST /api/leads (which enqueues per-lead directly).
 */
async function sweep(tenant, log) {
  const since = new Date(Date.now() - SWEEPER_WINDOW_MINUTES * 60 * 1000).toISOString();

  const { data: leads, error } = await db
    .from('leads')
    .select('id, name, phone, status, created_at')
    .eq('tenant_id', tenant.id)
    .eq('status', 'new_lead')
    .not('phone', 'is', null)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(SWEEPER_LIMIT);

  if (error) throw error;

  if (!leads || leads.length === 0) {
    return { success: true, swept: true, enqueued: 0, candidates: 0 };
  }

  let enqueued = 0;
  let alreadyQueued = 0;
  for (const lead of leads) {
    // Skip leads we've already contacted (idempotency record exists)
    const idempKey = `speed-to-lead:${lead.id}`;
    const existing = await checkIdempotency(tenant.id, idempKey);
    if (existing) continue;

    // Skip leads that already have a pending/processing speed-to-lead job
    // to avoid duplicate enqueues from back-to-back cron ticks
    const { data: existingJobs } = await db
      .from('agent_jobs')
      .select('id')
      .eq('tenant_id', tenant.id)
      .eq('agent_name', 'speed-to-lead')
      .in('status', ['pending', 'processing'])
      .contains('payload', { lead_id: lead.id })
      .limit(1);
    if (existingJobs && existingJobs.length > 0) {
      alreadyQueued++;
      continue;
    }

    await enqueueJob(tenant.id, 'speed-to-lead', { lead_id: lead.id }, { priority: 10 });
    enqueued++;
  }

  log.info('Sweeper result', { candidates: leads.length, enqueued, alreadyQueued });
  return { success: true, swept: true, enqueued, candidates: leads.length, alreadyQueued };
}

/**
 * Twilio is required for this agent. If the tenant doesn't have it
 * configured, there is nothing the agent can usefully do — skip quietly
 * instead of throwing `Twilio integration not configured for this tenant`
 * 500 times a day (one throw per lead in the sweeper loop). This is
 * the single biggest source of noise in the daily digest.
 */
function tenantHasTwilio(tenant) {
  const t = tenant?.integrations?.twilio;
  return !!(t && t.credentials?.account_sid && t.config?.phone_number);
}

/**
 * @param {Object} tenant - Resolved tenant
 * @param {Object} payload - { lead_id } for single-lead mode, {} for sweeper mode
 */
async function run(tenant, payload = {}) {
  const log = createLogger('speed-to-lead', tenant.slug);

  // Pre-flight: if tenant has no Twilio configured, bail gracefully rather
  // than throwing on every lead (which is what produced 259 failures in one
  // sweep on 2026-04-21). The module-gate in the scheduler is SUPPOSED to
  // catch this, but tenants can have the 'speed_to_lead' module enabled
  // without having provisioned Twilio yet — this agent must not assume
  // they match.
  if (!tenantHasTwilio(tenant)) {
    log.info('No Twilio configured for this tenant — skipping');
    return { success: true, skipped: true, reason: 'no_twilio_integration' };
  }

  // Cron-triggered sweeper mode: find uncontacted leads and enqueue per-lead jobs
  if (!payload.lead_id) {
    return await sweep(tenant, log);
  }

  // Idempotency check — don't double-text the same lead
  const idempKey = `speed-to-lead:${payload.lead_id}`;
  const existing = await checkIdempotency(tenant.id, idempKey);
  if (existing) {
    log.info('Already contacted this lead', { lead_id: payload.lead_id });
    return { success: true, skipped: true, reason: 'already_contacted' };
  }

  // Fetch the lead
  const { data: lead, error: leadErr } = await db
    .from('leads')
    .select('*')
    .eq('tenant_id', tenant.id)
    .eq('id', payload.lead_id)
    .single();

  if (leadErr || !lead) {
    throw new Error(`Lead not found: ${payload.lead_id}`);
  }

  if (!lead.phone) {
    log.warn('Lead has no phone number, skipping', { lead_id: lead.id });
    return { success: true, skipped: true, reason: 'no_phone' };
  }

  // Get SMS template
  const template = getConfig(tenant, 'sms_templates', {}).speed_to_lead
    || 'Hi {name}, thanks for reaching out to {business_name}! How can we help you?';
  const messageBody = renderTemplate(template, lead, tenant);

  log.info('Sending speed-to-lead SMS', { lead: lead.name, phone: lead.phone.slice(-4) });

  // Send the SMS (with monthly volume cap enforcement)
  let smsResult;
  try {
    smsResult = await sendSms(tenant.integrations, lead.phone, messageBody, {
      tenantSlug: tenant.slug,
      tenant
    });
  } catch (err) {
    if (err instanceof SmsCapExceededError) {
      log.warn(`SMS cap reached (${err.count}/${err.cap}); deferring lead`, { lead_id: lead.id });
      return {
        success: true,
        skipped: true,
        reason: 'sms_cap_reached',
        cap: err.cap,
        count: err.count
      };
    }
    throw err;
  }

  // Log the outbound message
  await db.from('messages').insert({
    tenant_id: tenant.id,
    channel: 'sms',
    direction: 'outbound',
    body: messageBody,
    external_id: smsResult.sid,
    status: 'sent',
    sent_at: new Date().toISOString()
  });

  // Update lead status if still new
  if (lead.status === 'new_lead') {
    await db.from('leads')
      .update({ status: 'contacted', updated_at: new Date().toISOString() })
      .eq('id', lead.id)
      .eq('tenant_id', tenant.id);
  }

  // Record idempotency
  await recordIdempotency(tenant.id, idempKey, 'sms_sent', {
    message_sid: smsResult.sid,
    sent_at: new Date().toISOString()
  });

  log.success('Speed-to-lead SMS sent', { lead: lead.name });

  return {
    success: true,
    lead_id: lead.id,
    lead_name: lead.name,
    message_sid: smsResult.sid
  };
}

module.exports = run;
