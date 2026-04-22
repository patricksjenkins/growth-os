/**
 * Growth OS — Missed Call Agent
 * Sends an immediate SMS when a call goes unanswered.
 *
 * Triggered by: Twilio voice webhook (api/webhooks/twilio.js)
 * Enqueued when call status is no-answer, busy, or failed.
 */

const { createLogger } = require('../../core/logger');
const { getConfig } = require('../../core/config');
const { db } = require('../../db/client');
const { sendSms, SmsCapExceededError } = require('../../integrations/twilio');
const { checkIdempotency, recordIdempotency } = require('../../db/queries/jobs');

/**
 * @param {Object} tenant - Resolved tenant
 * @param {Object} payload - { from, call_status, call_sid }
 */
async function run(tenant, payload = {}) {
  const log = createLogger('missed-call', tenant.slug);

  // No Twilio → skip quietly.
  const tw = tenant?.integrations?.twilio;
  if (!tw || !tw.credentials?.account_sid || !tw.config?.phone_number) {
    log.info('No Twilio configured for this tenant — skipping');
    return { success: true, skipped: true, reason: 'no_twilio_integration' };
  }

  const { from, call_status, call_sid } = payload;
  if (!from) throw new Error('Caller phone number (from) is required');

  // Idempotency — don't text the same caller multiple times in a day
  const today = new Date().toISOString().slice(0, 10);
  const idempKey = `missed-call:${from}:${today}`;
  const existing = await checkIdempotency(tenant.id, idempKey);
  if (existing) {
    log.info('Already texted this caller today', { from: from.slice(-4) });
    return { success: true, skipped: true, reason: 'already_texted_today' };
  }

  log.info(`Missed call from ${from.slice(-4)} (${call_status})`);

  // Get SMS template
  const smsTemplates = getConfig(tenant, 'sms_templates', {});
  const businessName = getConfig(tenant, 'business_name', tenant.name || 'Our Team');
  const template = smsTemplates.missed_call
    || 'Hi, this is {business_name}. Sorry we missed your call! How can we help? You can text us back here.';
  const messageBody = template.replace(/{business_name}/g, businessName);

  // Send SMS (with monthly volume cap enforcement)
  let smsResult;
  try {
    smsResult = await sendSms(tenant.integrations, from, messageBody, {
      tenantSlug: tenant.slug,
      tenant
    });
  } catch (err) {
    if (err instanceof SmsCapExceededError) {
      log.warn(`SMS cap reached (${err.count}/${err.cap}); skipping missed-call response`);
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

  // Try to find or create a lead for this caller
  const { data: existingLead } = await db
    .from('leads')
    .select('id, name, status')
    .eq('tenant_id', tenant.id)
    .eq('phone', from)
    .maybeSingle();

  let leadId = existingLead?.id || null;

  if (!existingLead) {
    // Create a new lead from the missed call
    const { data: newLead, error: leadErr } = await db
      .from('leads')
      .insert({
        tenant_id: tenant.id,
        name: 'Missed Call',
        phone: from,
        lead_source: 'missed_call',
        status: 'new_lead',
        notes: `Missed call (${call_status}) on ${new Date().toLocaleString()}`
      })
      .select()
      .single();

    if (!leadErr && newLead) {
      leadId = newLead.id;
      log.info('Created lead from missed call', { lead_id: leadId });
    }
  }

  // Record idempotency
  await recordIdempotency(tenant.id, idempKey, 'missed_call_sms', {
    message_sid: smsResult.sid,
    call_sid,
    lead_id: leadId
  });

  log.success('Missed call SMS sent', { from: from.slice(-4) });

  return {
    success: true,
    from,
    message_sid: smsResult.sid,
    lead_id: leadId,
    new_lead: !existingLead
  };
}

module.exports = run;
