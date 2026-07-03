/**
 * First Gen Automate — autonomous outreach gate engine
 *
 * Decides, per (lead, email draft), whether a first-touch cold email may be
 * sent WITHOUT manual approval. Every evaluation is written to
 * autosend_decisions (the "why was this allowed" audit trail Patrick asked
 * for), and every deny lands the lead in a visible review/blocked state via
 * leads.automation_status — nothing silently disappears.
 *
 * Design rules:
 *  - Cheap deterministic gates run first; the Claude draft-quality judge runs
 *    last and its verdict is CACHED on the sequence so re-runs are free.
 *  - Uncertainty NEVER auto-sends: any gate error routes to needs_review.
 *  - The engine only decides. Sending stays in core/outreach-send.js (the one
 *    proven choke point), driven by worker/agents/auto-outreach.js.
 *
 * Config (tenant_config, FGA tenant):
 *  - autonomous_outreach_enabled  'true' to arm the agent (default off)
 *  - autosend_paused              emergency kill switch ('true' pauses)
 *  - autosend_daily_cap           sends/day ramp cap (default 20)
 *  - autosend_daily_max           ramp ceiling (default 60)
 *  - autosend_weekly_target       goal, informational for pacing (default 150)
 *  - autosend_score_threshold     min lead score (default 60)
 *  - autosend_quality_threshold   min draft quality 0-100 (default 70)
 *  - autosend_bounce_pause_pct    7d bounce-rate circuit breaker (default 4)
 *  - outreach_blocklist           JSON array of domains/company names never
 *                                 to auto-contact (competitors, DNC, etc.)
 *  - postal_address               REQUIRED for CAN-SPAM footer
 */

const { createLogger } = require('./logger');
const { getConfig } = require('./config');
const { isSuppressed, hasActiveEnrollment, normalizeEmail, normalizeDomain, normalizeName } = require('./growth/suppression');

const log = createLogger('auto-outreach');

const DEFAULTS = {
  dailyCap: 20,
  dailyMax: 60,
  weeklyTarget: 150,
  scoreThreshold: 60,
  qualityThreshold: 70,
  bouncePausePct: 4,
  complaintPause7d: 1, // any complaint in 7d pauses
  minBodyChars: 180,
  maxBodyChars: 1600,
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Phrases that are never allowed to leave the building autonomously.
// (No-overpromise + no scheduling/dispatch capability + banned verb.)
const BANNED_PHRASES = [
  'guarantee', 'guaranteed', 'risk-free', 'no risk',
  'double your revenue', 'triple your', 'x your revenue',
  'fill your schedule', 'fills your schedule', 'on the schedule',
  "we'll book", 'we will book', 'book you ', 'book your customers',
  'dispatch a', 'dispatch your', 'we install', 'install growth',
  'fully autonomous business', 'runs itself completely', 'no follow-up required',
];

function num(tenant, key, fallback) {
  const v = Number(getConfig(tenant, key, fallback));
  return Number.isFinite(v) ? v : fallback;
}

function bool(tenant, key, fallback = false) {
  const v = getConfig(tenant, key, fallback);
  return v === true || v === 'true';
}

function autosendConfig(tenant) {
  return {
    enabled: bool(tenant, 'autonomous_outreach_enabled', false),
    paused: bool(tenant, 'autosend_paused', false),
    dailyCap: num(tenant, 'autosend_daily_cap', DEFAULTS.dailyCap),
    dailyMax: num(tenant, 'autosend_daily_max', DEFAULTS.dailyMax),
    weeklyTarget: num(tenant, 'autosend_weekly_target', DEFAULTS.weeklyTarget),
    scoreThreshold: num(tenant, 'autosend_score_threshold', DEFAULTS.scoreThreshold),
    qualityThreshold: num(tenant, 'autosend_quality_threshold', DEFAULTS.qualityThreshold),
    bouncePausePct: num(tenant, 'autosend_bounce_pause_pct', DEFAULTS.bouncePausePct),
    postalAddress: getConfig(tenant, 'postal_address', null) || null,
    blocklist: (() => {
      const raw = getConfig(tenant, 'outreach_blocklist', []);
      return Array.isArray(raw) ? raw.map((s) => String(s).toLowerCase().trim()).filter(Boolean) : [];
    })(),
  };
}

// ---------------------------------------------------------------------------
// Cap state — computed once per agent run, shared across evaluations
// ---------------------------------------------------------------------------

function etDayStartIso(now = new Date()) {
  // Midnight ET expressed in UTC. ET is UTC-4 or -5; use Intl to get the date
  // in ET then anchor at 04:00Z (safe within DST drift for a daily counter).
  const etDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(now);
  return `${etDate}T04:00:00.000Z`;
}

function isoWeekStartIso(now = new Date()) {
  const d = new Date(now);
  const day = (d.getUTCDay() + 6) % 7; // Mon=0
  d.setUTCDate(d.getUTCDate() - day);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

/**
 * @returns {{ sentToday, sentThisWeek, dailyRemaining, weeklyTarget,
 *             bounceRate7d, complaints7d, deliverabilityPaused, detail }}
 */
async function computeCapState(db, tenant, now = new Date()) {
  const cfgv = autosendConfig(tenant);
  const dayStart = etDayStartIso(now);
  const weekStart = isoWeekStartIso(now);

  const [todayRes, weekRes, sent7dRes, bounce7dRes, complaint7dRes] = await Promise.all([
    db.from('autosend_decisions').select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenant.id).eq('decision', 'sent').gte('created_at', dayStart),
    db.from('autosend_decisions').select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenant.id).eq('decision', 'sent').gte('created_at', weekStart),
    db.from('autosend_decisions').select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenant.id).eq('decision', 'sent')
      .gte('created_at', new Date(now.getTime() - 7 * 86400000).toISOString()),
    db.from('email_events').select('id', { count: 'exact', head: true })
      .eq('event', 'bounced')
      .gte('created_at', new Date(now.getTime() - 7 * 86400000).toISOString()),
    db.from('email_events').select('id', { count: 'exact', head: true })
      .eq('event', 'complained')
      .gte('created_at', new Date(now.getTime() - 7 * 86400000).toISOString()),
  ]);

  const sentToday = todayRes.count || 0;
  const sentThisWeek = weekRes.count || 0;
  const sent7d = sent7dRes.count || 0;
  const bounces7d = bounce7dRes.count || 0;
  const complaints7d = complaint7dRes.count || 0;
  const bounceRate7d = sent7d > 0 ? (bounces7d / sent7d) * 100 : 0;

  const deliverabilityPaused =
    (sent7d >= 20 && bounceRate7d >= cfgv.bouncePausePct) ||
    complaints7d >= DEFAULTS.complaintPause7d;

  const dailyCap = Math.min(cfgv.dailyCap, cfgv.dailyMax);

  return {
    sentToday,
    sentThisWeek,
    sent7d,
    bounces7d,
    complaints7d,
    bounceRate7d: Number(bounceRate7d.toFixed(2)),
    dailyCap,
    dailyRemaining: Math.max(0, dailyCap - sentToday),
    weeklyTarget: cfgv.weeklyTarget,
    deliverabilityPaused,
    detail: deliverabilityPaused
      ? `paused: bounce ${bounceRate7d.toFixed(1)}% / complaints ${complaints7d} in 7d`
      : `ok: ${sentToday}/${dailyCap} today, ${sentThisWeek}/${cfgv.weeklyTarget} this week`,
  };
}

// ---------------------------------------------------------------------------
// Draft quality — deterministic checks + cached Claude judge
// ---------------------------------------------------------------------------

function stripHtml(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function deterministicDraftChecks({ sequence, lead, bodyText }) {
  const problems = [];
  if (!sequence.message_subject || sequence.message_subject.trim().length < 4) problems.push('missing_subject');
  if (bodyText.length < DEFAULTS.minBodyChars) problems.push('body_too_short');
  if (bodyText.length > DEFAULTS.maxBodyChars) problems.push('body_too_long');
  if (/\{\{|\}\}|\[(first.?name|company|city|name)\]/i.test(bodyText)) problems.push('template_artifact');
  if (/—|–/.test(bodyText)) problems.push('em_dash');

  const lower = bodyText.toLowerCase();
  const banned = BANNED_PHRASES.filter((p) => lower.includes(p));
  if (banned.length) problems.push(`banned_phrase:${banned[0]}`);

  // Personalization heuristic: the draft must reference the prospect
  // specifically (company token, first name, or city).
  const company = String(lead.company_name || lead.company || '').trim();
  const companyToken = company.split(/\s+/).find((w) => w.length >= 4) || company;
  const first = String(lead.name || '').trim().split(/\s+/)[0] || '';
  const city = String(lead.city || '').trim();
  const personalized =
    (companyToken && lower.includes(companyToken.toLowerCase())) ||
    (first && first.length >= 3 && lower.includes(first.toLowerCase())) ||
    (city && city.length >= 4 && lower.includes(city.toLowerCase()));
  if (!personalized) problems.push('missing_personalization');

  return problems;
}

/**
 * Full draft-quality verdict: deterministic checks + Claude judge, cached on
 * outreach_sequences.metadata.autosend_quality so each draft pays once.
 * Returns { ok, score, problems, judged_by }.
 */
async function scoreDraftQuality(db, { tenant, lead, sequence }) {
  const cached = sequence.metadata?.autosend_quality;
  if (cached && typeof cached.score === 'number') return cached;

  const { data: conv } = await db
    .from('conversations')
    .select('metadata, message_body')
    .eq('sequence_id', sequence.id)
    .order('created_at', { ascending: false })
    .limit(1);
  const bodyHtml = conv && conv[0]?.metadata?.body_html ? conv[0].metadata.body_html : (sequence.message_body || '');
  const bodyText = stripHtml(bodyHtml);

  const problems = deterministicDraftChecks({ sequence, lead, bodyText });

  let verdict;
  if (problems.length) {
    // Deterministic failure — no need to pay for the judge.
    verdict = { ok: false, score: 0, problems, judged_by: 'deterministic' };
  } else {
    try {
      const { askClaudeJSON } = require('../integrations/claude');
      const system = `You are the quality gate for First Gen Automate's autonomous cold outreach. Judge this first-touch email draft to a micro-business owner. Rules it must obey:
- Short, human, specific to THIS business. Not a feature dump.
- Never overpromise: no guarantees, no revenue claims, no "books appointments/fills your schedule/dispatches" (FGA has no calendar or dispatch visibility), no "fully autonomous business".
- FGA is "deployed" or "set up", never "installed".
- Honest, plain-spoken, sounds like a real founder wrote it.
Return JSON only: {"score": 0-100, "overpromise": bool, "sounds_human": bool, "specific_to_business": bool, "problems": [short strings]}`;
      const judged = await askClaudeJSON(system,
        `Subject: ${sequence.message_subject}\n\nBody:\n${bodyText}\n\nProspect: ${lead.company_name || lead.company || 'unknown'} (${lead.industry || 'unknown industry'}, ${lead.city || ''} ${lead.state || ''})`,
        { maxTokens: 500, tenantSlug: tenant.slug });
      const score = Number(judged?.score);
      const judgeProblems = Array.isArray(judged?.problems) ? judged.problems.slice(0, 6) : [];
      const ok = Number.isFinite(score) &&
        score >= autosendConfig(tenant).qualityThreshold &&
        judged.overpromise !== true &&
        judged.sounds_human !== false &&
        judged.specific_to_business !== false;
      verdict = {
        ok,
        score: Number.isFinite(score) ? score : 0,
        problems: ok ? [] : (judgeProblems.length ? judgeProblems : ['judge_rejected']),
        judged_by: 'claude',
      };
    } catch (err) {
      // Judge unavailable → uncertainty never auto-sends.
      verdict = { ok: false, score: 0, problems: [`judge_error:${err.message.slice(0, 80)}`], judged_by: 'error' };
    }
  }

  try {
    await db.from('outreach_sequences')
      .update({ metadata: { ...(sequence.metadata || {}), autosend_quality: verdict } })
      .eq('id', sequence.id);
  } catch (_) { /* cache write is best-effort */ }
  return verdict;
}

// ---------------------------------------------------------------------------
// The gate run
// ---------------------------------------------------------------------------

/**
 * Evaluate one (lead, draft sequence) for autonomous first-touch send.
 * @returns {{ decision: 'send'|'needs_review'|'blocked'|'skip',
 *             reason, gates, quality? }}
 */
async function evaluateLeadForAutoSend(db, { tenant, lead, sequence, capState }) {
  const cfgv = autosendConfig(tenant);
  const gates = {};
  const fail = (name, detail, decision = 'blocked') => {
    gates[name] = { pass: false, detail };
    return { decision, reason: name, gates };
  };
  const pass = (name, detail = null) => { gates[name] = { pass: true, ...(detail ? { detail } : {}) }; };

  try {
    // 0. Compliance config — never send bulk cold email without a postal address.
    if (!cfgv.postalAddress) return fail('postal_address_config', 'tenant_config.postal_address missing', 'needs_review');
    pass('postal_address_config');

    // 1. Deliverability circuit breaker + caps.
    if (cfgv.paused) return fail('kill_switch', 'autosend_paused=true', 'skip');
    if (capState.deliverabilityPaused) return fail('deliverability', capState.detail, 'skip');
    if (capState.dailyRemaining <= 0) return fail('daily_cap', `${capState.sentToday}/${capState.dailyCap} today`, 'skip');
    pass('caps', capState.detail);

    // 2. Valid email.
    const email = normalizeEmail(lead.email);
    if (!email || !EMAIL_RE.test(email)) return fail('valid_email', `email=${lead.email || 'null'}`);
    pass('valid_email');

    // 3. Lead state — first touch only, never terminal/customer.
    if (lead.status !== 'new_lead') return fail('lead_state', `status=${lead.status}`, 'skip');
    if (['customer', 'unqualified', 'stale'].includes(lead.lifecycle_stage)) {
      return fail('lead_state', `lifecycle=${lead.lifecycle_stage}`, 'skip');
    }
    pass('lead_state');

    // 4. Not an existing customer (email or domain match in customers).
    const domain = normalizeDomain(email.split('@')[1]);
    const { data: custRows } = await db.from('customers')
      .select('id, email').eq('tenant_id', tenant.id).eq('email', email).limit(1);
    if (custRows && custRows.length) return fail('not_customer', 'email matches customers table');
    pass('not_customer');

    // 5. Blocklist (competitors / do-not-contact by domain or name).
    const companyNorm = normalizeName(lead.company_name || lead.company || '');
    const blocked = cfgv.blocklist.find((b) =>
      (domain && (domain === b || domain.endsWith(`.${b}`))) ||
      (companyNorm && companyNorm.includes(b)));
    if (blocked) return fail('blocklist', `matches "${blocked}"`);
    pass('blocklist');

    // 6. Suppression (central lead_suppressions + drip_suppressions + DNC).
    const sup = await isSuppressed(db, tenant.id, { email, phone: lead.phone, leadId: lead.id, channel: 'email' });
    if (sup.suppressed) return fail('suppression', `${sup.reason} (${sup.source})`);
    pass('suppression');

    // 7. Duplicate: another lead with this email already worked.
    const { data: dupes } = await db.from('leads')
      .select('id, status').eq('tenant_id', tenant.id).eq('email', email).neq('id', lead.id).limit(5);
    const dupWorked = (dupes || []).find((d) => d.status && d.status !== 'new_lead');
    if (dupWorked) return fail('dedupe', `email already worked on lead ${dupWorked.id} (${dupWorked.status})`);
    pass('dedupe');

    // 8. Not already contacted / in an active sequence or drip.
    const { data: priorSent } = await db.from('outreach_sequences')
      .select('id').eq('tenant_id', tenant.id).eq('lead_id', lead.id)
      .in('sequence_status', ['sent', 'sending']).limit(1);
    if (priorSent && priorSent.length) return fail('first_touch_only', 'lead already has a sent sequence', 'skip');
    // hasActiveEnrollment returns { enrolled, source?, status? } — check the flag.
    const enrollment = await hasActiveEnrollment(db, tenant.id, lead.id);
    if (enrollment?.enrolled) return fail('not_enrolled', `active ${enrollment.source} enrollment (${enrollment.status})`, 'skip');
    pass('first_touch_only');

    // 9. ICP fit: employees <= 10 (missing tolerated — micro businesses rarely
    // publish counts) + lead score threshold.
    const employees = Number(lead.employee_count);
    if (Number.isFinite(employees) && employees > 10) return fail('icp_fit', `employee_count=${employees} > 10`);
    const score = Number(lead.score);
    if (!Number.isFinite(score) || score < cfgv.scoreThreshold) {
      return fail('score_threshold', `score=${lead.score} < ${cfgv.scoreThreshold}`, 'needs_review');
    }
    pass('icp_fit', `employees=${Number.isFinite(employees) ? employees : 'unknown'}, score=${score}`);

    // 10. Draft quality (deterministic + Claude judge, cached).
    const quality = await scoreDraftQuality(db, { tenant, lead, sequence });
    if (!quality.ok) {
      return { decision: 'needs_review', reason: 'draft_quality', gates: { ...gates, draft_quality: { pass: false, detail: quality.problems.join(', ') } }, quality };
    }
    gates.draft_quality = { pass: true, detail: `score=${quality.score}` };

    return { decision: 'send', reason: 'all_gates_passed', gates, quality };
  } catch (err) {
    // Uncertainty never auto-sends.
    log.warn(`Gate evaluation error for lead ${lead.id}: ${err.message}`);
    return { decision: 'needs_review', reason: 'gate_error', gates: { ...gates, error: { pass: false, detail: err.message.slice(0, 120) } } };
  }
}

/** Persist the decision + reflect it on the lead's automation_status. */
async function recordDecision(db, { tenant, lead, sequence, evaluation, sent }) {
  const decision = sent ? 'sent' : evaluation.decision === 'send' ? 'blocked' : evaluation.decision === 'skip' ? 'skipped' : evaluation.decision;
  try {
    await db.from('autosend_decisions').insert({
      tenant_id: tenant.id,
      lead_id: lead.id,
      sequence_id: sequence?.id || null,
      decision,
      reason: evaluation.reason,
      gates: evaluation.gates || {},
      quality: evaluation.quality || null,
    });
  } catch (err) {
    log.warn(`autosend_decisions insert failed: ${err.message}`);
  }

  const statusMap = {
    sent: 'auto_sent',
    needs_review: 'needs_review',
    blocked: evaluation.reason === 'suppression' ? 'blocked_suppressed'
      : evaluation.reason === 'dedupe' ? 'blocked_duplicate'
      : evaluation.reason === 'valid_email' ? 'blocked_no_email'
      : 'needs_review',
  };
  const automationStatus = statusMap[decision];
  if (automationStatus) {
    try {
      await db.from('leads').update({ automation_status: automationStatus })
        .eq('id', lead.id).eq('tenant_id', tenant.id);
    } catch (_) { /* non-fatal */ }
  }
}

module.exports = {
  DEFAULTS,
  BANNED_PHRASES,
  autosendConfig,
  computeCapState,
  deterministicDraftChecks,
  scoreDraftQuality,
  evaluateLeadForAutoSend,
  recordDecision,
  etDayStartIso,
  isoWeekStartIso,
  stripHtml,
};
