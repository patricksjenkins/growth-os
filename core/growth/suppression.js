/**
 * Growth Engine — central suppression + dedupe (single source of truth).
 *
 * This is the ONE place new code asks "may we contact / enroll this person?".
 * It UNIONS every existing suppression source rather than replacing them:
 *   - lead_suppressions   (new central table — DNC / competitor / bad-fit)
 *   - drip_suppressions   (email, permanent — unsubscribe / bounce)
 *   - customers.do_not_*  (Outreach Center contact flags)
 *   - terminal leads.status (replied / won / lost / etc.)
 * and checks active enrollment across drip_enrollments + outreach_enrollments
 * so a prospect can never be double-enrolled.
 *
 * Pure-ish: every function takes the db client so it is trivially testable with
 * an in-memory stub. No LLM, no network, no sends. Wired into the orchestrator /
 * new-enrollment path only — existing agents keep their own working checks.
 */

const { sanitizePhone } = require('../utils');
const { NEVER_COLD_CONTACT } = require('./lead-status');

// Sales-stage statuses that mean "already engaged / closed" — never
// cold-contact. Unified 2026-07-21: sourced from core/growth/lead-status.js
// (adds unsubscribed + bounced, which this set was missing — strictly more
// protective). Export name kept for every existing importer.
const TERMINAL_LEAD_STATUSES = NEVER_COLD_CONTACT;

// ── normalization ──────────────────────────────────────────────────────
function normalizeEmail(email) {
  if (!email || typeof email !== 'string') return null;
  const e = email.trim().toLowerCase();
  return e.includes('@') ? e : null;
}

/** Last 10 digits, so (555) 123-4567 and +1 555 123 4567 match. */
function normalizePhone(raw) {
  const cleaned = sanitizePhone(typeof raw === 'string' ? raw : '');
  if (!cleaned) return null;
  const digits = cleaned.replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

function normalizeDomain(value) {
  if (!value || typeof value !== 'string') return null;
  const host = value.trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  return host || null;
}

function normalizeName(value) {
  return value ? String(value).trim().toLowerCase().replace(/\s+/g, ' ') : null;
}

function normalizeState(value) {
  return value ? String(value).trim().toUpperCase() : null;
}

// ── dedupe ─────────────────────────────────────────────────────────────
/**
 * Canonical duplicate check, precedence: domain → phone → company+state.
 * Consolidates the logic inlined in the prospecting + targeted-campaign agents
 * so new code has one definition. Returns the existing lead row ({id,...}) or null.
 */
async function findDuplicate(db, tenantId, candidate = {}) {
  const domain = normalizeDomain(candidate.website || candidate.domain);
  if (domain) {
    const { data } = await db.from('leads')
      .select('id, company_name, status, lifecycle_stage')
      .eq('tenant_id', tenantId).eq('domain', domain).limit(1).maybeSingle();
    if (data) return { ...data, matched_on: 'domain' };
  }

  const phone = normalizePhone(candidate.phone);
  if (phone) {
    // leads.phone is stored raw; match on the last-10-digit suffix.
    const { data } = await db.from('leads')
      .select('id, company_name, status, lifecycle_stage, phone')
      .eq('tenant_id', tenantId).ilike('phone', `%${phone}%`).limit(5);
    const hit = (data || []).find((l) => normalizePhone(l.phone) === phone);
    if (hit) return { ...hit, matched_on: 'phone' };
  }

  const name = candidate.company || candidate.company_name;
  if (name) {
    const { data } = await db.from('leads')
      .select('id, company_name, status, lifecycle_stage')
      .eq('tenant_id', tenantId).eq('company_name', name).limit(1).maybeSingle();
    if (data) return { ...data, matched_on: 'company_name' };
  }
  return null;
}

// ── suppression ────────────────────────────────────────────────────────
/**
 * Is this contact suppressed on the given channel? Unions all sources.
 * Returns { suppressed:boolean, reason?, source? }.
 */
async function isSuppressed(db, tenantId, target = {}) {
  const email = normalizeEmail(target.email);
  const phone = normalizePhone(target.phone);
  const channel = target.channel || 'all';

  // 1) central lead_suppressions (email / phone / lead_id)
  const ors = [];
  if (email) ors.push(`email.eq.${email}`);
  if (phone) ors.push(`phone.eq.${phone}`);
  if (target.leadId) ors.push(`lead_id.eq.${target.leadId}`);
  if (ors.length) {
    const { data } = await db.from('lead_suppressions')
      .select('reason, channel, source').eq('tenant_id', tenantId).or(ors.join(',')).limit(20);
    for (const row of data || []) {
      if (row.channel === 'all' || channel === 'all' || row.channel === channel) {
        return { suppressed: true, reason: row.reason, source: row.source || 'lead_suppressions' };
      }
    }
  }

  // 2) drip_suppressions (email, permanent — unsubscribe / bounce)
  if (email && (channel === 'all' || channel === 'email')) {
    const { data } = await db.from('drip_suppressions')
      .select('reason').eq('tenant_id', tenantId).eq('email', email).limit(1).maybeSingle();
    if (data) return { suppressed: true, reason: data.reason, source: 'drip_suppressions' };
  }

  // 3) customers Outreach-Center flags (matched by email or phone)
  if (email || phone) {
    const cOrs = [];
    if (email) cOrs.push(`email.eq.${email}`);
    if (phone) cOrs.push(`phone.eq.${target.phone}`);
    const { data } = await db.from('customers')
      .select('do_not_contact, do_not_email, do_not_text, unsubscribed, bad_contact')
      .eq('tenant_id', tenantId).or(cOrs.join(',')).limit(5);
    for (const c of data || []) {
      if (c.do_not_contact || c.unsubscribed || c.bad_contact) return { suppressed: true, reason: 'do_not_contact', source: 'customers' };
      if ((channel === 'all' || channel === 'email') && c.do_not_email) return { suppressed: true, reason: 'do_not_email', source: 'customers' };
      if ((channel === 'all' || channel === 'sms') && c.do_not_text) return { suppressed: true, reason: 'do_not_text', source: 'customers' };
    }
  }
  return { suppressed: false };
}

/**
 * Does this lead already have an ACTIVE cadence enrollment?
 * For FGA prospects the relevant cadence is drip_enrollments (keyed by lead_id).
 * The Outreach Center's outreach_enrollments keys by customer/job/partner — a
 * different subject space than cold prospects — so it can't double-enroll a
 * prospecting lead and is intentionally not checked here.
 */
async function hasActiveEnrollment(db, tenantId, leadId) {
  if (!leadId) return { enrolled: false };
  const { data: drip } = await db.from('drip_enrollments')
    .select('id, status').eq('tenant_id', tenantId).eq('lead_id', leadId)
    .in('status', ['active', 'paused', 'review']).limit(1);
  if (drip && drip.length) return { enrolled: true, source: 'drip_enrollments', status: drip[0].status };
  return { enrolled: false };
}

/**
 * Composite gate used before enrolling a prospect into a new cadence.
 * Returns { ok:boolean, reason? }. ok=false means DO NOT enroll/send.
 */
async function canEnroll(db, tenantId, lead = {}) {
  if (lead.status && TERMINAL_LEAD_STATUSES.has(lead.status)) {
    return { ok: false, reason: `terminal_status:${lead.status}` };
  }
  const supp = await isSuppressed(db, tenantId, { email: lead.email, phone: lead.phone, leadId: lead.id });
  if (supp.suppressed) return { ok: false, reason: `suppressed:${supp.reason}`, source: supp.source };
  const enr = await hasActiveEnrollment(db, tenantId, lead.id);
  if (enr.enrolled) return { ok: false, reason: `already_enrolled:${enr.source}` };
  return { ok: true };
}

module.exports = {
  TERMINAL_LEAD_STATUSES,
  normalizeEmail,
  normalizePhone,
  normalizeDomain,
  normalizeName,
  normalizeState,
  findDuplicate,
  isSuppressed,
  hasActiveEnrollment,
  canEnroll,
};
