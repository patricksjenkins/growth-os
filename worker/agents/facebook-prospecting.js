/**
 * Growth OS — Facebook-Prospecting Agent
 *
 * Handles the outreach path for prospected leads where enrichment found a
 * Facebook page but no email address (lifecycle_stage = 'fb_only'). The
 * existing outreach agent only drafts email + FB DM for `enriched` leads;
 * fb_only prospects were previously orphaned. This agent fills that gap
 * with a two-touch SMS sequence + one manual Facebook DM draft, capped
 * tightly so prospects don't get a daily blast.
 *
 * Cadence per lead:
 *
 *   Day 0  — SMS #1 (hero products: branded website + missed-call AI)
 *          — Facebook DM draft created (longer, owner copy-pastes manually)
 *          — Lead moves to status='text_message_sent', lifecycle_stage='sequenced'
 *
 *   Day 7  — SMS #2 (social-proof angle: 30-40% missed-inbound stat)
 *          — No new FB draft (one DM total)
 *
 *   Day 10 — If no inbound reply, move lead to status='nurture'.
 *            Stays in the system for monthly re-enrichment.
 *
 *   Monthly — Re-run enrichment for the whole text_message_sent + nurture
 *             bucket. If an email is found, lifecycle_stage flips back to
 *             'enriched' and the regular outreach agent picks it up on its
 *             next sweep to draft an email outreach for owner approval.
 *
 * Modes (controlled by payload.mode):
 *   - 'day0'      — find fb_only candidates, send SMS #1 + FB draft, move stage
 *   - 'day7'      — find leads 7 days into text_message_sent, send SMS #2
 *   - 'post7'     — find leads 10+ days into text_message_sent w/ no reply, → nurture
 *   - 'reenrich'  — re-run enrichment on text_message_sent + nurture buckets
 *   - (no mode)   — runs day0 + day7 + post7 in sequence. This is what the
 *                   daily 2pm-ET cron invokes.
 *
 * Idempotency keys:
 *   fb-prospect-d0:<lead_id>  recorded after Day 0 SMS/draft completes
 *   fb-prospect-d7:<lead_id>  recorded after Day 7 SMS completes
 *
 * Tenant gating:
 *   - Requires `prospecting_engine` module enabled (scheduler enforces).
 *   - Skips demo tenants (no real SMS to fake leads).
 *
 * Phone missing: agent still creates the FB DM draft and still moves the
 * lead to text_message_sent. SMS half is skipped. Monthly re-enrich still
 * applies — the lead might gain a phone (or email) later.
 */

const { createLogger } = require('../../core/logger');
const { getConfig } = require('../../core/config');
const { db } = require('../../db/client');
const { sendSms, SmsCapExceededError } = require('../../integrations/telnyx');
const { checkIdempotency, recordIdempotency } = require('../../db/queries/jobs');
const { claudeHaiku } = require('../../integrations/claude');
const enrichmentAgent = require('./enrichment');
const { isInboundLead } = require('../../core/lead-sources');
const { hasTelnyxMessaging } = require('../../core/telnyx-readiness');

// ---------------------------------------------------------------------------
// Limits — keep blast radius small on first runs.
// ---------------------------------------------------------------------------
const DAY0_LIMIT = 30;        // max leads moved into the sequence per sweep
const DAY7_LIMIT = 50;        // max Day-7 follow-ups per sweep
const POST7_LIMIT = 100;      // max status-flip-to-nurture per sweep
const REENRICH_LIMIT = 100;   // max re-enrich attempts per monthly sweep

// COLD SMS DISABLED — Patrick directive (2026-06-18): First Gen Automate must
// never send cold text outreach to scraped prospects; SMS is for follow-up to
// people who already engaged (speed-to-lead reply, missed-call text-back,
// review requests, etc.) only. This agent originally auto-sent a two-touch cold
// SMS sequence (Day 0 + Day 7) to fb_only leads with a phone number — that
// behavior is now hard-off. The manual Facebook DM DRAFT path is preserved
// (the owner copy-pastes those by choice — not automatic outreach). Flip this
// to true ONLY if cold SMS is ever explicitly approved + 10DLC-compliant.
const COLD_SMS_ENABLED = false;

// Days the lead waits in text_message_sent before SMS #2.
const DAY7_OFFSET_DAYS = 7;
// Total time before we give up and flip to nurture (Day 7 SMS + 3-day grace).
const POST7_OFFSET_DAYS = 10;

// ---------------------------------------------------------------------------
// Helper: does the tenant have Telnyx set up well enough to send SMS?
// Mirrors the check in speed-to-lead.js so we don't fail loudly on tenants
// who have prospecting enabled but no Telnyx number provisioned yet.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// SMS hook generators — Claude Haiku, with fallbacks.
// ---------------------------------------------------------------------------

const DAY0_SYSTEM_PROMPT = `You are writing the first SMS to a prospect that we found via Facebook search. They didn't ask to be contacted, so the message must be brief, curious, and not pushy. We will follow up exactly once if they don't reply.

Hero products we'd like to surface (pick what fits the prospect best):
  - Done-for-you branded website — many of these prospects don't have one
  - 24/7 AI receptionist that answers missed calls and captures the lead

Rules:
- Output ONLY the SMS body. No greeting filler.
- 25-45 words MAX. SMS, not email.
- Open with one specific observation about the prospect (use their business name or vertical or city — whatever the context gives you).
- Ask one or two short, concrete questions tied to the hero products (do you have a branded website yet? are you missing calls from potential customers?).
- No links, no calendar URL, no signature, no business name suffix.
- No emoji.
- No "let me know if interested" filler.
- Do NOT use quotes around the message.
- Do NOT claim we already have customers in their city — we are a new company.`;

const DAY7_SYSTEM_PROMPT = `You are writing the SECOND (final) SMS to a prospect who didn't reply to a first text seven days ago. Last touch. Lead with one factual social-proof stat, NOT a fake customer story.

Stat to use (paraphrase, don't quote verbatim):
  "Most small business owners we work with were losing 30-40% of inbound to voicemail before a 24/7 AI receptionist."

Rules:
- Output ONLY the SMS body. No greeting filler.
- 30-55 words MAX. SMS.
- Open with a brief "following up" framing — acknowledges this is the second message.
- Cite the stat as paraphrased above. Do NOT mention a city; we have no customer list yet.
- End with a low-friction question or call-to-action (e.g., "want a 5-min walkthrough?" or "is missed-call recovery something on your radar?").
- No links, no signature, no business name suffix.
- No emoji.
- Do NOT use quotes around the message.`;

const FB_DM_SYSTEM_PROMPT = `You are writing a Facebook DM that the business owner will copy-paste manually to send to a prospect. Longer than an SMS — Facebook DM allows more characters, and the prospect will read the whole thing because it's in their FB inbox.

Hero products to mention BOTH of (briefly, naturally, not as a feature list):
  - A done-for-you branded website (we build it, host it, update it — they never touch it)
  - A 24/7 AI receptionist that picks up every call they miss and texts them the transcript + captured lead info

Rules:
- Output ONLY the DM body. No "Hi {name}!" template variables.
- 80-180 words. Longer than SMS, shorter than an email.
- Open by referencing what we noticed about them on Facebook (recent launch, posts cadence, the gap we see).
- Explain in plain English what we do (don't say "platform" or "automation" — say "we build the website and stand up a 24/7 AI receptionist").
- Frame as a soft offer — "no pressure, just thought it was worth a quick note."
- Close with: "If you want to see what it looks like, reply here or text me at <PHONE>." (use literal placeholder <PHONE>, the agent will substitute the tenant's outbound number.)
- Sign off with the exact sign-off line provided in the context.
- No emoji unless brand voice clearly calls for it.
- No links.
- Do NOT use quotes around the message.`;

async function generateSmsHook(tenant, lead, systemPrompt, fallback, log) {
  const businessName = getConfig(tenant, 'business_name', tenant.name || 'Our Team');
  const brandVoice = getConfig(tenant, 'brand_voice', 'Friendly, plain-spoken, no jargon. Sounds like a real person.');
  const firstName = (lead.name || '').split(/\s+/)[0] || '';
  const context = [
    `From business: ${businessName}`,
    `Brand voice: ${brandVoice}`,
    lead.company_name ? `Prospect business: ${lead.company_name}` : null,
    lead.name ? `Prospect contact name: ${firstName}` : null,
    lead.service_type ? `Prospect vertical: ${lead.service_type}` : null,
    lead.city ? `Prospect city: ${lead.city}` : null,
    lead.notes ? `Notes from prospecting: ${String(lead.notes).slice(0, 400)}` : null,
  ].filter(Boolean).join('\n');
  const userMessage = `Prospect context:\n${context}\n\nWrite the SMS now. Output the SMS body only.`;
  try {
    const reply = await claudeHaiku(systemPrompt, userMessage, { maxTokens: 250, tenantSlug: tenant.slug });
    const cleaned = String(reply || '').trim().replace(/^["']|["']$/g, '');
    if (!cleaned || cleaned.length < 10 || cleaned.length > 600) {
      log.warn(`Claude SMS hook unusable (length=${cleaned.length}), falling back to template`);
      return fallback;
    }
    return cleaned;
  } catch (err) {
    log.warn(`Claude SMS hook failed (${err.message}), falling back to template`);
    return fallback;
  }
}

async function generateFbDm(tenant, lead, log) {
  const businessName = getConfig(tenant, 'business_name', tenant.name || 'Our Team');
  const brandVoice = getConfig(tenant, 'brand_voice', 'Friendly, plain-spoken, no jargon. Sounds like a real person.');
  // FB DM sign-off: prefer an explicit fb_dm_signature config (e.g. FGA uses
  // "Patrick Jenkins, First Gen Automate"), else the owner's first name.
  const fbSignature = getConfig(tenant, 'fb_dm_signature', null)
    || (getConfig(tenant, 'owner_name', '') || '').split(/\s+/)[0]
    || 'the team';
  // Outbound number: prefer the sender_phone config (current contact number)
  // over the canonical Telnyx integration number.
  const outboundPhone = getConfig(tenant, 'sender_phone', null)
    || tenant?.integrations?.telnyx?.config?.phone_number
    || '(call FGA)';
  const firstName = (lead.name || '').split(/\s+/)[0] || '';
  const context = [
    `From business: ${businessName}`,
    `Sign off as this exact line: ${fbSignature}`,
    `Owner cell to put after <PHONE> placeholder: ${outboundPhone}`,
    `Brand voice: ${brandVoice}`,
    lead.company_name ? `Prospect business: ${lead.company_name}` : null,
    lead.name ? `Prospect contact name: ${firstName}` : null,
    lead.service_type ? `Prospect vertical: ${lead.service_type}` : null,
    lead.city ? `Prospect city: ${lead.city}` : null,
    lead.notes ? `Notes from prospecting (use ONE specific thing to open with): ${String(lead.notes).slice(0, 600)}` : null,
  ].filter(Boolean).join('\n');
  const userMessage = `Prospect context:\n${context}\n\nWrite the Facebook DM now. Output the DM body only. Use <PHONE> placeholder; I will substitute the real number.`;
  try {
    const reply = await claudeHaiku(FB_DM_SYSTEM_PROMPT, userMessage, { maxTokens: 600, tenantSlug: tenant.slug });
    const cleaned = String(reply || '').trim()
      .replace(/^["']|["']$/g, '')
      .replace(/<PHONE>/g, outboundPhone);
    if (!cleaned || cleaned.length < 40) {
      log.warn(`Claude FB DM unusable (length=${cleaned.length}), skipping draft`);
      return null;
    }
    return cleaned;
  } catch (err) {
    log.warn(`Claude FB DM generation failed (${err.message})`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Mode: Day 0 — find new fb_only leads, send SMS #1 + create FB DM draft.
// ---------------------------------------------------------------------------
async function runDay0(tenant, log) {
  const { data: leadsRaw, error } = await db
    .from('leads')
    .select('*')
    .eq('tenant_id', tenant.id)
    .eq('lifecycle_stage', 'fb_only')
    .neq('status', 'text_message_sent')   // already moved? skip
    .neq('status', 'nurture')              // already in nurture? skip
    .order('created_at', { ascending: true })
    .limit(DAY0_LIMIT);
  if (error) throw error;
  // HARD GATE (2026-07-14): inbound leads (website form, chat, missed call,
  // voice receptionist) can land at lifecycle_stage='fb_only' via enrichment
  // when they have a FB page but no email. They are customers reaching in —
  // never cold-pitch them or pull them into the prospecting funnel. Same
  // allow-list as outreach/auto-outreach (core/lead-sources.js).
  const leads = (leadsRaw || []).filter((l) => {
    if (isInboundLead(l)) {
      log.info(`Skipping inbound lead ${l.id} (source=${l.lead_source || 'null'}) — cold FB prospecting not allowed`);
      return false;
    }
    return true;
  });
  if (!leads || leads.length === 0) {
    return { mode: 'day0', candidates: 0, sent_sms: 0, drafted_fb: 0 };
  }

  const hasTelnyx = hasTelnyxMessaging(tenant);
  let sentSms = 0;
  let draftedFb = 0;
  let skipped = 0;

  for (const lead of leads) {
    const idempKey = `fb-prospect-d0:${lead.id}`;
    const already = await checkIdempotency(tenant.id, idempKey);
    if (already) { skipped++; continue; }

    // SMS — only if we have a VALID phone AND tenant has Telnyx configured.
    // Facebook listings often mask the last 4 digits ("912-617-XXXX"),
    // which produces a truthy-but-unusable lead.phone. Treat <10 digits
    // as no phone so Telnyx doesn't reject the send and we don't waste
    // a retry slot.
    let smsBody = null;
    let smsSid = null;
    const phoneDigits = (lead.phone || '').replace(/\D/g, '').length;
    const phoneValid = phoneDigits >= 10;
    if (COLD_SMS_ENABLED && hasTelnyx && lead.phone && phoneValid) {
      const fallback = `Hi, ${getConfig(tenant, 'business_name', 'we')} here — saw ${lead.company_name || 'your business'} on Facebook. Quick question: do you have a branded website yet, and are you missing any calls from new customers?`;
      smsBody = await generateSmsHook(tenant, lead, DAY0_SYSTEM_PROMPT, fallback, log);
      try {
        const result = await sendSms(tenant.integrations, lead.phone, smsBody, { tenantSlug: tenant.slug, tenant });
        smsSid = result.sid;
        sentSms++;
      } catch (err) {
        if (err instanceof SmsCapExceededError) {
          log.warn(`SMS cap reached during Day 0 sweep — deferring remaining leads (${err.count}/${err.cap})`);
          break;
        }
        log.warn(`Day 0 SMS send failed for lead ${lead.id}: ${err.message}`);
      }
    }

    // FB DM draft — always attempt, even if no phone.
    const dmBody = await generateFbDm(tenant, lead, log);
    if (dmBody) {
      try {
        await db.from('conversations').insert({
          tenant_id: tenant.id,
          lead_id: lead.id,
          channel: 'facebook_dm',
          direction: 'outbound',
          message_body: dmBody,
          metadata: {
            agent: 'facebook-prospecting',
            phase: 'day0',
            draft_status: 'awaiting_approval',
            facebook_url: lead.metadata?.facebook_url || lead.facebook_url || null,
            generated_at: new Date().toISOString(),
          },
        });
        draftedFb++;
      } catch (e) {
        log.warn(`FB DM draft insert failed for lead ${lead.id}: ${e.message}`);
      }
    }

    // Log the SMS as a conversation row too so it shows in the lead timeline.
    if (smsSid) {
      try {
        await db.from('conversations').insert({
          tenant_id: tenant.id,
          lead_id: lead.id,
          channel: 'sms',
          direction: 'outbound',
          message_body: smsBody,
          metadata: {
            agent: 'facebook-prospecting',
            phase: 'day0',
            external_id: smsSid,
          },
        });
      } catch (e) {
        log.warn(`SMS conversation insert failed for lead ${lead.id}: ${e.message}`);
      }
      try {
        await db.from('messages').insert({
          tenant_id: tenant.id,
          channel: 'sms',
          direction: 'outbound',
          body: smsBody,
          external_id: smsSid,
          status: 'sent',
          sent_at: new Date().toISOString(),
        });
      } catch (e) { /* non-fatal */ }
    }

    // 2026-05-27 BUGFIX: only flip status to 'text_message_sent' if an
    // SMS was ACTUALLY queued at Twilio (smsSid is truthy). Previously
    // we marked every swept lead as text_message_sent even when Twilio
    // rejected the send (A2P blocker, no Brand approved yet) — that
    // produced misleading "Text Sent" badges on prospects who never
    // received a message. lifecycle_stage='sequenced' still moves so
    // the lead exits the new-lead bucket and the FB DM draft gets
    // captured. The lead's pipeline status only advances when the
    // outreach actually went out.
    const newStatus = smsSid ? 'text_message_sent' : lead.status || 'new_lead';
    await db.from('leads')
      .update({
        status: newStatus,
        lifecycle_stage: 'sequenced',
        updated_at: new Date().toISOString(),
      })
      .eq('id', lead.id)
      .eq('tenant_id', tenant.id);

    await recordIdempotency(tenant.id, idempKey, 'fb_prospect_day0', {
      sms_sent: !!smsSid,
      fb_drafted: !!dmBody,
      status_advanced: !!smsSid,
      at: new Date().toISOString(),
    });
  }

  return { mode: 'day0', candidates: leads.length, sent_sms: sentSms, drafted_fb: draftedFb, skipped_idempotent: skipped };
}

// ---------------------------------------------------------------------------
// Mode: Day 7 — find leads exactly 7 days into text_message_sent, send SMS #2.
// ---------------------------------------------------------------------------
async function runDay7(tenant, log) {
  // Cold SMS is hard-disabled (see COLD_SMS_ENABLED). The entire Day-7 sweep is
  // a second cold text touch, so it is a no-op while cold SMS is off.
  if (!COLD_SMS_ENABLED) {
    return { mode: 'day7', skipped: true, reason: 'cold_sms_disabled' };
  }
  if (!hasTelnyxMessaging(tenant)) {
    return { mode: 'day7', skipped: true, reason: 'no_telnyx' };
  }
  const cutoffEnd = new Date(Date.now() - DAY7_OFFSET_DAYS * 86400000).toISOString();
  const cutoffStart = new Date(Date.now() - (DAY7_OFFSET_DAYS + 2) * 86400000).toISOString();

  const { data: leads, error } = await db
    .from('leads')
    .select('*')
    .eq('tenant_id', tenant.id)
    .eq('status', 'text_message_sent')
    .not('phone', 'is', null)
    .lte('updated_at', cutoffEnd)
    .gte('updated_at', cutoffStart)
    .order('updated_at', { ascending: true })
    .limit(DAY7_LIMIT);
  if (error) throw error;
  if (!leads || leads.length === 0) {
    return { mode: 'day7', candidates: 0, sent_sms: 0 };
  }

  let sentSms = 0;
  for (const lead of leads) {
    const idempKey = `fb-prospect-d7:${lead.id}`;
    const already = await checkIdempotency(tenant.id, idempKey);
    if (already) continue;

    // Skip if any inbound reply has come in since the lead was sequenced.
    const { data: replies } = await db
      .from('conversations')
      .select('id')
      .eq('lead_id', lead.id)
      .eq('direction', 'inbound')
      .limit(1);
    if (replies && replies.length > 0) {
      log.info(`Lead ${lead.id} already replied — skipping Day 7`);
      await recordIdempotency(tenant.id, idempKey, 'fb_prospect_day7_skipped_reply', {});
      continue;
    }

    const fallback = `Following up — most owners we work with were losing 30-40% of their inbound to voicemail before a 24/7 AI receptionist. Worth a quick 10-min look?`;
    const smsBody = await generateSmsHook(tenant, lead, DAY7_SYSTEM_PROMPT, fallback, log);

    try {
      const result = await sendSms(tenant.integrations, lead.phone, smsBody, { tenantSlug: tenant.slug, tenant });
      sentSms++;
      try {
        await db.from('conversations').insert({
          tenant_id: tenant.id,
          lead_id: lead.id,
          channel: 'sms',
          direction: 'outbound',
          message_body: smsBody,
          metadata: { agent: 'facebook-prospecting', phase: 'day7', external_id: result.sid },
        });
        await db.from('messages').insert({
          tenant_id: tenant.id,
          channel: 'sms',
          direction: 'outbound',
          body: smsBody,
          external_id: result.sid,
          status: 'sent',
          sent_at: new Date().toISOString(),
        });
      } catch (e) { /* non-fatal */ }
      await recordIdempotency(tenant.id, idempKey, 'fb_prospect_day7', { sid: result.sid });
    } catch (err) {
      if (err instanceof SmsCapExceededError) {
        log.warn(`SMS cap reached during Day 7 sweep — deferring remaining (${err.count}/${err.cap})`);
        break;
      }
      log.warn(`Day 7 SMS failed for lead ${lead.id}: ${err.message}`);
    }
  }
  return { mode: 'day7', candidates: leads.length, sent_sms: sentSms };
}

// ---------------------------------------------------------------------------
// Mode: Post-7 — move stale text_message_sent leads with no reply to nurture.
// ---------------------------------------------------------------------------
async function runPost7(tenant, log) {
  const cutoff = new Date(Date.now() - POST7_OFFSET_DAYS * 86400000).toISOString();
  // 2026-06-08: the leads table has company_name, NOT business_name. The
  // bad column name caused every facebook-prospecting cron to crash with
  // "column leads.business_name does not exist" for ~7 days straight.
  const { data: leads, error } = await db
    .from('leads')
    .select('id, name, company_name')
    .eq('tenant_id', tenant.id)
    .eq('status', 'text_message_sent')
    .lte('updated_at', cutoff)
    .order('updated_at', { ascending: true })
    .limit(POST7_LIMIT);
  if (error) throw error;
  if (!leads || leads.length === 0) return { mode: 'post7', moved: 0 };

  let moved = 0;
  for (const lead of leads) {
    // Only move if there's been no inbound reply at any point.
    const { data: replies } = await db
      .from('conversations')
      .select('id')
      .eq('lead_id', lead.id)
      .eq('direction', 'inbound')
      .limit(1);
    if (replies && replies.length > 0) {
      log.info(`Lead ${lead.id} replied — leaving status alone (handled by reply-classification)`);
      continue;
    }
    await db.from('leads')
      .update({ status: 'nurture', updated_at: new Date().toISOString() })
      .eq('id', lead.id)
      .eq('tenant_id', tenant.id);
    moved++;
  }
  return { mode: 'post7', candidates: leads.length, moved };
}

// ---------------------------------------------------------------------------
// Mode: Monthly re-enrich — try to find an email for leads still in the
// bucket. If found, the lead's lifecycle_stage flips back to a value the
// outreach agent will pick up (enrichment.enrichOne handles all the
// lifecycle bookkeeping).
// ---------------------------------------------------------------------------
async function runReenrich(tenant, log) {
  const { data: leads, error } = await db
    .from('leads')
    .select('*')
    .eq('tenant_id', tenant.id)
    .in('status', ['text_message_sent', 'nurture'])
    .eq('lifecycle_stage', 'sequenced')   // still no email; we set this in Day 0
    .order('updated_at', { ascending: true })
    .limit(REENRICH_LIMIT);
  if (error) throw error;
  if (!leads || leads.length === 0) return { mode: 'reenrich', candidates: 0, found: 0 };

  let found = 0;
  for (const lead of leads) {
    try {
      const result = await enrichmentAgent.enrichOne(tenant, lead);
      if (result && (result.email || result.contact_email)) {
        // enrichOne already updated lifecycle_stage on the lead row.
        // Outreach agent's next sweep will pick it up because we no
        // longer match this sweep's filter.
        found++;
        log.info(`Re-enrich found email for lead ${lead.id}`);
      }
    } catch (err) {
      log.warn(`Re-enrich attempt failed for lead ${lead.id}: ${err.message}`);
    }
  }
  return { mode: 'reenrich', candidates: leads.length, found };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
async function run(tenant, payload = {}) {
  const log = createLogger('facebook-prospecting', tenant.slug);

  if (tenant.is_demo) {
    log.info('Skipping demo tenant');
    return { success: true, skipped: true, reason: 'demo_tenant' };
  }

  const mode = payload.mode || 'all';
  log.info(`Running facebook-prospecting mode=${mode}`);

  try {
    if (mode === 'day0') return { success: true, ...(await runDay0(tenant, log)) };
    if (mode === 'day7') return { success: true, ...(await runDay7(tenant, log)) };
    if (mode === 'post7') return { success: true, ...(await runPost7(tenant, log)) };
    if (mode === 'reenrich') return { success: true, ...(await runReenrich(tenant, log)) };

    // Default: run day0 + day7 + post7 in sequence (daily 2pm ET sweep).
    const r0 = await runDay0(tenant, log);
    const r7 = await runDay7(tenant, log);
    const rp = await runPost7(tenant, log);
    return { success: true, day0: r0, day7: r7, post7: rp };
  } catch (err) {
    log.error(`facebook-prospecting failed: ${err.message}`);
    throw err;
  }
}

module.exports = run;
