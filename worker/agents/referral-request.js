/**
 * Growth OS — Referral Request Agent
 * Sends SMS to happy customers asking for referrals.
 *
 * Scheduled: daily at 2pm
 * Targets: leads with status 'won' that received a review request
 * but haven't received a referral request yet.
 * Waits referral_delay_days after review request before sending.
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
  const log = createLogger('referral-request', tenant.slug);

  // No Twilio → skip quietly.
  const tw = tenant?.integrations?.twilio;
  if (!tw || !tw.credentials?.account_sid || !tw.config?.phone_number) {
    log.info('No Twilio configured for this tenant — skipping');
    return { success: true, skipped: true, reason: 'no_twilio_integration' };
  }

  const limit = Number(payload.limit || 10);
  const delayDays = Number(getConfig(tenant, 'referral_delay_days', 3));
  const referralBonus = getConfig(tenant, 'referral_bonus', 100);
  const smsTemplates = getConfig(tenant, 'sms_templates', {});
  const businessName = getConfig(tenant, 'business_name', tenant.name || 'Our Team');

  log.info('Starting referral request run', { delayDays, referralBonus, limit });

  // Find leads that are 'won' and were updated at least delayDays ago
  const cutoffDate = new Date(Date.now() - delayDays * 24 * 60 * 60 * 1000).toISOString();

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
    log.info('No leads eligible for referral request');
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
      // Idempotency — only one referral request per lead ever
      const idempKey = `referral-request:${lead.id}`;
      const existing = await checkIdempotency(tenant.id, idempKey);
      if (existing) {
        skipped++;
        processed.push({ lead_id: lead.id, name: lead.name, action: 'already_requested' });
        continue;
      }

      // Only send referral if review request was already sent
      const reviewKey = `review-request:${lead.id}`;
      const reviewSent = await checkIdempotency(tenant.id, reviewKey);
      if (!reviewSent) {
        skipped++;
        processed.push({ lead_id: lead.id, name: lead.name, action: 'review_not_sent_yet' });
        continue;
      }

      // Build message
      const template = smsTemplates.referral_request
        || 'Hey {name}! If you know anyone who needs our services, we offer a $${referral_bonus} referral bonus. Just have them mention your name!';
      const messageBody = template
        .replace(/{name}/g, lead.name || 'there')
        .replace(/{business_name}/g, businessName)
        .replace(/\$\{referral_bonus\}/g, referralBonus)
        .replace(/{referral_bonus}/g, referralBonus);

      log.info(`Sending referral request to ${lead.name}`);

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
          log.warn(`SMS cap reached (${err.count}/${err.cap}); halting referral-request run`);
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
      await recordIdempotency(tenant.id, idempKey, 'referral_requested', {
        message_sid: smsResult.sid
      });

      sent++;
      processed.push({ lead_id: lead.id, name: lead.name, action: 'sent', message_sid: smsResult.sid });
      log.success(`Referral request sent to ${lead.name}`);
    } catch (err) {
      log.error(`Referral request failed for ${lead.name}`, err);
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
  log.success('Referral request run completed', { sent, skipped, cap_reached: capReached });
  return result;
}

module.exports = run;
