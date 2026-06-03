/**
 * Growth OS — Past-Customer Re-Engagement Agent (Module 4.7)
 *
 * Finds won leads whose last touch was more than N months ago and sends
 * a re-engagement SMS (and email if configured). The goal is repeat
 * business — most home-service customers buy on a 1-2 year cadence and
 * the system shouldn't quietly forget them.
 *
 * Scheduled weekly. Idempotent per lead per quarter so we don't spam.
 * Respects opt-out status, SMS volume cap, and tenant brand voice.
 *
 * After a successful send the lead's status is flipped from `won` to
 * `contacted` so the normal follow-up cadence engine picks it up for any
 * back-and-forth that develops — i.e. they reply "yeah, come give us a
 * quote on the new tree out back" and the regular follow-up sequence
 * carries the conversation forward.
 */

const { createLogger } = require('../../core/logger');
const { getConfig } = require('../../core/config');
const { db } = require('../../db/client');
const { sendSms, SmsCapExceededError } = require('../../integrations/telnyx');
const { sendEmail } = require('../../integrations/email');
const { claudeHaiku, askClaudeJSON } = require('../../integrations/claude');
const { checkIdempotency, recordIdempotency } = require('../../db/queries/jobs');

const DEFAULT_REENGAGE_MONTHS = 6;
const QUARTER_DAYS = 90;
const BATCH_LIMIT = 25;

function monthsAgo(dateStr) {
  if (!dateStr) return null;
  const ms = Date.now() - new Date(dateStr).getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24 * 30));
}

async function generateReengageSms(tenant, lead, monthsSince, log) {
  const businessName = getConfig(tenant, 'business_name', tenant.name || 'Our Team');
  const brandVoice = getConfig(tenant, 'brand_voice', 'Friendly, professional, no-nonsense.');
  const firstName = (lead.name || '').split(/\s+/)[0] || '';

  const systemPrompt = `You are writing a single re-engagement SMS for ${businessName} to a past customer who hasn't been in touch for ${monthsSince}+ months. Brand voice: ${brandVoice}

Rules:
- Output ONLY the SMS body. No quotes.
- 25-45 words MAX.
- Warm, not pushy. Acknowledge the time gap naturally.
- Reference the original service if known.
- Offer one concrete reason to re-engage (seasonal tune-up, follow-on work, anniversary discount if the tenant configured one — otherwise just an open-ended check-in).
- End with an easy yes/no question they can text back to.
- No "Reply STOP" — appended elsewhere.`;

  const context = [
    `Past customer: ${firstName || '(no name)'}`,
    lead.service_type ? `Original service: ${lead.service_type}` : null,
    `Months since last touch: ${monthsSince}`,
    lead.city ? `City: ${lead.city}` : null,
  ].filter(Boolean).join('\n');

  try {
    const reply = await claudeHaiku(systemPrompt, `Context:\n${context}\n\nWrite the SMS.`, {
      maxTokens: 220,
      tenantSlug: tenant.slug,
    });
    const cleaned = String(reply || '').trim().replace(/^["']|["']$/g, '');
    if (!cleaned || cleaned.length < 10 || cleaned.length > 480) {
      log.warn(`Re-engage SMS unusable (len=${cleaned.length}); using fallback`);
      return `Hi${firstName ? ' ' + firstName : ''}, it's ${businessName} — been a while! If you've got any${lead.service_type ? ' ' + lead.service_type : ''} work coming up, happy to take a look. Just text back yes or no.`;
    }
    return cleaned;
  } catch (err) {
    log.warn(`Re-engage SMS generation failed: ${err.message}`);
    return `Hi${firstName ? ' ' + firstName : ''}, it's ${businessName} — been a while! Anything you'd like us to take a look at? Reply yes or no.`;
  }
}

async function generateReengageEmail(tenant, lead, monthsSince, smsBody, log) {
  const businessName = getConfig(tenant, 'business_name', tenant.name || 'Our Team');
  const brandVoice = getConfig(tenant, 'brand_voice', 'Friendly, professional, no-nonsense.');
  const ownerName = getConfig(tenant, 'owner_name', '');
  const firstName = (lead.name || '').split(/\s+/)[0] || '';

  const fallback = {
    subject: `Been a while — ${businessName}`,
    body: `${firstName ? `Hi ${firstName},` : 'Hi,'}\n\n${smsBody}\n\n${ownerName || businessName}`,
  };

  try {
    const result = await askClaudeJSON(
      `You are writing a re-engagement email for ${businessName} to a past customer (${monthsSince}+ months since last touch). Brand voice: ${brandVoice}. Return JSON: { "subject": "<6-10 words>", "body": "<3-5 short sentences, plain text>" }. Sign off as ${ownerName || businessName}. No marketing fluff.`,
      `Past customer: ${firstName}\nOriginal service: ${lead.service_type || 'unknown'}\nMonths since last touch: ${monthsSince}\n\nWrite the email.`,
      { maxTokens: 500, tenantSlug: tenant.slug },
    );
    if (!result?.subject || !result?.body) return fallback;
    return {
      subject: String(result.subject).slice(0, 120),
      body: String(result.body).slice(0, 2000),
    };
  } catch (err) {
    log.warn(`Re-engage email generation failed: ${err.message}`);
    return fallback;
  }
}

function emailBodyToHtml(plainBody, businessName) {
  const escaped = String(plainBody)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const paragraphs = escaped
    .split(/\n{2,}/)
    .map((p) => `<p style="margin: 0 0 14px 0;">${p.replace(/\n/g, '<br>')}</p>`)
    .join('');
  return `<!doctype html><html><body style="font-family: -apple-system, Segoe UI, sans-serif; color: #0f172a; max-width: 560px; margin: 0 auto; padding: 24px 16px; line-height: 1.55; font-size: 15px;">${paragraphs}<p style="color: #64748b; font-size: 12px; margin-top: 28px;">Sent on behalf of ${businessName}. Reply to opt out.</p></body></html>`;
}

async function run(tenant, payload = {}) {
  const log = createLogger('past-cust-reengage', tenant.slug);

  const tw = tenant?.integrations?.twilio;
  const hasTwilio = !!(tw && tw.credentials?.account_sid && tw.config?.phone_number);
  const emailEnabled = !!getConfig(tenant, 'follow_up_email_enabled', true);
  if (!hasTwilio && !emailEnabled) {
    log.info('No send channel available — skipping');
    return { success: true, skipped: true, reason: 'no_send_channel' };
  }

  const monthsThreshold = Number(getConfig(tenant, 'past_customer_reengagement_months', DEFAULT_REENGAGE_MONTHS));
  const limit = Number(payload.limit || BATCH_LIMIT);
  const cutoff = new Date(Date.now() - monthsThreshold * 30 * 24 * 60 * 60 * 1000).toISOString();

  // Pull won leads whose most recent activity is older than the cutoff.
  // We use updated_at as the freshness signal — every send writes it.
  const { data: leads, error: leadsErr } = await db
    .from('leads')
    .select('id, name, phone, email, status, service_type, city, updated_at, contacts(id, is_primary_contact, contact_status)')
    .eq('tenant_id', tenant.id)
    .eq('status', 'won')
    .lt('updated_at', cutoff)
    .order('updated_at', { ascending: true })
    .limit(limit);

  if (leadsErr) throw leadsErr;
  if (!leads || leads.length === 0) {
    log.info('No past customers due for re-engagement');
    return { success: true, sent: 0, skipped: 0 };
  }

  let sent = 0;
  let skipped = 0;
  let capReached = false;
  const processed = [];
  const errors = [];

  for (const lead of leads) {
    if (capReached) { skipped++; processed.push({ lead_id: lead.id, action: 'sms_cap_reached' }); continue; }
    try {
      const hasSms = !!lead.phone && hasTwilio;
      const hasEmail = emailEnabled && !!lead.email;
      if (!hasSms && !hasEmail) {
        skipped++; processed.push({ lead_id: lead.id, action: 'no_channel' }); continue;
      }

      // Opt-out check (use primary contact if present)
      const primary = (lead.contacts || []).find((c) => c.is_primary_contact) || (lead.contacts || [])[0];
      if (primary?.contact_status && ['unsubscribed', 'opted_out', 'do_not_contact', 'bounced'].includes(primary.contact_status)) {
        skipped++; processed.push({ lead_id: lead.id, action: 'opted_out' }); continue;
      }

      // Quarterly idempotency — don't re-engage more often than every 90 days.
      const quarterKey = `past-reengage:${lead.id}:${Math.floor(Date.now() / (QUARTER_DAYS * 24 * 60 * 60 * 1000))}`;
      const seen = await checkIdempotency(tenant.id, quarterKey);
      if (seen) {
        skipped++; processed.push({ lead_id: lead.id, action: 'already_reengaged_this_quarter' }); continue;
      }

      const monthsSince = monthsAgo(lead.updated_at) ?? monthsThreshold;
      const smsBody = await generateReengageSms(tenant, lead, monthsSince, log);

      let smsResult = null;
      if (hasSms) {
        try {
          smsResult = await sendSms(tenant.integrations, lead.phone, smsBody, {
            tenantSlug: tenant.slug, tenant,
          });
        } catch (err) {
          if (err instanceof SmsCapExceededError) {
            capReached = true;
            log.warn(`SMS cap reached (${err.count}/${err.cap}); halting`);
          } else {
            throw err;
          }
        }
      }

      let emailResult = null;
      if (hasEmail) {
        try {
          const em = await generateReengageEmail(tenant, lead, monthsSince, smsBody, log);
          const html = emailBodyToHtml(em.body, getConfig(tenant, 'business_name', tenant.name || 'Our Team'));
          emailResult = await sendEmail(lead.email, em.subject, html, { tenant });

          await db.from('messages').insert({
            tenant_id: tenant.id,
            contact_id: primary?.id || null,
            channel: 'email',
            direction: 'outbound',
            body: em.body,
            external_id: emailResult?.id || null,
            status: 'sent',
            sent_at: new Date().toISOString(),
          });
          await db.from('conversations').insert({
            tenant_id: tenant.id,
            lead_id: lead.id,
            contact_id: primary?.id || null,
            channel: 'email',
            direction: 'outbound',
            message_body: em.body,
            metadata: { agent: 'past-customer-reengagement', external_id: emailResult?.id || null, subject: em.subject, months_since: monthsSince },
          });
        } catch (emailErr) {
          log.warn(`Re-engage email failed for ${lead.name}: ${emailErr.message}`);
        }
      }

      if (smsResult) {
        await db.from('messages').insert({
          tenant_id: tenant.id,
          contact_id: primary?.id || null,
          channel: 'sms',
          direction: 'outbound',
          body: smsBody,
          external_id: smsResult.sid,
          status: 'sent',
          sent_at: new Date().toISOString(),
        });
        await db.from('conversations').insert({
          tenant_id: tenant.id,
          lead_id: lead.id,
          contact_id: primary?.id || null,
          channel: 'sms',
          direction: 'outbound',
          message_body: smsBody,
          metadata: { agent: 'past-customer-reengagement', external_id: smsResult.sid, months_since: monthsSince },
        });
      }

      if (!smsResult && !emailResult) {
        skipped++;
        processed.push({ lead_id: lead.id, action: 'no_channel_succeeded' });
        continue;
      }

      // Flip status to 'contacted' so the regular follow-up cadence carries
      // any back-and-forth from here forward. Bump updated_at to reset the
      // "months since" clock either way (so we don't re-trigger next week).
      await db.from('leads')
        .update({
          status: 'contacted',
          lifecycle_stage: 'reengaged',
          updated_at: new Date().toISOString(),
        })
        .eq('id', lead.id)
        .eq('tenant_id', tenant.id);

      await recordIdempotency(tenant.id, quarterKey, 'reengaged', {
        message_sid: smsResult?.sid || null,
        email_id: emailResult?.id || null,
        months_since: monthsSince,
      });

      sent++;
      processed.push({
        lead_id: lead.id,
        name: lead.name,
        action: 'sent',
        channels: [smsResult ? 'sms' : null, emailResult ? 'email' : null].filter(Boolean),
        months_since: monthsSince,
      });
      log.success(`Re-engaged ${lead.name} after ${monthsSince}mo`);
    } catch (err) {
      log.error(`Re-engagement failed for ${lead.name}`, err);
      errors.push({ lead_id: lead.id, error: err.message });
    }
  }

  log.success(`Past-customer re-engagement complete — sent=${sent}, skipped=${skipped}`);
  return { success: true, sent, skipped, processed, errors };
}

module.exports = run;
