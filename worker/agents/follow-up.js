/**
 * Growth OS — Follow-Up Agent
 * Sends multi-step SMS follow-up sequences to leads that haven't responded.
 *
 * Scheduled: hourly during business hours (8am-6pm weekdays)
 * Uses contacts.drip_stage to track position in sequence.
 * Respects configurable follow_up_steps and spacing.
 */

const { createLogger } = require('../../core/logger');
const { getConfig } = require('../../core/config');
const { db } = require('../../db/client');
const { sendSms, SmsCapExceededError } = require('../../integrations/twilio');
const { checkIdempotency, recordIdempotency } = require('../../db/queries/jobs');

/**
 * Render SMS template with lead/contact data
 */
function renderTemplate(template, lead, tenant) {
  const businessName = getConfig(tenant, 'business_name', tenant.name || 'Our Team');
  return template
    .replace(/{name}/g, lead.name || 'there')
    .replace(/{business_name}/g, businessName)
    .replace(/{service_type}/g, lead.service_type || 'your needs');
}

/**
 * Check if enough time has passed since last contact
 */
function isReadyForFollowUp(lastContactedAt, minHoursBetween) {
  if (!lastContactedAt) return true;
  const hoursSince = (Date.now() - new Date(lastContactedAt).getTime()) / (1000 * 60 * 60);
  return hoursSince >= minHoursBetween;
}

/**
 * @param {Object} tenant - Resolved tenant
 * @param {Object} payload - { limit }
 */
async function run(tenant, payload = {}) {
  const log = createLogger('follow-up', tenant.slug);

  const maxSteps = Number(getConfig(tenant, 'follow_up_steps', 3));
  const triggerStatus = getConfig(tenant, 'follow_up_trigger_status', 'contacted');
  const hoursBetween = Number(getConfig(tenant, 'follow_up_hours_between', 24));
  const limit = Number(payload.limit || 25);
  const smsTemplates = getConfig(tenant, 'sms_templates', {});

  log.info('Starting follow-up run', { maxSteps, triggerStatus, hoursBetween });

  // Find leads in the trigger status that have a phone number
  // and haven't been won/lost yet. Pull only the contact fields we need.
  const { data: leads, error: leadsErr } = await db
    .from('leads')
    .select('id, name, phone, status, service_type, contacts(id, is_primary_contact, drip_stage, last_contacted_at)')
    .eq('tenant_id', tenant.id)
    .in('status', [triggerStatus, 'contacted', 'estimate_given'])
    .not('phone', 'is', null)
    .order('updated_at', { ascending: true })
    .limit(limit);

  if (leadsErr) throw leadsErr;

  if (!leads || leads.length === 0) {
    log.info('No leads due for follow-up');
    return { success: true, sent: 0, skipped: 0, message: 'No leads due for follow-up' };
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
      // Resolve or create the lead's primary contact so drip_stage has a home.
      // Without this, B2C leads (no contact row) would re-send step 1 every day forever.
      let primaryContact = lead.contacts?.find(c => c.is_primary_contact) || lead.contacts?.[0];

      if (!primaryContact) {
        const { data: created, error: createErr } = await db
          .from('contacts')
          .insert({
            tenant_id: tenant.id,
            lead_id: lead.id,
            name: lead.name || 'Unknown',
            phone: lead.phone,
            is_primary_contact: true,
            drip_stage: 0
          })
          .select('id, is_primary_contact, drip_stage, last_contacted_at')
          .single();

        if (createErr || !created) {
          log.warn('Could not create primary contact; skipping lead', { lead_id: lead.id, err: createErr?.message });
          skipped++;
          processed.push({ lead_id: lead.id, name: lead.name, action: 'contact_create_failed' });
          continue;
        }
        primaryContact = created;
      }

      const currentStage = primaryContact.drip_stage || 0;
      const lastContacted = primaryContact.last_contacted_at || null;

      // Check if we've already completed the sequence
      if (currentStage >= maxSteps) {
        skipped++;
        processed.push({ lead_id: lead.id, name: lead.name, action: 'sequence_complete' });
        continue;
      }

      // Check timing
      if (!isReadyForFollowUp(lastContacted, hoursBetween)) {
        skipped++;
        processed.push({ lead_id: lead.id, name: lead.name, action: 'too_soon' });
        continue;
      }

      // Idempotency — don't send the same step twice in one day
      const today = new Date().toISOString().slice(0, 10);
      const idempKey = `follow-up:${lead.id}:step${currentStage + 1}:${today}`;
      const existing = await checkIdempotency(tenant.id, idempKey);
      if (existing) {
        skipped++;
        processed.push({ lead_id: lead.id, name: lead.name, action: 'already_sent_today' });
        continue;
      }

      // Select the template for this step
      const nextStep = currentStage + 1;
      const templateKey = `follow_up_${nextStep}`;
      const template = smsTemplates[templateKey]
        || `Hi {name}, just following up from {business_name}. Any questions we can answer?`;
      const messageBody = renderTemplate(template, lead, tenant);

      log.info(`Sending follow-up step ${nextStep} to ${lead.name}`);

      // Send SMS (with monthly volume cap enforcement)
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
          log.warn(`SMS cap reached (${err.count}/${err.cap}); halting follow-up run`);
          skipped++;
          processed.push({ lead_id: lead.id, name: lead.name, action: 'sms_cap_reached' });
          continue;
        }
        throw err;
      }

      // Log the message
      await db.from('messages').insert({
        tenant_id: tenant.id,
        contact_id: primaryContact?.id || null,
        channel: 'sms',
        direction: 'outbound',
        body: messageBody,
        external_id: smsResult.sid,
        status: 'sent',
        sent_at: new Date().toISOString()
      });

      // Advance the drip stage on the contact (always exists at this point)
      await db.from('contacts')
        .update({
          drip_stage: nextStep,
          last_contacted_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('id', primaryContact.id)
        .eq('tenant_id', tenant.id);

      // Record idempotency
      await recordIdempotency(tenant.id, idempKey, 'follow_up_sent', {
        step: nextStep,
        message_sid: smsResult.sid
      });

      sent++;
      processed.push({
        lead_id: lead.id,
        name: lead.name,
        action: 'sent',
        step: nextStep,
        message_sid: smsResult.sid
      });

      log.success(`Follow-up step ${nextStep} sent to ${lead.name}`);
    } catch (err) {
      log.error(`Follow-up failed for ${lead.name}`, err);
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
  log.success('Follow-up run completed', { sent, skipped, cap_reached: capReached });
  return result;
}

module.exports = run;
