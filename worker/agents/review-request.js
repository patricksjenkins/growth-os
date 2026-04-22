/**
 * Growth OS — Review Request Agent
 * Sends SMS to customers after completed jobs asking for a review.
 *
 * Scheduled: daily at 10am
 * Targets: leads with status 'won' or jobs with status 'completed'
 * that haven't already received a review request.
 */

const { createLogger } = require('../../core/logger');
const { getConfig } = require('../../core/config');
const { db } = require('../../db/client');
const { sendSms, SmsCapExceededError } = require('../../integrations/twilio');
const { checkIdempotency, recordIdempotency } = require('../../db/queries/jobs');

/**
 * @param {Object} tenant - Resolved tenant
 * @param {Object} payload - { limit }
 */
async function run(tenant, payload = {}) {
  const log = createLogger('review-request', tenant.slug);

  // No Twilio → skip quietly.
  const tw = tenant?.integrations?.twilio;
  if (!tw || !tw.credentials?.account_sid || !tw.config?.phone_number) {
    log.info('No Twilio configured for this tenant — skipping');
    return { success: true, skipped: true, reason: 'no_twilio_integration' };
  }

  const limit = Number(payload.limit || 10);
  const delayDays = Number(getConfig(tenant, 'review_delay_days', 1));
  const reviewUrl = getConfig(tenant, 'review_url', '');
  const smsTemplates = getConfig(tenant, 'sms_templates', {});
  const businessName = getConfig(tenant, 'business_name', tenant.name || 'Our Team');

  if (!reviewUrl) {
    log.warn('No review_url configured, skipping');
    return { success: true, sent: 0, message: 'No review URL configured' };
  }

  log.info('Starting review request run', { delayDays, limit });

  // Find completed jobs from X days ago that haven't gotten a review request
  const cutoffDate = new Date(Date.now() - delayDays * 24 * 60 * 60 * 1000).toISOString();

  // Strategy: find leads that are 'won' and were updated at least delayDays ago
  const { data: leads, error: leadsErr } = await db
    .from('leads')
    .select('*')
    .eq('tenant_id', tenant.id)
    .eq('status', 'won')
    .not('phone', 'is', null)
    .lte('updated_at', cutoffDate)
    .order('updated_at', { ascending: true })
    .limit(limit);

  if (leadsErr) throw leadsErr;

  if (!leads || leads.length === 0) {
    log.info('No leads eligible for review request');
    return { success: true, sent: 0, message: 'No eligible leads' };
  }

  let sent = 0;
  let skipped = 0;
  let capReached = false;
  let capInfo = null;
  const processed = [];
  const errors = [];

  for (const lead of leads) {
    if (capReached) {
      skipped++;
      processed.push({ lead_id: lead.id, name: lead.name, action: 'sms_cap_reached' });
      continue;
    }
    try {
      // Idempotency — only one review request per lead ever
      const idempKey = `review-request:${lead.id}`;
      const existing = await checkIdempotency(tenant.id, idempKey);
      if (existing) {
        skipped++;
        processed.push({ lead_id: lead.id, name: lead.name, action: 'already_requested' });
        continue;
      }

      // Build message
      const template = smsTemplates.review_request
        || 'Hi {name}! Thanks for choosing {business_name}! If you were happy with the work, a review would mean a lot: {review_url}';
      const messageBody = template
        .replace(/{name}/g, lead.name || 'there')
        .replace(/{business_name}/g, businessName)
        .replace(/{review_url}/g, reviewUrl);

      log.info(`Sending review request to ${lead.name}`);

      let smsResult;
      try {
        smsResult = await sendSms(tenant.integrations, lead.phone, messageBody, {
          tenantSlug: tenant.slug,
          tenant
        });
      } catch (err) {
        if (err instanceof SmsCapExceededError) {
          capReached = true;
          capInfo = { cap: err.cap, count: err.count };
          log.warn(`SMS cap reached (${err.count}/${err.cap}); halting review-request run`);
          skipped++;
          processed.push({ lead_id: lead.id, name: lead.name, action: 'sms_cap_reached' });
          continue;
        }
        throw err;
      }

      // Log the message
      await db.from('messages').insert({
        tenant_id: tenant.id,
        channel: 'sms',
        direction: 'outbound',
        body: messageBody,
        external_id: smsResult.sid,
        status: 'sent',
        sent_at: new Date().toISOString()
      });

      // Record idempotency
      await recordIdempotency(tenant.id, idempKey, 'review_requested', {
        message_sid: smsResult.sid
      });

      sent++;
      processed.push({ lead_id: lead.id, name: lead.name, action: 'sent', message_sid: smsResult.sid });
      log.success(`Review request sent to ${lead.name}`);
    } catch (err) {
      log.error(`Review request failed for ${lead.name}`, err);
      errors.push({ lead_id: lead.id, name: lead.name, error: err.message });
    }
  }

  const result = {
    success: true,
    sent,
    skipped,
    processed,
    errors,
    ...(capInfo ? { sms_cap_reached: true, cap: capInfo.cap, count: capInfo.count } : {})
  };
  log.success('Review request run completed', { sent, skipped, cap_reached: capReached });
  return result;
}

module.exports = run;
