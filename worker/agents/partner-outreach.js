/**
 * Growth OS — Referral Partner Outreach Agent
 *
 * Module 11. Keeps referral partners (realtors, insurance agents,
 * property managers, other contractors) warm with AI-generated
 * personalized touchpoints. Without this, partners go cold and
 * stop sending referrals; even one active partner is worth 1-3
 * jobs/month for years.
 *
 * Scheduled: daily at 10am. Per partner, the agent decides what
 * action they're "due for" based on outreach_status, last_contacted_at,
 * and the current calendar:
 *
 *   1. Cold (no contact in 90+ days)
 *      → AI-generated re-engagement message ("hey, been a while,
 *        wanted to check in"). Module 11.4.
 *
 *   2. Quarterly check-in due (no contact in 80-90 days)
 *      → AI-generated quarterly check-in referencing a recent job
 *        or the season. Module 11.1.
 *
 *   3. Seasonal opportunity (start of season for industry)
 *      → AI-generated seasonal resource (winterization tip for
 *        plumbing partners, spring-prep for landscapers, etc.).
 *        Module 11.2.
 *
 *   4. Holiday (within 5 days of a major US holiday)
 *      → AI-generated holiday note (no pitch, just a thanks/wish).
 *        Module 11.3.
 *
 *   5. Recently contacted → skip
 *
 * Partner identification: contacts.contact_type='referral_partner'
 * (already populated by the seed scripts + the onboarding "customers"
 * step). active/dormant tracking lives on contacts.outreach_status.
 *
 * Channel selection: prefers email when contact.email exists (longer
 * messages, less intrusive). Falls back to SMS when only phone is
 * present.
 */

const { createLogger } = require('../../core/logger');
const { getConfig } = require('../../core/config');
const { db } = require('../../db/client');
const { sendSms, SmsCapExceededError } = require('../../integrations/telnyx');
const { hasTelnyxMessaging } = require('../../core/telnyx-readiness');
const { sendEmail } = require('../../integrations/email');
const { claudeHaiku } = require('../../integrations/claude');
const { stripAiTells, NO_DASH_PROMPT_RULE } = require('../../core/text-style');
const { checkIdempotency, recordIdempotency } = require('../../db/queries/jobs');

// US holidays we'll send notes around. Date is MM-DD; we fire any
// time within 5 days of these (so Thanksgiving sends in the week
// before, etc.). Easter shifts so it's omitted; tenants can add their
// own via tenant_config.partner_holidays.
const DEFAULT_HOLIDAYS = [
  { date: '01-01', name: "New Year's" },
  { date: '02-14', name: "Valentine's Day" },
  { date: '05-12', name: "Mother's Day (~)" },
  { date: '06-16', name: "Father's Day (~)" },
  { date: '07-04', name: 'Independence Day' },
  { date: '11-27', name: 'Thanksgiving (~)' },
  { date: '12-25', name: 'Christmas' },
];

// Per-industry seasonal moments. tenant.industry → array of
// {window_start: 'MM-DD', window_end: 'MM-DD', label, resource_topic}.
const SEASONAL_TOPICS = {
  plumbing: [
    { window_start: '10-15', window_end: '11-15', label: 'pre-winter', resource_topic: 'winterizing pipes and outdoor spigots' },
    { window_start: '04-01', window_end: '04-30', label: 'spring', resource_topic: 'spring plumbing check (water heater age, sediment flush)' },
  ],
  hvac: [
    { window_start: '09-15', window_end: '10-31', label: 'heating season prep', resource_topic: 'furnace tune-up and filter change before heating season' },
    { window_start: '04-15', window_end: '05-31', label: 'cooling season prep', resource_topic: 'AC tune-up before summer heat hits' },
  ],
  landscaping: [
    { window_start: '02-15', window_end: '03-31', label: 'spring kickoff', resource_topic: 'spring landscape cleanup and bed prep' },
    { window_start: '09-15', window_end: '10-31', label: 'fall cleanup', resource_topic: 'leaf cleanup, gutter, and winter prep' },
  ],
  'tree service': [
    { window_start: '01-01', window_end: '02-28', label: 'dormant pruning', resource_topic: 'winter dormant pruning safety' },
    { window_start: '09-01', window_end: '10-31', label: 'storm season', resource_topic: 'pre-storm hazard tree assessment' },
  ],
  electrical: [
    { window_start: '10-01', window_end: '11-15', label: 'holiday electrical safety', resource_topic: 'holiday lighting circuit safety + GFCI checks' },
  ],
  roofing: [
    { window_start: '03-01', window_end: '04-15', label: 'spring inspection', resource_topic: 'spring roof inspection after winter wear' },
    { window_start: '08-15', window_end: '10-15', label: 'storm prep', resource_topic: 'pre-storm roof inspection' },
  ],
};

function todayMMDD() {
  const d = new Date();
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function daysBetween(dateA, dateB) {
  return Math.floor((new Date(dateB).getTime() - new Date(dateA).getTime()) / (1000 * 60 * 60 * 24));
}

function withinWindow(mmdd, start, end) {
  // simple lexicographic comparison works for MM-DD within same year.
  return mmdd >= start && mmdd <= end;
}

function daysToHoliday(targetMMDD) {
  const now = new Date();
  const [m, d] = targetMMDD.split('-').map(Number);
  const target = new Date(now.getFullYear(), m - 1, d);
  return Math.ceil((target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Decide what action a given partner is "due for" today.
 * Returns { intent, context } or null if nothing is due.
 */
function decideAction(partner, tenant) {
  const today = todayMMDD();
  const last = partner.last_contacted_at;
  const daysSinceLast = last ? daysBetween(last, new Date()) : 9999;

  // Skip if recently contacted
  if (daysSinceLast < 30) return null;
  // Skip if marked unsubscribed
  if (['unsubscribed', 'opted_out', 'do_not_contact', 'bounced'].includes(partner.contact_status)) return null;

  // 1. Holiday (within 5 days before)
  const holidays = getConfig(tenant, 'partner_holidays', DEFAULT_HOLIDAYS);
  for (const h of holidays) {
    const dtoh = daysToHoliday(h.date);
    if (dtoh >= 0 && dtoh <= 5) {
      return { intent: 'holiday', context: { holiday_name: h.name, days_to_holiday: dtoh } };
    }
  }

  // 2. Seasonal opportunity for tenant's industry
  const tenantIndustry = (getConfig(tenant, 'industry', '') || '').toLowerCase();
  const seasonals = SEASONAL_TOPICS[tenantIndustry] || [];
  for (const s of seasonals) {
    if (withinWindow(today, s.window_start, s.window_end)) {
      return { intent: 'seasonal', context: { season_label: s.label, resource_topic: s.resource_topic } };
    }
  }

  // 3. Cold re-engagement (90+ days since last contact)
  if (daysSinceLast >= 90) {
    return { intent: 're_engagement', context: { days_silent: daysSinceLast } };
  }

  // 4. Quarterly check-in (80-90 days since last)
  if (daysSinceLast >= 80) {
    return { intent: 'quarterly', context: { days_since_last: daysSinceLast } };
  }

  return null;
}

/**
 * AI-generated message body per intent. Channel-aware (email gets
 * longer body + subject; SMS gets a single concise block).
 */
async function generateMessage(tenant, partner, decision, channel, log) {
  const businessName = getConfig(tenant, 'business_name', tenant.name || 'Our Team');
  const ownerName = getConfig(tenant, 'owner_name', getConfig(tenant, 'founder_name', null));
  const brandVoice = getConfig(tenant, 'brand_voice', 'Friendly, professional, no-nonsense. Sounds like a real person.');
  const tenantIndustry = getConfig(tenant, 'industry', '');

  const intentDescriptions = {
    holiday: `Send a brief holiday wish for ${decision.context.holiday_name}. No pitch. Just a thanks for the partnership and a warm wish.`,
    seasonal: `Send a seasonal resource for the ${decision.context.season_label} window. Useful tip about ${decision.context.resource_topic} they can pass along to their own clients. Frame it as "thought of you" not "buy from me."`,
    quarterly: 'Quarterly check-in. Has been about 3 months since last touch. Ask how their business is going, share one quick recent win or insight, and offer to help if any of their clients need ${tenantIndustry || "what we do"}.',
    re_engagement: `It's been ${decision.context.days_silent} days since last contact. Re-engage warmly without guilt-tripping. Acknowledge time has passed. Reinforce that we value the partnership and would love to help any of their clients who need ${tenantIndustry || 'what we do'}.`,
  };

  const channelRules = channel === 'email'
    ? `Channel: email. Output JSON {"subject": "...", "body": "..."}. Subject 4-8 words, no salesy emoji. Body 60-130 words, plain text (no HTML tags), reads like a personal note. Sign off with ${ownerName ? '"' + ownerName + '"' : `"the ${businessName} team"`}.`
    : `Channel: SMS. Output ONLY the SMS body (no JSON, no quotes). 25-60 words. One clear thought. No subject line, no signature.`;

  const partnerFirstName = (partner.first_name || partner.name || '').split(/\s+/)[0] || '';
  const context = [
    `Partner first name: ${partnerFirstName || '(unknown)'}`,
    partner.title ? `Their title: ${partner.title}` : null,
    partner.company ? `Their company: ${partner.company}` : null,
    `Your business: ${businessName} (${tenantIndustry || 'service business'})`,
    `Intent of this message: ${intentDescriptions[decision.intent]}`,
    `Brand voice: ${brandVoice}`,
  ].filter(Boolean).join('\n');

  const systemPrompt = `You write short, personal outreach messages to a referral partner of ${businessName}. Make it feel like a real human note, not a marketing template. NEVER include "Reply STOP to unsubscribe" (that gets appended elsewhere for SMS).

${NO_DASH_PROMPT_RULE}

${channelRules}`;

  try {
    if (channel === 'email') {
      const { askClaudeJSON } = require('../../integrations/claude');
      const result = await askClaudeJSON(systemPrompt, `Context:\n${context}\n\nWrite the email now. JSON only.`, { maxTokens: 600, tenantSlug: tenant.slug });
      if (!result.subject || !result.body) throw new Error('missing subject/body');
      // House style: strip em/en dashes, curly quotes, ellipsis so it reads human.
      return { subject: stripAiTells(String(result.subject).slice(0, 120)), body: stripAiTells(String(result.body).slice(0, 2500)) };
    } else {
      const text = await claudeHaiku(systemPrompt, `Context:\n${context}\n\nWrite the SMS now.`, { maxTokens: 240, tenantSlug: tenant.slug });
      const cleaned = stripAiTells(String(text || '').trim().replace(/^["']|["']$/g, ''));
      if (!cleaned || cleaned.length < 20 || cleaned.length > 600) throw new Error(`unusable body (length=${cleaned.length})`);
      return { body: cleaned };
    }
  } catch (err) {
    log.warn(`Claude generation failed for ${decision.intent} (${err.message}) — falling back`);
    // Deterministic fallback so the agent never silently no-ops on Claude failure.
    const fallback = decision.intent === 'holiday'
      ? `Quick note from ${businessName} — happy ${decision.context.holiday_name} from our crew to yours. Thanks for being a partner.`
      : decision.intent === 'seasonal'
      ? `Hi${partnerFirstName ? ' ' + partnerFirstName : ''}, ${decision.context.season_label} season — heads up for any of your clients, ${decision.context.resource_topic}. We can take care of it if you ever need a referral. — ${businessName}`
      : decision.intent === 'quarterly'
      ? `Hi${partnerFirstName ? ' ' + partnerFirstName : ''}, just checking in from ${businessName}. Been a few months — anything going on with your clients we can help with? — ${ownerName || businessName}`
      : `Hi${partnerFirstName ? ' ' + partnerFirstName : ''} — it's been a while. We're still here, still working with your kind of clients. If any of them need ${tenantIndustry || 'what we do'}, send them our way. — ${ownerName || businessName}`;
    return channel === 'email'
      ? { subject: `Quick note from ${businessName}`, body: fallback }
      : { body: fallback };
  }
}

/**
 * @param {Object} tenant
 * @param {Object} payload - { limit }
 */
async function run(tenant, payload = {}) {
  const log = createLogger('partner-outreach', tenant.slug);
  const limit = Number(payload.limit || 25);

  const telnyxReady = hasTelnyxMessaging(tenant);

  // Fetch referral partners for this tenant
  const { data: partners, error } = await db
    .from('contacts')
    .select('id, name, first_name, last_name, title, company, email, phone, contact_status, outreach_status, last_contacted_at')
    .eq('tenant_id', tenant.id)
    .eq('contact_type', 'referral_partner')
    .order('last_contacted_at', { ascending: true, nullsFirst: true })
    .limit(limit);

  if (error) throw error;
  if (!partners || !partners.length) {
    log.info('No referral partners on file');
    return { success: true, sent: 0, message: 'No partners' };
  }

  log.info(`Reviewing ${partners.length} partners for outreach`);

  let sent = 0;
  let skipped = 0;
  const processed = [];
  const errors = [];

  for (const partner of partners) {
    try {
      const decision = decideAction(partner, tenant);
      if (!decision) {
        skipped++;
        processed.push({ partner_id: partner.id, name: partner.name, action: 'nothing_due' });
        continue;
      }

      // Idempotency — at most one partner touch per day per intent
      const today = new Date().toISOString().slice(0, 10);
      const idempKey = `partner-outreach:${partner.id}:${decision.intent}:${today}`;
      const existing = await checkIdempotency(tenant.id, idempKey);
      if (existing) {
        skipped++;
        processed.push({ partner_id: partner.id, name: partner.name, action: 'already_sent_today', intent: decision.intent });
        continue;
      }

      // Channel selection: email preferred when available (longer body
      // suits these touchpoints better). SMS fallback when only phone.
      const channel = partner.email ? 'email' : (partner.phone && telnyxReady ? 'sms' : null);
      if (!channel) {
        skipped++;
        processed.push({ partner_id: partner.id, name: partner.name, action: 'no_channel' });
        continue;
      }

      const msg = await generateMessage(tenant, partner, decision, channel, log);

      let externalId = null;
      if (channel === 'email') {
        // Correct sendEmail signature: (to, subject, html, options). Identity
        // (from/reply-to/signature) is enforced by the tenant identity gate.
        const bodyHtml = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,sans-serif;color:#0f172a;max-width:560px;margin:0 auto;padding:24px 16px;line-height:1.55;font-size:15px;">${String(msg.body).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px 0;">${p.replace(/\n/g, '<br>')}</p>`).join('')}</body></html>`;
        const result = await sendEmail(partner.email, msg.subject, bodyHtml, {
          tenant, audience: 'customer', text: msg.body, ownership: { partner },
        });
        externalId = result?.id || null;
      } else {
        try {
          const result = await sendSms(tenant.integrations, partner.phone, msg.body, { tenantSlug: tenant.slug, tenant });
          externalId = result?.sid || null;
        } catch (smsErr) {
          if (smsErr instanceof SmsCapExceededError) {
            log.warn(`SMS cap reached during partner outreach — halting`);
            break;
          }
          throw smsErr;
        }
      }

      // Log + update partner contact + idempotency
      await db.from('conversations').insert({
        tenant_id: tenant.id,
        contact_id: partner.id,
        channel,
        direction: 'outbound',
        message_subject: channel === 'email' ? msg.subject : null,
        message_body: msg.body,
        metadata: { agent: 'partner-outreach', intent: decision.intent, external_id: externalId, context: decision.context },
      });

      await db.from('contacts')
        .update({
          last_contacted_at: new Date().toISOString(),
          outreach_status: 'active',
          updated_at: new Date().toISOString(),
        })
        .eq('id', partner.id)
        .eq('tenant_id', tenant.id);

      await recordIdempotency(tenant.id, idempKey, `partner_${decision.intent}`, { external_id: externalId, channel });

      sent++;
      processed.push({ partner_id: partner.id, name: partner.name, action: 'sent', intent: decision.intent, channel });
      log.success(`Partner outreach (${decision.intent}, ${channel}) → ${partner.name}`);
    } catch (err) {
      log.error(`Partner outreach failed for ${partner.name}`, err);
      errors.push({ partner_id: partner.id, name: partner.name, error: err.message });
    }
  }

  // Mark partners dormant if 180+ days silent and outreach_status was 'active'
  let dormantMarked = 0;
  try {
    const cutoff = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();
    const { data: dormant } = await db
      .from('contacts')
      .update({ outreach_status: 'dormant', updated_at: new Date().toISOString() })
      .eq('tenant_id', tenant.id)
      .eq('contact_type', 'referral_partner')
      .eq('outreach_status', 'active')
      .lt('last_contacted_at', cutoff)
      .select('id');
    dormantMarked = (dormant || []).length;
    if (dormantMarked) log.info(`Marked ${dormantMarked} partners dormant (no contact in 180+ days)`);
  } catch (dormErr) {
    log.warn(`Dormant-marking sweep failed: ${dormErr.message}`);
  }

  log.success('Partner outreach run complete', { sent, skipped, dormant_marked: dormantMarked });
  return { success: true, sent, skipped, dormant_marked: dormantMarked, processed, errors };
}

module.exports = run;
