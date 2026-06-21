/**
 * Outreach Center — unified engine for the four A Kut Above outreach types:
 *   review | quote | referral_partner | commercial
 *
 * One enrollment = one recipient enrolled in one type's cadence. Each touch
 * produces draft outreach_messages the owner approves + sends (auto-send is an
 * opt-in per-type setting that only applies to follow-up steps, never step 1).
 *
 * HARD RULES (owner directives):
 *  - SMS ONLY goes to a contact tied to a COMPLETED job (canText). Everyone else
 *    is EMAIL ONLY. So in practice only Review (completed-job customers) can text;
 *    quote / referral / commercial are email-only.
 *  - No overpromise, no scheduling/dispatch claims (copy lives in templates).
 *  - Referral copy says "$100 referral appreciation payment", never "referral fee".
 *
 * The same functions are used by the tenant route (user JWT client, RLS) and the
 * worker cadence agent (service-role client). Pass the db client in; for sending
 * SMS pass a full resolved tenant (for the from-number + caps).
 */

const crypto = require('crypto');
const { createLogger } = require('./logger');
const { sendEmail } = require('../integrations/email');
const telnyx = require('../integrations/telnyx');
const { getConfig } = require('./config');

const log = createLogger('outreach');

const BUSINESS_DEFAULT = 'A Kut Above Tree Services';
const OUTREACH_TYPES = ['review', 'quote', 'referral_partner', 'commercial'];

// Quote (job) lifecycle: which job statuses keep follow-up running vs stop it.
const QUOTE_OPEN = new Set(['quote_sent', 'estimate_sent', 'pending', 'awaiting_customer', 'open', 'quoted']);
const QUOTE_CLOSED = new Set(['won', 'lost', 'declined', 'cancelled', 'canceled', 'expired']);

// Quote cadence presets (day offsets from enrollment).
const CADENCE_DAYS = {
  light: [7, 14],
  standard: [3, 7, 14, 30],
  aggressive: [2, 5, 10, 21, 30],
};

// Fixed day offsets per type (index 0 = first touch). Review/referral/commercial
// have an immediate "Day 1" touch (offset 0) that needs owner approval.
const TYPE_OFFSETS = {
  review: [0, 7, 30],
  referral_partner: [0, 7, 14, 45, 75, 120, 180],
  commercial: [0, 7, 21, 45, 90],
};

function offsetsForEnrollment(enr) {
  if (enr.outreach_type === 'quote') {
    if (Array.isArray(enr.cadence_days) && enr.cadence_days.length) return enr.cadence_days;
    return CADENCE_DAYS[enr.cadence] || CADENCE_DAYS.standard;
  }
  return TYPE_OFFSETS[enr.outreach_type] || [0];
}
function totalSteps(enr) { return offsetsForEnrollment(enr).length; }

function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || 'there';
}
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d;
}
function fmtDate(d) {
  if (!d) return '';
  try { return new Date(d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }); }
  catch (_) { return ''; }
}

// --- config (review links + business name + from address) ---
const CFG_KEYS = ['review_links', 'review_url', 'business_name', 'review_email_from', 'lead_alert_from'];
async function loadOutreachConfig(db, tenantId) {
  const { data } = await db.from('tenant_config').select('key, value').eq('tenant_id', tenantId).in('key', CFG_KEYS);
  const cfg = {}; (data || []).forEach((r) => { cfg[r.key] = r.value; });
  let links = [];
  if (cfg.review_links) { try { const a = JSON.parse(cfg.review_links); if (Array.isArray(a)) links = a; } catch (_) { /* ignore */ } }
  if (!links.length && cfg.review_url) links = [{ label: 'Google Review', url: cfg.review_url, enabled: true }];
  return {
    links: links.filter((l) => l && l.url && l.enabled !== false),
    business_name: cfg.business_name || BUSINESS_DEFAULT,
    from: cfg.review_email_from || cfg.lead_alert_from || undefined,
  };
}

// --- unsubscribe token (HMAC) ---
function unsubSecret() {
  return process.env.OUTREACH_UNSUB_SECRET || process.env.SUPABASE_JWT_SECRET || process.env.APP_SECRET || 'fga-outreach-v1';
}
function buildUnsubToken(enrollmentId) {
  const sig = crypto.createHmac('sha256', unsubSecret()).update(String(enrollmentId)).digest('hex').slice(0, 24);
  return `${enrollmentId}.${sig}`;
}
function verifyUnsubToken(token) {
  const [id, sig] = String(token || '').split('.');
  if (!id || !sig) return null;
  const expect = crypto.createHmac('sha256', unsubSecret()).update(id).digest('hex').slice(0, 24);
  return sig === expect ? id : null;
}
function apiBase() {
  return (process.env.API_BASE_URL || process.env.PUBLIC_API_URL || 'https://growth-os-production-22b3.up.railway.app').replace(/\/$/, '');
}
function unsubUrl(enrollmentId) {
  return `${apiBase()}/api/outreach/unsubscribe?token=${encodeURIComponent(buildUnsubToken(enrollmentId))}`;
}

// --- the SMS gate: text only contacts tied to a COMPLETED job ---
async function canText(db, tenantId, enr) {
  // Fast path: review enrollments are created from a completed job.
  if (!enr.customer_id && !enr.job_id) return false;
  const ors = [];
  if (enr.job_id) ors.push(`id.eq.${enr.job_id}`);
  if (enr.customer_id) ors.push(`customer_id.eq.${enr.customer_id}`);
  let q = db.from('jobs').select('id, status, completed_date').eq('tenant_id', tenantId);
  q = ors.length === 1 ? q.or(ors[0]) : q.or(ors.join(','));
  const { data } = await q.limit(50);
  return (data || []).some((j) => j.status === 'completed' || j.completed_date);
}

/**
 * Decide which channels a touch should go out on, honoring availability,
 * the completed-job SMS gate, contact flags, and channel_pref.
 * Returns { channels: ['email'|'sms'], missing: bool, reason }.
 */
function resolveChannels(enr, { textEligible, flags = {} }) {
  if (flags.do_not_contact || flags.unsubscribed || flags.bad_contact) {
    return { channels: [], missing: true, reason: 'do_not_contact' };
  }
  const emailOk = !!enr.contact_email && !flags.do_not_email;
  const smsOk = !!enr.contact_phone && textEligible && !flags.do_not_text;
  let allow = new Set();
  const pref = enr.channel_pref || 'auto';
  if (pref === 'email') { if (emailOk) allow.add('email'); }
  else if (pref === 'sms') { if (smsOk) allow.add('sms'); }
  else { // auto | both -> use everything available
    if (emailOk) allow.add('email');
    if (smsOk) allow.add('sms');
  }
  const channels = [...allow];
  return { channels, missing: channels.length === 0, reason: channels.length ? null : 'missing_contact' };
}

// --- template lookup ---
async function pickTemplate(db, tenantId, type, stepIndex, channel) {
  const { data } = await db.from('outreach_templates').select('*')
    .eq('tenant_id', tenantId).eq('outreach_type', type).eq('step_index', stepIndex)
    .eq('channel', channel).eq('active', true)
    .order('version', { ascending: false }).limit(1);
  return (data && data[0]) || null;
}

// --- token vars ---
function partnerContext(type) {
  return type === 'insurance'
    ? 'helping your policyholders with storm damage, hazardous trees, and cleanup when claims come up'
    : 'helping your clients get a property ready to list, handle inspection items, or clean up after a storm';
}
function buildVars(enr, extra = {}) {
  const name = enr.contact_name || '';
  return {
    first_name: firstName(name),
    customer_name: name,
    partner_name: name,
    contact_name: name,
    business_name: BUSINESS_DEFAULT,
    company: extra.company || '',
    service: extra.service || 'tree service',
    job_date: extra.job_date || '',
    partner_context: extra.partner_context || '',
  };
}
function renderText(tpl, vars) {
  return String(tpl || '').replace(/\{\{(\w+)\}\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));
}

function linkButtonsHtml(links) {
  return links.map((l) =>
    `<a href="${escapeHtml(l.url)}" style="display:inline-block;background:#1F5130;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:700;margin:6px 8px 6px 0;font-family:Arial,Helvetica,sans-serif;">${escapeHtml(l.label || 'Leave a Review')}</a>`
  ).join('');
}
function linkUrlsText(links) { return links.map((l) => l.url).join('  '); }
function wrapEmail(inner) {
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;color:#22312b;max-width:560px;margin:0 auto;line-height:1.55;">${inner}</div>`;
}

/** Render an email touch from a plain-text template + tokens. */
function renderEmail(bodyTpl, subjectTpl, vars, links, unsub) {
  const subject = renderText(subjectTpl || `A note from ${vars.business_name}`, vars);
  const body = renderText(bodyTpl, vars); // leaves {{review_links}}/{{unsubscribe}} intact
  const linksHtml = linkButtonsHtml(links || []);
  const unsubHtml = unsub ? `<p style="font-size:12px;color:#9aa0a6;margin-top:18px;">Prefer not to receive these emails? <a href="${escapeHtml(unsub)}" style="color:#9aa0a6;">Unsubscribe</a>.</p>` : '';
  const html = body.split(/\n\n+/).map((block) => {
    const b = block.trim();
    if (!b) return '';
    if (b === '{{review_links}}') return links && links.length ? `<p>${linksHtml}</p>` : '';
    if (b === '{{unsubscribe}}') return unsubHtml;
    const esc = escapeHtml(b)
      .replace(/\{\{review_links\}\}/g, links && links.length ? linksHtml : '')
      .replace(/\{\{unsubscribe\}\}/g, '')
      .replace(/\n/g, '<br>');
    return `<p>${esc}</p>`;
  }).join('');
  return { subject, html: wrapEmail(html) };
}

/** Render an SMS touch (plain text; review_links -> plain URLs; unsubscribe -> ''). */
function renderSms(bodyTpl, vars, links) {
  const v = { ...vars, review_links: linkUrlsText(links || []), unsubscribe: '' };
  return renderText(bodyTpl, v).replace(/\n{2,}/g, '\n').trim();
}

/**
 * Pull the contact/subject context for an enrollment (job/customer/partner) so
 * tokens render with real data.
 */
async function loadContext(db, tenantId, enr) {
  const extra = { company: '', service: 'tree service', job_date: '', partner_context: '' };
  if (enr.job_id) {
    const { data: job } = await db.from('jobs').select('description, service_type, scheduled_date, completed_date, status')
      .eq('tenant_id', tenantId).eq('id', enr.job_id).maybeSingle();
    if (job) {
      extra.service = job.description || job.service_type || extra.service;
      extra.job_date = fmtDate(job.completed_date || job.scheduled_date);
      extra._job = job;
    }
  }
  if (enr.customer_id && extra.service === 'tree service') {
    const { data: c } = await db.from('customers').select('service_type, last_job_date')
      .eq('tenant_id', tenantId).eq('id', enr.customer_id).maybeSingle();
    if (c) { if (c.service_type) extra.service = c.service_type; if (!extra.job_date) extra.job_date = fmtDate(c.last_job_date); }
  }
  if (enr.referral_partner_id) {
    const { data: p } = await db.from('referral_partners').select('company, partner_type')
      .eq('tenant_id', tenantId).eq('id', enr.referral_partner_id).maybeSingle();
    if (p) { extra.company = p.company || ''; extra.partner_context = partnerContext(p.partner_type); }
  }
  if (enr.commercial_prospect_id) {
    const { data: p } = await db.from('commercial_prospects').select('name')
      .eq('tenant_id', tenantId).eq('id', enr.commercial_prospect_id).maybeSingle();
    if (p) extra.company = p.name || '';
  }
  return extra;
}

/** Load contact flags for an enrollment's recipient. */
async function loadFlags(db, tenantId, enr) {
  if (enr.customer_id) {
    const { data: c } = await db.from('customers')
      .select('do_not_text, do_not_email, do_not_contact, do_not_ask_review, unsubscribed, bad_contact')
      .eq('tenant_id', tenantId).eq('id', enr.customer_id).maybeSingle();
    if (c) return c;
  }
  const tbl = enr.referral_partner_id ? 'referral_partners' : enr.commercial_prospect_id ? 'commercial_prospects' : null;
  const id = enr.referral_partner_id || enr.commercial_prospect_id;
  if (tbl && id) {
    const { data: p } = await db.from(tbl).select('do_not_contact, unsubscribed').eq('tenant_id', tenantId).eq('id', id).maybeSingle();
    if (p) return p;
  }
  return {};
}

/**
 * Build the draft message(s) for the enrollment's CURRENT step. Returns
 * { ok, messages:[{channel,to_email,to_phone,subject,body}], missing, step, day_offset }.
 * Does not persist — caller decides draft vs send.
 */
async function buildStepMessages(db, tenantId, enr, cfg) {
  const conf = cfg || (await loadOutreachConfig(db, tenantId));
  const step = enr.current_step || 1;
  const offsets = offsetsForEnrollment(enr);
  const dayOffset = offsets[step - 1] != null ? offsets[step - 1] : 0;
  const flags = await loadFlags(db, tenantId, enr);
  const textEligible = enr.text_eligible || (enr.outreach_type === 'review' ? await canText(db, tenantId, enr) : false);
  const chosen = resolveChannels(enr, { textEligible, flags });
  if (chosen.missing) return { ok: false, missing: true, reason: chosen.reason, step, day_offset: dayOffset };

  const extra = await loadContext(db, tenantId, enr);
  const vars = buildVars(enr, extra);
  const messages = [];
  for (const channel of chosen.channels) {
    const tpl = await pickTemplate(db, tenantId, enr.outreach_type, step, channel);
    if (!tpl) continue; // e.g. no SMS template for this step
    if (channel === 'email') {
      const { subject, html } = renderEmail(tpl.body, tpl.subject, vars, conf.links, unsubUrl(enr.id));
      messages.push({ channel, to_email: enr.contact_email, subject, body: html });
    } else {
      const body = renderSms(tpl.body, vars, conf.links);
      messages.push({ channel, to_phone: enr.contact_phone, subject: null, body });
    }
  }
  if (!messages.length) return { ok: false, missing: true, reason: 'no_template', step, day_offset: dayOffset };
  return { ok: true, messages, step, day_offset: dayOffset };
}

/** Persist draft messages for the current step (idempotent per step+channel). */
async function createDraftsForStep(db, tenantId, enr, cfg) {
  const built = await buildStepMessages(db, tenantId, enr, cfg);
  if (!built.ok) return built;
  const rows = built.messages.map((m) => ({
    tenant_id: tenantId, enrollment_id: enr.id, outreach_type: enr.outreach_type,
    step_index: built.step, day_offset: built.day_offset, channel: m.channel,
    to_email: m.to_email || null, to_phone: m.to_phone || null,
    subject: m.subject || null, body: m.body, status: 'draft',
  }));
  const { data, error } = await db.from('outreach_messages')
    .upsert(rows, { onConflict: 'enrollment_id,step_index,channel', ignoreDuplicates: true })
    .select();
  if (error) throw error;
  return { ok: true, drafts: data || [], step: built.step };
}

/** Actually send one message row. Needs a resolved tenant for SMS. Returns {ok}. */
async function sendOne(db, tenant, msg) {
  const tenantId = tenant.id;
  try {
    if (msg.channel === 'email') {
      if (!msg.to_email) throw new Error('No email address');
      const conf = await loadOutreachConfig(db, tenantId);
      const r = await sendEmail(msg.to_email, msg.subject, msg.body, { from: conf.from, tenant: { id: tenantId } });
      await db.from('outreach_messages').update({ status: 'sent', sent_at: new Date().toISOString(), provider_id: r?.id || null, error: null, updated_at: new Date().toISOString() }).eq('id', msg.id);
      return { ok: true, channel: 'email' };
    }
    // SMS — only ever reached for completed-job contacts (gate already applied).
    if (!msg.to_phone) throw new Error('No phone number');
    const r = await telnyx.sendSms(tenant.integrations, msg.to_phone, msg.body, { tenant, tenantSlug: tenant.slug, isAutomated: true });
    await db.from('outreach_messages').update({ status: 'sent', sent_at: new Date().toISOString(), provider_id: r?.sid || null, error: null, updated_at: new Date().toISOString() }).eq('id', msg.id);
    return { ok: true, channel: 'sms' };
  } catch (err) {
    await db.from('outreach_messages').update({ status: 'failed', error: String(err.message).slice(0, 300), updated_at: new Date().toISOString() }).eq('id', msg.id);
    log.warn(`sendOne ${msg.channel} failed: ${err.message}`);
    return { ok: false, channel: msg.channel, error: err.message };
  }
}

/** Advance an enrollment after a step's messages were sent. */
async function advanceAfterSend(db, tenantId, enr) {
  const offsets = offsetsForEnrollment(enr);
  const nextStep = (enr.current_step || 1) + 1;
  const day1 = enr.created_at || new Date().toISOString();
  const patch = { last_sent_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  if (nextStep > offsets.length) {
    patch.status = 'completed';
    patch.next_send_at = null;
  } else {
    patch.current_step = nextStep;
    patch.status = 'active';
    patch.next_send_at = addDays(day1, offsets[nextStep - 1]).toISOString();
  }
  const { data } = await db.from('outreach_enrollments').update(patch).eq('tenant_id', tenantId).eq('id', enr.id).select().single();
  return data;
}

// --- lifecycle controls ---
async function setStatus(db, tenantId, id, status, fields = {}) {
  const { data, error } = await db.from('outreach_enrollments')
    .update({ status, updated_at: new Date().toISOString(), ...fields })
    .eq('tenant_id', tenantId).eq('id', id).select().single();
  if (error) throw error;
  return data;
}
async function pause(db, tenantId, id, reason) { return setStatus(db, tenantId, id, 'paused', { paused_reason: reason || null }); }
async function resume(db, tenantId, id) { return setStatus(db, tenantId, id, 'active'); }
async function stop(db, tenantId, id, reason) { return setStatus(db, tenantId, id, 'stopped', { stopped_reason: reason || null, next_send_at: null }); }
async function markReplied(db, tenantId, id) { return setStatus(db, tenantId, id, 'needs_review', { replied_at: new Date().toISOString(), next_send_at: null }); }

/** Skip the current step: mark its drafts skipped, advance to next (no send). */
async function skipNext(db, tenantId, enr) {
  await db.from('outreach_messages').update({ status: 'skipped', skip_reason: 'owner_skipped', updated_at: new Date().toISOString() })
    .eq('tenant_id', tenantId).eq('enrollment_id', enr.id).eq('step_index', enr.current_step).in('status', ['draft', 'approved', 'scheduled']);
  return advanceAfterSend(db, tenantId, enr);
}

/** Whether an enrollment should auto-stop before its next touch (quote/review). */
async function shouldStop(db, tenantId, enr) {
  if (enr.outreach_type === 'quote' && enr.job_id) {
    const { data: job } = await db.from('jobs').select('status, completed_date').eq('tenant_id', tenantId).eq('id', enr.job_id).maybeSingle();
    if (!job) return { stop: true, reason: 'job_deleted' };
    if (QUOTE_CLOSED.has(job.status)) return { stop: true, reason: `quote_${job.status}` };
    if (job.status === 'completed' || job.completed_date) return { stop: true, reason: 'quote_won' };
  }
  if (enr.outreach_type === 'review') {
    const flags = await loadFlags(db, tenantId, enr);
    if (flags.do_not_ask_review || flags.do_not_contact) return { stop: true, reason: 'do_not_ask' };
    if (enr.customer_id) {
      const { data: rev } = await db.from('customer_reviews').select('status').eq('tenant_id', tenantId).eq('customer_id', enr.customer_id).maybeSingle();
      if (rev && (rev.status === 'received' || rev.status === 'do_not_ask')) return { stop: true, reason: 'review_received' };
    }
  }
  return { stop: false };
}

/** Create (or return existing) enrollment. Dedupe via DB unique indexes. */
async function createEnrollment(db, tenantId, fields) {
  const offsets = offsetsForEnrollment(fields);
  const firstImmediate = fields.outreach_type !== 'quote';
  const now = new Date();
  const nextSendAt = firstImmediate ? now : addDays(now, offsets[0]);
  const row = {
    tenant_id: tenantId,
    outreach_type: fields.outreach_type,
    customer_id: fields.customer_id || null,
    job_id: fields.job_id || null,
    referral_partner_id: fields.referral_partner_id || null,
    commercial_prospect_id: fields.commercial_prospect_id || null,
    contact_name: fields.contact_name || null,
    contact_email: fields.contact_email || null,
    contact_phone: fields.contact_phone || null,
    status: fields.status || 'active',
    cadence: fields.cadence || 'standard',
    cadence_days: fields.cadence_days || null,
    current_step: 1,
    next_send_at: nextSendAt.toISOString(),
    channel_pref: fields.channel_pref || 'auto',
    text_eligible: fields.text_eligible || false,
    created_by: fields.created_by || 'owner',
    metadata: fields.metadata || {},
  };
  const { data, error } = await db.from('outreach_enrollments').insert(row).select().single();
  if (error) {
    // unique-violation -> already enrolled; fetch and return it
    if (String(error.code) === '23505' || /duplicate key/i.test(error.message)) {
      const q = db.from('outreach_enrollments').select('*').eq('tenant_id', tenantId).eq('outreach_type', fields.outreach_type)
        .in('status', ['active', 'paused', 'needs_review', 'missing_contact']);
      if (fields.customer_id) q.eq('customer_id', fields.customer_id);
      if (fields.job_id) q.eq('job_id', fields.job_id);
      if (fields.referral_partner_id) q.eq('referral_partner_id', fields.referral_partner_id);
      if (fields.commercial_prospect_id) q.eq('commercial_prospect_id', fields.commercial_prospect_id);
      const { data: ex } = await q.limit(1);
      return { enrollment: (ex && ex[0]) || null, existed: true };
    }
    throw error;
  }
  return { enrollment: data, existed: false };
}

module.exports = {
  OUTREACH_TYPES, CADENCE_DAYS, TYPE_OFFSETS, QUOTE_OPEN, QUOTE_CLOSED,
  offsetsForEnrollment, totalSteps, firstName, fmtDate,
  loadOutreachConfig, canText, resolveChannels, partnerContext,
  buildVars, renderText, renderEmail, renderSms, buildStepMessages,
  createDraftsForStep, sendOne, advanceAfterSend,
  pause, resume, stop, markReplied, skipNext, shouldStop, createEnrollment,
  buildUnsubToken, verifyUnsubToken, unsubUrl,
};
