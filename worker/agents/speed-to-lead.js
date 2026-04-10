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
const { sendSms } = require('../../integrations/twilio');
const { checkIdempotency, recordIdempotency } = require('../../db/queries/jobs');

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
 * @param {Object} tenant - Resolved tenant
 * @param {Object} payload - { lead_id }
 */
async function run(tenant, payload = {}) {
  const log = createLogger('speed-to-lead', tenant.slug);

  if (!payload.lead_id) {
    throw new Error('lead_id is required');
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

  // Send the SMS
  const smsResult = await sendSms(tenant.integrations, lead.phone, messageBody, {
    tenantSlug: tenant.slug
  });

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
