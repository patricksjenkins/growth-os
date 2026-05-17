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
const { claudeHaiku } = require('../../integrations/claude');

/**
 * AI-personalized referral request body. Module 10.2 ("Sends
 * personalized referral-ask text"). References customer first name,
 * the service we just did for them, and the referral bonus amount —
 * in the tenant's brand voice.
 */
async function generatePersonalizedReferralAsk(tenant, lead, referralBonus, fallbackTemplate, log) {
  const businessName = getConfig(tenant, 'business_name', tenant.name || 'Our Team');
  const brandVoice = getConfig(tenant, 'brand_voice', 'Friendly, professional, no-nonsense. Sounds like a real person.');

  const systemPrompt = `You are writing a single SMS to a recent happy customer of ${businessName} asking if they\'d refer a friend. Brand voice: ${brandVoice}

Rules:
- Output ONLY the SMS body. No quotes around it.
- 25-50 words MAX.
- Reference the customer\'s first name once if available.
- Briefly reference the work you did for them (don't oversell).
- Mention the $${referralBonus} referral bonus naturally.
- One clear ask: refer a friend.
- No signature, no business name sign-off, no emoji unless brand voice demands it.
- Make it feel like a real ask from a person who appreciates them, not a corporate prompt.`;

  const firstName = (lead.name || '').split(/\s+/)[0] || '';
  const context = [
    `Customer: ${firstName || '(no name)'}`,
    lead.service_type ? `Service we did: ${lead.service_type}` : null,
    lead.city ? `City: ${lead.city}` : null,
    `Referral bonus to offer: $${referralBonus}`,
  ].filter(Boolean).join('\n');

  try {
    const reply = await claudeHaiku(systemPrompt, `Customer context:\n${context}\n\nWrite the SMS now. Output the SMS body only.`, { maxTokens: 220, tenantSlug: tenant.slug });
    const cleaned = String(reply || '').trim().replace(/^["']|["']$/g, '');
    if (!cleaned || cleaned.length < 15 || cleaned.length > 600) {
      log.warn(`Claude returned unusable referral-ask body (length=${cleaned.length}), using template`);
      return fallbackTemplate;
    }
    return cleaned;
  } catch (err) {
    log.warn(`Claude personalization failed for referral-ask (${err.message}), using template fallback`);
    return fallbackTemplate;
  }
}

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

      // Build message (template used as AI fallback)
      const template = smsTemplates.referral_request
        || 'Hey {name}! If you know anyone who needs our services, we offer a $${referral_bonus} referral bonus. Just have them mention your name!';
      const fallbackBody = template
        .replace(/{name}/g, lead.name || 'there')
        .replace(/{business_name}/g, businessName)
        .replace(/\$\{referral_bonus\}/g, referralBonus)
        .replace(/{referral_bonus}/g, referralBonus);

      // Module 10.2 — AI personalization. Falls back to template on failure.
      const useAi = getConfig(tenant, 'referral_request_use_ai', true);
      const messageBody = useAi
        ? await generatePersonalizedReferralAsk(tenant, lead, referralBonus, fallbackBody, log)
        : fallbackBody;

      log.info(`Sending referral request to ${lead.name}`, { ai: useAi });

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

  // Module 10.5 — Payout queue sweep. Look for referral_credits that
  // are still 'pending' but whose referee_lead has flipped to won (or
  // lost). Move them to 'owed' or 'void' accordingly so the owner
  // knows who's actually earned a payout.
  let owed = 0;
  let voided = 0;
  try {
    const { data: pending } = await db
      .from('referral_credits')
      .select('id, referee_lead_id, leads!referral_credits_referee_lead_id_fkey(status)')
      .eq('tenant_id', tenant.id)
      .eq('status', 'pending');
    for (const c of (pending || [])) {
      const refereeStatus = c.leads?.status;
      if (refereeStatus === 'won') {
        await db.from('referral_credits').update({
          status: 'owed',
          owed_at: new Date().toISOString(),
        }).eq('id', c.id).eq('tenant_id', tenant.id);
        owed++;
      } else if (refereeStatus === 'lost') {
        await db.from('referral_credits').update({ status: 'void' })
          .eq('id', c.id).eq('tenant_id', tenant.id);
        voided++;
      }
    }
    if (owed || voided) log.info(`Referral credits swept: ${owed} owed, ${voided} voided`);
  } catch (sweepErr) {
    log.warn(`Referral payout sweep failed: ${sweepErr.message}`);
  }

  const result = {
    success: true,
    sent,
    skipped,
    payouts_owed: owed,
    payouts_voided: voided,
    processed,
    errors,
    ...(capInfo ? { sms_cap_reached: true, cap: capInfo.cap, count: capInfo.count } : {})
  };
  log.success('Referral request run completed', { sent, skipped, cap_reached: capReached, owed, voided });
  return result;
}

module.exports = run;
