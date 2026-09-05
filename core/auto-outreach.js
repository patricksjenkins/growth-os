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

const { domainAcceptsMail } = require('./email-verify');
const { resolveRecipientEmail } = require('./recipient');
const { createLogger } = require('./logger');
const { getConfig } = require('./config');
const { isSuppressed, hasActiveEnrollment, normalizeEmail, normalizeDomain, normalizeName } = require('./growth/suppression');
const { evaluateDeliverability } = require('./revenue/deliverability-breaker');
const { isInboundLead } = require('./lead-sources');
const { evaluateEmployeeFit } = require('./growth/eligibility');

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

/**
 * A restart may bypass the ordinary first-touch-only check only when the
 * current sequence is bound to one durable, FGA-scoped authorization record.
 * Metadata by itself is never authority.
 */
async function validateRestartAuthorization(db, tenantId, leadId, sequence) {
  const batchId = sequence?.metadata?.restart_batch_id || null;
  if (!batchId || !sequence?.id) return { authorized: false, reason: 'not_requested' };

  const { data: candidates, error: candidateError } = await db
    .from('growth_restart_candidates')
    .select('batch_id, decision, authorized_at, first_touch_sequence_id, first_touch_sent_at')
    .eq('tenant_id', tenantId)
    .eq('batch_id', batchId)
    .eq('lead_id', leadId)
    .eq('decision', 'eligible')
    .eq('first_touch_sequence_id', sequence.id)
    .limit(1);
  if (candidateError) throw candidateError;
  const candidate = candidates?.[0];
  if (!candidate?.authorized_at) return { authorized: false, reason: 'candidate_not_authorized' };
  if (candidate.first_touch_sent_at) return { authorized: false, reason: 'authorization_consumed' };

  const { data: batches, error: batchError } = await db
    .from('growth_restart_batches')
    .select('id, status, sequence_plan_key')
    .eq('tenant_id', tenantId)
    .eq('id', batchId)
    .eq('status', 'completed')
    .limit(1);
  if (batchError) throw batchError;
  const batch = batches?.[0];
  if (!batch) return { authorized: false, reason: 'batch_not_completed' };
  return { authorized: true, batchId, planKey: batch.sequence_plan_key };
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
    // TENANT-SCOPED. These two reads previously had NO tenant filter, so FGA's
    // circuit breaker counted every tenant's bounces — a client bouncing ten
    // emails could pause FGA's sales department. Full rows (not head counts)
    // because the breaker now classifies hard vs soft and returns the bad
    // addresses for suppression.
    db.from('email_events').select('id, recipient, event, payload, created_at')
      .eq('tenant_id', tenant.id)
      .eq('event', 'bounced')
      .gte('created_at', new Date(now.getTime() - 7 * 86400000).toISOString())
      .limit(500),
    db.from('email_events').select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenant.id)
      .eq('event', 'complained')
      .gte('created_at', new Date(now.getTime() - 7 * 86400000).toISOString()),
  ]);
  for (const [label, result] of Object.entries({ todayRes, weekRes, sent7dRes, bounce7dRes, complaint7dRes })) {
    if (result.error) throw new Error(`autosend_cap_state_${label}_failed:${result.error.message}`);
  }

  const sentToday = todayRes.count || 0;
  const sentThisWeek = weekRes.count || 0;
  const sent7d = sent7dRes.count || 0;
  const bounceEvents = bounce7dRes.data || [];
  const bounces7d = bounceEvents.length;
  const complaints7d = complaint7dRes.count || 0;

  // Breaker logic lives in core/revenue/deliverability-breaker.js. The old
  // inline rule was `sent7d >= 20 && rate >= 4%`, which a single bounce trips
  // for any window of 25 or fewer sends — it stopped the department for two
  // business days on 1 bounce / 24 sends. See that module for the four-part
  // replacement and why raising the threshold was the wrong fix.
  const breaker = evaluateDeliverability(
    { sent7d, bounceEvents, complaints7d },
    { sustainedRatePct: cfgv.bouncePausePct },
  );
  const bounceRate7d = breaker.bounceRatePct;
  const deliverabilityPaused = breaker.paused;
  /*
   * Throttle mode keeps the department ALIVE at reduced volume instead of
   * stopping it. Zero sends freeze the denominator, so a rate breaker that
   * stops dead cannot recover until the oldest bounce ages out — three days
   * dark on our only prospecting channel. Clean sends fix the rate directly.
   * Every send still passes the MX check, so throttled volume is verified
   * volume. (2026-07-29.)
   */
  const throttled = breaker.mode === 'throttle';

  const dailyCap = throttled
    ? Math.min(cfgv.dailyCap, cfgv.dailyMax, breaker.throttleDailyCap)
    : Math.min(cfgv.dailyCap, cfgv.dailyMax);

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
    throttled,
    throttleReason: throttled ? breaker.reason : null,
    // Breaker detail so callers can explain the decision without re-deriving it,
    // plus the addresses that should be suppressed and replaced.
    breakerReason: breaker.reason,
    hardBounces7d: breaker.hardBounces,
    softBounces7d: breaker.softBounces,
    suppressCandidates: breaker.suppressCandidates,
    /*
     * WHEN DOES THE PAUSE LIFT?
     *
     * The rate is measured over a rolling 7 days, so a pause caused by old
     * bounces clears on its own as they age out — but nothing said so. The
     * digest reported the outage with no end date and no action, which reads
     * as "broken indefinitely" when it is actually "waiting until Friday".
     * (2026-07-29.)
     */
    oldestBounceAt: bounceEvents.length
      ? bounceEvents.map((e) => e.created_at).sort()[0]
      : null,
    clearsAt: deliverabilityPaused && bounceEvents.length
      ? new Date(new Date(bounceEvents.map((e) => e.created_at).sort()[0]).getTime() + 7 * 86400000).toISOString()
      : null,
    detail: deliverabilityPaused
      ? breaker.detail
      : `ok: ${sentToday}/${dailyCap} today, ${sentThisWeek}/${cfgv.weeklyTarget} this week${breaker.hardBounces > 0 ? ` (${breaker.hardBounces} hard bounce(s) to suppress)` : ''}`,
  };
}

// ---------------------------------------------------------------------------
// Draft quality — deterministic checks + cached Claude judge
// ---------------------------------------------------------------------------

function stripHtml(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function deterministicDraftChecks({ sequence, lead, bodyText, contactNames = [] }) {
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
  // specifically (company token, a real contact/owner first name, or city).
  //
  // 2026-07-21 fix: this used to check ONLY lead.name, but the drafting agent
  // greets the enriched OWNER by first name from the `contacts` table — the
  // strongest personalization we have. On prospected leads, lead.name is
  // usually the company ("Moore Plumbing and Heating LLC") or a surname
  // ("McGarry"), so a draft opening "Ryan," or "Linda," scored ZERO and was
  // parked in needs_review. 54 good drafts were stranded that way. Contact
  // first names are now first-class inputs to the check.
  const company = String(lead.company_name || lead.company || '').trim();
  const companyToken = company.split(/\s+/).find((w) => w.length >= 4) || company;
  const city = String(lead.city || '').trim();
  const firstNames = [
    String(lead.name || '').trim().split(/\s+/)[0] || '',
    ...contactNames,
  ].map((n) => String(n || '').trim()).filter((n) => n.length >= 3);
  const personalized =
    (companyToken && lower.includes(companyToken.toLowerCase())) ||
    firstNames.some((n) => lower.includes(n.toLowerCase())) ||
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

  // The enriched owner's first name is the personalization the drafting agent
  // actually uses — the check is blind without it (see the note in
  // deterministicDraftChecks). Best-effort: no contacts = fall back to the
  // lead-level fields, exactly as before.
  let contactNames = [];
  try {
    const { data: contacts } = await db
      .from('contacts')
      .select('first_name')
      .eq('tenant_id', tenant.id)
      .eq('lead_id', lead.id)
      .limit(5);
    contactNames = (contacts || []).map((c) => c.first_name).filter(Boolean);
  } catch (_) { /* fall through to lead-level personalization only */ }

  const problems = deterministicDraftChecks({ sequence, lead, bodyText, contactNames });

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
    /*
     * Resolved through the SHARED resolver, not `lead.email` directly.
     * The drafter accepted an address on the lead OR on any contact row; this
     * gate looked only at the lead. A contact-only lead therefore received a
     * Claude-written draft that could never be sent, and both stages reported
     * success. (Codex 2026-07-26, round 5.)
     */
    const resolved = await resolveRecipientEmail(db, tenant.id, lead, sequence);
    const email = normalizeEmail(resolved.email);
    if (!email || !EMAIL_RE.test(email)) return fail('valid_email', `email=${resolved.email || 'null'}`);
    /*
     * A regex cannot tell a real domain from a typo. `anytiimehandymanservices.com`
     * passed this gate, bounced, and helped push the 7-day hard-bounce rate to
     * 4.2% — over the 4% breaker — which stopped ALL outreach for days. At ~70
     * sends a week, three bad addresses are enough to do that. So the domain
     * must be shown to accept mail before it costs us a send.
     *
     * MX only: mailbox-level verification needs SMTP probing, which gets the
     * sending IP blocklisted. Fails OPEN on a DNS error — a resolver blip must
     * not stop the day. (2026-07-29.)
     */
    const mx = await domainAcceptsMail(email);
    if (!mx.ok) return fail('valid_email', `${email}: ${mx.reason}`);
    pass('valid_email', [
      resolved.source === 'contact' ? 'address from contact record' : null,
      mx.reason.startsWith('dns_indeterminate') ? 'domain unverified (DNS unavailable)' : null,
    ].filter(Boolean).join('; ') || undefined);

    // 3. Lead state — first touch only, never terminal/customer.
    // Inbound leads (website form, chat, missed call — anything not on the
    // prospect-source allow-list) are customers reaching in. Hard block:
    // a cold pitch to an inbound lead must never leave the building.
    if (isInboundLead(lead)) return fail('inbound_lead', `lead_source=${lead.lead_source || 'null'} is inbound — cold outreach not allowed`);
    if (lead.status !== 'new_lead') return fail('lead_state', `status=${lead.status}`, 'skip');
    if (['customer', 'unqualified', 'stale'].includes(lead.lifecycle_stage)) {
      return fail('lead_state', `lifecycle=${lead.lifecycle_stage}`, 'skip');
    }
    pass('lead_state');

    // 4. Not an existing customer (email or domain match in customers).
    const domain = normalizeDomain(email.split('@')[1]);
    const { data: custRows, error: customerError } = await db.from('customers')
      .select('id, email').eq('tenant_id', tenant.id).eq('email', email).limit(1);
    if (customerError) throw new Error(`customer_gate_failed:${customerError.message}`);
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
    const { data: dupes, error: duplicateError } = await db.from('leads')
      .select('id, status').eq('tenant_id', tenant.id).eq('email', email).neq('id', lead.id).limit(5);
    if (duplicateError) throw new Error(`duplicate_gate_failed:${duplicateError.message}`);
    const dupWorked = (dupes || []).find((d) => d.status && d.status !== 'new_lead');
    if (dupWorked) return fail('dedupe', `email already worked on lead ${dupWorked.id} (${dupWorked.status})`);
    pass('dedupe');

    // 8. Not already contacted / in an active sequence or drip. A reviewed
    // FGA restart batch may authorize exactly one bound replacement sequence.
    const restart = await validateRestartAuthorization(db, tenant.id, lead.id, sequence);
    const { data: priorSent, error: priorSentError } = await db.from('outreach_sequences')
      .select('id').eq('tenant_id', tenant.id).eq('lead_id', lead.id)
      .in('sequence_status', ['sent', 'sending']).limit(1);
    if (priorSentError) throw new Error(`prior_send_gate_failed:${priorSentError.message}`);
    if (priorSent && priorSent.length && !restart.authorized) {
      return fail('first_touch_only', 'lead already has a sent sequence', 'skip');
    }
    // hasActiveEnrollment returns { enrolled, source?, status? } — check the flag.
    const enrollment = await hasActiveEnrollment(db, tenant.id, lead.id);
    if (enrollment?.enrolled) return fail('not_enrolled', `active ${enrollment.source} enrollment (${enrollment.status})`, 'skip');
    pass('first_touch_only', restart.authorized
      ? `durable restart authorization ${restart.batchId}`
      : null);

    // 9. ICP fit: industry-neutral, but STRICTLY fewer than 10 employees.
    // Unknown headcount is not a rejection, but uncertainty cannot auto-send;
    // it goes back to enrichment for evidence.
    const employeeFit = evaluateEmployeeFit(lead);
    if (employeeFit.decision === 'ineligible') {
      return fail('icp_fit', `${employeeFit.reason}; source=${employeeFit.evidence.source || 'none'}`);
    }
    if (employeeFit.decision === 'needs_evidence') {
      return fail('employee_evidence', employeeFit.reason, 'needs_review');
    }
    // The lead's qualification score lives on the `lead_score` column.
    const score = Number(lead.lead_score);
    if (!Number.isFinite(score) || score < cfgv.scoreThreshold) {
      return fail('score_threshold', `lead_score=${lead.lead_score} < ${cfgv.scoreThreshold}`, 'needs_review');
    }
    pass('icp_fit', `employees=${employeeFit.evidence.count || `${employeeFit.evidence.min}-${employeeFit.evidence.max}`}, score=${score}, icp=${employeeFit.icp_version}`);

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

  /*
   * A TERMINAL VERDICT MUST REACH THE FIELD THE SELECTORS READ.
   *
   * The automation_status write above has existed all along — and nothing
   * selects on automation_status. The drafter picks leads by
   * status='new_lead' (highest score first) and the sender re-evaluates every
   * draft. So a lead blocked for a PERMANENT reason — its email already
   * worked under another lead, a dead address, a suppression — kept its
   * 'new_lead' status, kept its high score, and was re-drafted at the head of
   * the queue every single day, superseding yesterday's identical doomed
   * draft.
   *
   * Measured 2026-08-30: ~25 of the drafter's daily slots were burning on the
   * same recurring companies (EZ Plumbing drafted 5 days straight, each draft
   * blocked on dedupe), fresh-draft supply fell 40/day -> 12, and sends fell
   * with it. Same head-of-line disease this codebase has now hit three times
   * (no-email leads 2026-07-26, wedged drip batch 2026-08-16, this) — the
   * fix each time is that work which cannot succeed must leave the queue.
   *
   * Only reasons that are ATTRIBUTES OF THE LEAD disqualify. Reasons that are
   * circumstances of the moment (caps, breaker, score, draft quality, kill
   * switch) stay retryable. 'disqualified' is in the Patrick-approved
   * CLOSED_STATUSES vocabulary (core/growth/lead-status.js), so suppression,
   * drip, and bulk-send all already treat it as never-contact.
   */
  if (decision === 'blocked' && TERMINAL_BLOCK_REASONS.has(evaluation.reason)) {
    try {
      await db.from('leads').update({
        status: 'disqualified',
        metadata: {
          ...(lead.metadata || {}),
          disqualified_reason: `autosend:${evaluation.reason}`,
          disqualified_detail: evaluation.gates?.[evaluation.reason]?.detail || null,
          disqualified_at: new Date().toISOString(),
        },
      }).eq('id', lead.id).eq('tenant_id', tenant.id).eq('status', 'new_lead');
      // The draft is unsendable by construction — retire it so it stops
      // counting as send-ready inventory and being re-evaluated every pass.
      if (sequence?.id) {
        await db.from('outreach_sequences')
          .update({ sequence_status: 'superseded' })
          .eq('id', sequence.id).eq('tenant_id', tenant.id)
          .eq('sequence_status', 'draft');
      }
    } catch (err) {
      log.warn(`terminal-verdict writeback failed for lead ${lead.id}: ${err.message}`);
    }
  }
}

/**
 * Gate reasons that are permanent properties of the LEAD — no amount of
 * re-drafting or waiting changes them. Everything else (caps, breaker,
 * score_threshold, draft_quality, lead_state, kill_switch...) is a property
 * of the moment and stays retryable.
 */
const TERMINAL_BLOCK_REASONS = new Set([
  'valid_email',   // no address anywhere, bad syntax, or dead MX
  'dedupe',        // this email already belongs to a worked lead
  'suppression',   // unsubscribed / bounced / manually suppressed
  'blocklist',     // matches the owner blocklist
  'not_customer',  // already a paying customer
  'inbound_lead',  // inbound source — cold outreach forbidden by policy
  'icp_fit',       // employee count over the ICP ceiling
]);

module.exports = {
  DEFAULTS,
  BANNED_PHRASES,
  TERMINAL_BLOCK_REASONS,
  autosendConfig,
  validateRestartAuthorization,
  computeCapState,
  deterministicDraftChecks,
  scoreDraftQuality,
  evaluateLeadForAutoSend,
  recordDecision,
  etDayStartIso,
  isoWeekStartIso,
  stripHtml,
};
