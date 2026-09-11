/**
 * Growth OS — Sales-Nurture Agent (FGA tenant)
 *
 * Handles three time-based nurture cadences on FGA's own sales
 * pipeline (the only tenant that uses these stages today). One agent,
 * three handlers, all email:
 *
 *   1. demo_followup   — leads sitting in `demo_booked` for >3 days
 *                        with no movement get a soft check-in nudge.
 *   2. trial_checkin   — leads in `trial_active` get a day-7 mid-trial
 *                        check-in and a day-13 final ("trial ends
 *                        tomorrow") nudge.
 *   3. nurture_outreach — leads in `nurture` get a monthly "still here
 *                         when you're ready" email.
 *
 * Idempotent per (lead, intent, period) so re-running the cron in the
 * same window is safe.
 *
 * Channel: email only (per the agreed-cadence note in the build plan).
 * Patrick can extend to SMS later by mirroring sendEmail with sendSms.
 *
 * Scheduled: daily at 09:00 ET via worker/scheduler/cron.js.
 * Scoped: FGA tenant only — the pipeline-stage taxonomy is FGA-specific
 *         right now (client tenants don't use 'replied', 'trial_active',
 *         'nurture', 'disqualified'). Skip gracefully on other tenants.
 */

const crypto = require('node:crypto');
const { createLogger } = require('../../core/logger');
const { getConfig } = require('../../core/config');
const { db } = require('../../db/client');
const { sendEmail } = require('../../integrations/email');
const { askClaudeJSON } = require('../../integrations/claude');
const { stripAiTells, NO_DASH_PROMPT_RULE } = require('../../core/text-style');
const { checkIdempotency, recordIdempotency } = require('../../db/queries/jobs');
const { isPlatformTenant } = require('../../core/tenant-email-identity');
const { isSuppressed } = require('../../core/growth/suppression');
const {
  loadProtectedOrganizationIndex,
  matchProtectedOrganization,
} = require('../../core/growth/customer-boundary');
const { renderOutreachEmail } = require('../../core/email-shell');
const { unsubscribeUrl } = require('../../core/drip-campaign');

// Cadence config — keep it editable in one place so Patrick can tune
// without touching the rest of the file.
const CADENCE = {
  demo_followup_days: 3,         // nudge demo_booked leads after N days
  trial_checkin_day1: 7,         // day 7 of 14-day trial → mid check-in
  trial_checkin_day2: 13,        // day 13 → "ends tomorrow" final touch
  nurture_interval_days: 30,     // ~monthly cadence for nurture stage
};

function daysSince(dateStr) {
  if (!dateStr) return null;
  const ms = Date.now() - new Date(dateStr).getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

/**
 * Find the primary contact email for a lead (contacts table first,
 * leads.email as fallback).
 */
async function getLeadEmail(tenantId, lead, database = db) {
  if (lead.email) return lead.email;
  const { data: contacts, error } = await database
    .from('contacts')
    .select('email')
    .eq('tenant_id', tenantId)
    .eq('lead_id', lead.id)
    .order('is_primary_contact', { ascending: false })
    .limit(1);
  if (error) throw new Error(`lead_contact_email_lookup_failed:${error.message}`);
  return contacts?.[0]?.email || null;
}

/**
 * A monthly "still here" note asserts an existing human sales conversation.
 * Pipeline status alone is not evidence of that conversation: four historical
 * cold prospects were labeled `nurture` without any inbound reply and would
 * otherwise receive copy implying they had told Patrick the timing was wrong.
 * Require the durable Gmail reply receipt that also proves automation stopped.
 */
async function hasNurtureReplyEvidence(database, tenantId, leadId) {
  const { data, error } = await database.from('drip_inbound')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('lead_id', leadId)
    .eq('classification', 'genuine_reply')
    .eq('action_taken', 'stopped_campaign')
    .limit(1);
  if (error) throw new Error(`nurture_reply_evidence_failed:${error.message}`);
  return Boolean(data && data.length);
}

/**
 * Tiny helper — render a plain-text body as HTML for the email send,
 * preserving paragraph breaks.
 */
function toHtml(body) {
  const safe = String(body || '').trim()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
  if (!safe) return '<p></p>';
  return `<p>${safe.replace(/\n\n+/g, '</p><p>').replace(/\n/g, '<br>')}</p>`;
}

function deterministicUuid(value) {
  const bytes = Buffer.from(
    crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 32),
    'hex',
  );
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

/**
 * Generate the email copy for a given intent. Uses Claude for
 * personalisation; falls back to a static template on failure so
 * the agent never blocks the cadence.
 */
async function generateEmail({ tenant, lead, intent, log }) {
  const businessName = getConfig(tenant, 'business_name', tenant.name || 'First Gen Automate');
  const senderName = getConfig(tenant, 'sender_name', 'Patrick Jenkins');
  const senderTitle = getConfig(tenant, 'sender_title', 'Founder, First Gen Automate');
  // Same 3-line cold-outreach signature shape as the outreach agent —
  // best-practice compact format. Tenant config can override each.
  const senderPhone = getConfig(tenant, 'sender_phone', '(404) 496-7983');
  const senderWebsite = getConfig(tenant, 'sender_website', 'firstgenautomate.com');
  const contactLine = [senderPhone, senderWebsite].filter(Boolean).join(' · ');
  const signatureBlock = [senderName, senderTitle, contactLine].filter(Boolean).join('\n');
  const firstName = (lead.name || '').split(/\s+/)[0] || '';

  const intentBriefs = {
    demo_followup: `Send a soft check-in to a prospect who booked a demo with ${businessName} ${CADENCE.demo_followup_days}+ days ago but hasn't moved to a proposal. The goal is to remind them you're available, not to push. One sentence acknowledging the time gap, one sentence offering to answer questions or revisit, one short closing question. Don't recap the demo.`,
    trial_checkin_mid: `Send a mid-trial check-in to a prospect who signed up for First Gen Automate's 14-day free trial 7 days ago. Friendly, low pressure. Ask how things are going so far, mention one specific feature they could try (lead capture, content engine, AI voice receptionist depending on tier), offer to hop on a quick call if anything's confusing.`,
    trial_checkin_final: `Send a "trial ends tomorrow" nudge to a prospect on day 13 of a 14-day trial. Be direct but not pushy — let them know billing starts tomorrow, summarize the modules they have, and offer one clear next step (call you with questions, or just let the trial roll into paid).`,
    nurture_monthly: `Send a monthly "still here when you're ready" nurture email to a prospect who said the timing wasn't right. One concrete update on First Gen Automate worth sharing (a new feature, an industry stat, a customer milestone), one sentence reminding them you're a tap away when they want to revisit. No pressure, no sales pitch.`,
  };

  const brief = intentBriefs[intent];
  if (!brief) throw new Error(`Unknown intent: ${intent}`);

  const systemPrompt = `You are writing a single email from ${senderName} (${senderTitle}) to a sales prospect for ${businessName}. Output ONLY valid JSON: { "subject": "<6-10 words, no spammy caps>", "body_plain": "<3-5 short paragraphs, conversational. End with a short closing line (Talk soon / Thanks / etc.) then a blank line then this SIGNATURE BLOCK exactly:\\n\\n${signatureBlock}\\n\\nEach signature line on its own line, no labels, no markdown.>" }. No marketing fluff. No emoji. No "Hope this finds you well." Reads like a real founder note.

${NO_DASH_PROMPT_RULE}`;

  const context = [
    `Prospect first name: ${firstName || '(unknown)'}`,
    lead.company_name ? `Company: ${lead.company_name}` : null,
    lead.industry ? `Industry: ${lead.industry}` : null,
    lead.city || lead.hq_state ? `Location: ${[lead.city, lead.hq_state].filter(Boolean).join(', ')}` : null,
    `Intent: ${brief}`,
  ].filter(Boolean).join('\n');

  try {
    const result = await askClaudeJSON(systemPrompt, `Context:\n${context}\n\nWrite the email. JSON only.`, {
      maxTokens: 600,
      tenantSlug: tenant.slug,
    });
    if (result && typeof result === 'object' && result.subject && result.body_plain) {
      return { subject: stripAiTells(String(result.subject).trim()), body: stripAiTells(String(result.body_plain).trim()) };
    }
    throw new Error('Claude response missing subject/body_plain');
  } catch (err) {
    log.warn(`Email generation failed for ${intent} (${err.message}) — using fallback`);
    const fallbacks = {
      demo_followup: {
        subject: `Following up on our demo, ${firstName || ''}`.trim(),
        body: `${firstName ? `Hi ${firstName},` : 'Hi,'}\n\nWanted to follow up on our demo from a few days ago. Any questions come up after you had time to think through it?\n\nHappy to jump back on a quick call if it'd help — just hit reply.\n\nTalk soon,\n${signatureBlock}`,
      },
      trial_checkin_mid: {
        subject: `Quick check-in — ${businessName} trial`,
        body: `${firstName ? `Hi ${firstName},` : 'Hi,'}\n\nYou're about a week into the trial — how's it going? Anything I can help you set up or unblock?\n\nReply here or grab a quick call if it's easier.\n\nTalk soon,\n${signatureBlock}`,
      },
      trial_checkin_final: {
        subject: `Heads up: trial ends tomorrow`,
        body: `${firstName ? `Hi ${firstName},` : 'Hi,'}\n\nQuick note — your 14-day trial wraps up tomorrow and billing will kick in for the monthly subscription. If you want to make any changes (tier, modules) or have questions before then, just reply.\n\nOtherwise everything keeps running as-is.\n\nThanks,\n${signatureBlock}`,
      },
      nurture_monthly: {
        subject: `Still here when you're ready`,
        body: `${firstName ? `Hi ${firstName},` : 'Hi,'}\n\nJust a quick note to stay on your radar. Nothing urgent — let me know if anything changes and we can pick back up.\n\nTalk soon,\n${signatureBlock}`,
      },
    };
    return fallbacks[intent];
  }
}

/**
 * Send the email + record the activity so the timeline shows what
 * went out and when.
 */
async function sendNurtureEmail({ tenant, lead, intent, idempotencyKey, log, dependencies = {} }) {
  const database = dependencies.db || db;
  const emailSender = dependencies.sendEmail || sendEmail;
  const emailGenerator = dependencies.generateEmail || generateEmail;
  const suppressionChecker = dependencies.isSuppressed || isSuppressed;
  const boundaryMatcher = dependencies.matchProtectedOrganization || matchProtectedOrganization;
  const now = dependencies.now ? dependencies.now() : new Date();
  const toEmail = await getLeadEmail(tenant.id, lead, database);
  if (!toEmail) {
    return { skipped: true, reason: 'no_email' };
  }

  // Nurture is not a loophole around the same customer and suppression
  // boundaries enforced by first-touch and drip. Uncertainty fails closed.
  const protectedOrganizations = dependencies.protectedOrganizations
    || await loadProtectedOrganizationIndex(database);
  const protectedMatch = boundaryMatcher(protectedOrganizations, {
    email: toEmail,
    companyName: lead.company_name,
  });
  if (protectedMatch.protected) {
    return { skipped: true, reason: protectedMatch.reason || 'protected_customer' };
  }
  const suppression = await suppressionChecker(database, tenant.id, {
    email: toEmail,
    phone: lead.phone,
    leadId: lead.id,
    channel: 'email',
  });
  if (suppression.suppressed) {
    return { skipped: true, reason: `suppressed:${suppression.reason || 'unknown'}` };
  }

  // Cross-agent daily lock — don't pile on top of follow-up / outreach
  // / speed-to-lead. If this lead already received any outbound message
  // in the last 22h, skip. Fixed 2026-05-21.
  const since = new Date(now.getTime() - 22 * 60 * 60 * 1000).toISOString();
  const { data: recent, error: recentError } = await database
    .from('conversations')
    .select('id')
    .eq('tenant_id', tenant.id)
    .eq('lead_id', lead.id)
    .eq('direction', 'outbound')
    .gte('created_at', since)
    .limit(1);
  if (recentError) throw new Error(`recent_message_guard_failed:${recentError.message}`);
  if ((recent || []).length > 0) {
    log.info(`Skipping nurture for ${lead.company_name || lead.name} — already messaged in last 22h`);
    return { skipped: true, reason: 'recently_messaged' };
  }

  const { subject, body } = await emailGenerator({ tenant, lead, intent, log });
  const unsubUrl = unsubscribeUrl(lead.id, toEmail);
  const postalAddress = getConfig(tenant, 'postal_address', null);
  if (!postalAddress) throw new Error('postal_address_missing');
  const html = renderOutreachEmail({
    bodyHtml: toHtml(body),
    cta: null,
    unsubscribeUrl: unsubUrl,
    postalAddress,
  });

  let providerResult;
  try {
    providerResult = await emailSender(toEmail, subject, html, {
      replyTo: 'patrick@firstgenautomate.com',
      tenant,
      isAutomated: true,
      idempotencyKey,
      headers: {
        'List-Unsubscribe': `<${unsubUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });
  } catch (err) {
    throw new Error(`nurture_provider_send_failed:${err.message}`);
  }
  if (providerResult?.status !== 'sent' || !providerResult?.id) {
    throw new Error(`nurture_provider_acceptance_unproven:${providerResult?.status || 'unknown'}`);
  }

  // Record the immutable provider-accepted message with a deterministic ID.
  // If the audit write is uncertain, a retry reuses BOTH this row ID and the
  // provider idempotency key, so it cannot create a second email or timeline
  // event.
  const conversationId = deterministicUuid(`sales-nurture:${tenant.id}:${idempotencyKey}`);
  const { error: evidenceError } = await database.from('conversations').upsert({
    id: conversationId,
    tenant_id: tenant.id,
    lead_id: lead.id,
    channel: 'email',
    direction: 'outbound',
    message_subject: subject,
    message_body: body,
    external_id: providerResult.id,
    metadata: {
      source: 'sales-nurture',
      intent,
      sent_at: now.toISOString(),
      provider: 'resend',
      provider_id: providerResult.id,
      delivery_snapshot: { subject, html, recipient: toEmail },
    },
  }, { onConflict: 'id' });
  if (evidenceError) throw new Error(`nurture_delivery_evidence_failed:${evidenceError.message}`);

  log.success(`Nurture sent (${intent}) → ${lead.company_name || lead.name}`);
  return { sent: true, intent, provider_id: providerResult.id, conversation_id: conversationId };
}

/**
 * Find demo_booked leads that haven't been touched in N+ days and
 * fire one nudge. Idempotent per lead per week.
 */
async function runDemoFollowup(tenant, log, dependencies = {}) {
  const { data: leads, error } = await db
    .from('leads')
    .select('id, name, company_name, email, industry, city, hq_state, status, updated_at')
    .eq('tenant_id', tenant.id)
    .eq('status', 'demo_booked');
  if (error) throw error;

  let sent = 0, skipped = 0;
  const cutoff = CADENCE.demo_followup_days;
  for (const lead of (leads || [])) {
    const days = daysSince(lead.updated_at);
    if (days == null || days < cutoff) { skipped++; continue; }

    const week = Math.floor(Date.now() / (1000 * 60 * 60 * 24 * 7));
    const idempKey = `sales-nurture:demo_followup:${lead.id}:week_${week}`;
    const already = await checkIdempotency(tenant.id, idempKey);
    if (already) { skipped++; continue; }

    const result = await sendNurtureEmail({ tenant, lead, intent: 'demo_followup', idempotencyKey: idempKey, log, dependencies });
    if (result.sent) {
      sent++;
      await recordIdempotency(tenant.id, idempKey, 'sales_nurture_demo_followup', { lead_id: lead.id });
    }
  }
  return { handler: 'demo_followup', sent, skipped };
}

/**
 * Find trial_active leads at day ~7 (mid-trial check-in) and day ~13
 * (trial ends tomorrow). Uses updated_at as the trial-start proxy —
 * the assumption being that the status flipped to trial_active when
 * the prospect signed.
 */
async function runTrialCheckin(tenant, log, dependencies = {}) {
  const { data: leads, error } = await db
    .from('leads')
    .select('id, name, company_name, email, industry, city, hq_state, status, updated_at')
    .eq('tenant_id', tenant.id)
    .eq('status', 'trial_active');
  if (error) throw error;

  let sent = 0, skipped = 0;
  for (const lead of (leads || [])) {
    const days = daysSince(lead.updated_at);
    if (days == null) { skipped++; continue; }

    let intent = null;
    if (days >= CADENCE.trial_checkin_day1 && days < CADENCE.trial_checkin_day1 + 2) {
      intent = 'trial_checkin_mid';
    } else if (days >= CADENCE.trial_checkin_day2 && days < CADENCE.trial_checkin_day2 + 2) {
      intent = 'trial_checkin_final';
    } else {
      skipped++;
      continue;
    }

    const idempKey = `sales-nurture:${intent}:${lead.id}`;
    const already = await checkIdempotency(tenant.id, idempKey);
    if (already) { skipped++; continue; }

    const result = await sendNurtureEmail({ tenant, lead, intent, idempotencyKey: idempKey, log, dependencies });
    if (result.sent) {
      sent++;
      await recordIdempotency(tenant.id, idempKey, `sales_nurture_${intent}`, { lead_id: lead.id });
    }
  }
  return { handler: 'trial_checkin', sent, skipped };
}

/**
 * Find nurture leads whose last outbound touch was 30+ days ago and
 * send a monthly "still here" note. Idempotent per lead per
 * calendar month so a late-month run doesn't double-fire.
 */
async function runNurtureOutreach(tenant, log, dependencies = {}) {
  const database = dependencies.db || db;
  const { data: leads, error } = await database
    .from('leads')
    .select('id, name, company_name, email, industry, city, hq_state, status, updated_at')
    .eq('tenant_id', tenant.id)
    .eq('status', 'nurture');
  if (error) throw error;

  let sent = 0, skipped = 0, skipped_no_reply_evidence = 0;
  const now = new Date();
  const yyyymm = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  for (const lead of (leads || [])) {
    const days = daysSince(lead.updated_at);
    if (days != null && days < CADENCE.nurture_interval_days) { skipped++; continue; }

    const hasReply = await hasNurtureReplyEvidence(database, tenant.id, lead.id);
    if (!hasReply) {
      skipped++;
      skipped_no_reply_evidence++;
      log.warn(`Nurture held for lead ${lead.id}: no durable genuine-reply receipt`);
      continue;
    }

    const idempKey = `sales-nurture:nurture_monthly:${lead.id}:${yyyymm}`;
    const already = await checkIdempotency(tenant.id, idempKey);
    if (already) { skipped++; continue; }

    const result = await sendNurtureEmail({ tenant, lead, intent: 'nurture_monthly', idempotencyKey: idempKey, log, dependencies });
    if (result.sent) {
      sent++;
      await recordIdempotency(tenant.id, idempKey, 'sales_nurture_monthly', { lead_id: lead.id });
    }
  }
  return { handler: 'nurture_outreach', sent, skipped, skipped_no_reply_evidence };
}

async function run(tenant, payload = {}) {
  const log = createLogger('sales-nurture');

  // Scoped to FGA only — the pipeline-stage taxonomy is FGA-specific.
  if (!isPlatformTenant(tenant)) {
    log.info(`Skipping non-FGA tenant ${tenant.slug}`);
    return { success: true, skipped: true, reason: 'non_fga_tenant' };
  }

  log.info(`Sales-nurture run started for ${tenant.name}`);

  // Allow a payload.only filter for ad-hoc debugging
  // (e.g. agent_jobs payload: { only: 'demo_followup' }).
  const only = payload.only || null;
  const handlers = [];
  if (!only || only === 'demo_followup') handlers.push(runDemoFollowup);
  if (!only || only === 'trial_checkin') handlers.push(runTrialCheckin);
  if (!only || only === 'nurture_outreach') handlers.push(runNurtureOutreach);

  const protectedOrganizations = payload.protectedOrganizations
    || await loadProtectedOrganizationIndex(payload.db || db);
  const dependencies = {
    db: payload.db || db,
    sendEmail: payload.sendEmail || sendEmail,
    generateEmail: payload.generateEmail || generateEmail,
    isSuppressed: payload.isSuppressed || isSuppressed,
    matchProtectedOrganization: payload.matchProtectedOrganization || matchProtectedOrganization,
    protectedOrganizations,
    now: payload.now ? () => new Date(payload.now) : undefined,
  };
  const results = [];
  for (const handler of handlers) {
    try {
      const r = await handler(tenant, log, dependencies);
      results.push(r);
      log.info(`${r.handler}: sent=${r.sent}, skipped=${r.skipped}`);
    } catch (err) {
      log.error(`${handler.name} failed: ${err.message}`);
      results.push({ handler: handler.name, error: err.message });
    }
  }

  const totalSent = results.reduce((s, r) => s + (r.sent || 0), 0);
  const errors = results.filter((result) => result.error);
  if (errors.length) {
    throw new Error(`sales_nurture_incomplete:${errors.map((result) => result.handler).join(',')}`);
  }
  log.success(`Sales-nurture complete — ${totalSent} emails sent`);
  return { success: true, results, total_sent: totalSent };
}

module.exports = run;
module.exports._internal = {
  deterministicUuid,
  getLeadEmail,
  hasNurtureReplyEvidence,
  runNurtureOutreach,
  sendNurtureEmail,
  toHtml,
};
