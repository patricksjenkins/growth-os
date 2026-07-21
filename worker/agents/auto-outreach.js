/**
 * First Gen Automate — Autonomous Outreach Dispatcher (FGA-only)
 *
 * Sends first-touch cold-outreach email drafts WITHOUT manual approval when —
 * and only when — every quality/safety gate in core/auto-outreach.js passes.
 * Everything else lands in a visible review/blocked state. This agent never
 * drafts and never bypasses the proven send path: drafting stays with the
 * outreach agent, sending stays with core/outreach-send.js (atomic claim,
 * email shell, CAN-SPAM unsubscribe + postal address, drip Day-1 enrollment).
 *
 * Cron: three business-hour windows (Mon-Sat) so sends look human and spread
 * across the day; a Monday ramp-review run auto-raises the daily cap when the
 * last 7 days were clean (and never past autosend_daily_max).
 *
 * Arming: tenant_config autonomous_outreach_enabled='true' (default off) and
 * postal_address set. Emergency stop: autosend_paused='true'. Deliverability
 * circuit breaker (bounce/complaint spike) pauses sends automatically and
 * raises an attention item.
 */

const { createLogger } = require('../../core/logger');
const { db } = require('../../db/client');
const { FGA_TENANT_ID } = require('../../core/config');
const {
  autosendConfig,
  computeCapState,
  evaluateLeadForAutoSend,
  recordDecision,
} = require('../../core/auto-outreach');

const SEND_DELAY_MS = 1100; // ~1/sec, under Resend's rate limit
const CANDIDATE_MULTIPLIER = 4; // fetch extra drafts to survive gate denials
const REEVALUATE_AFTER_DAYS = 7; // blocked/review leads get another look weekly
// Floor on how many drafts we pull to evaluate. Evaluation is CHEAP (DB gate
// checks, no API call until a draft actually clears to send), so the pool must
// comfortably cover the whole draft backlog. The old cap was
// dailyRemaining × 4 (= 80 on a 20/day cap) ordered OLDEST-first — once the
// backlog exceeded that (87 drafts, mostly stale already-contacted ones), the
// freshest sendable leads fell off the tail and were never evaluated: 0 sends
// while genuinely-sendable new leads waited. Newest-first + this floor
// guarantees fresh leads always get their shot.
const CANDIDATE_FLOOR = 300;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function raiseAttention(log, { type, severity, title, summary, payload = {} }) {
  // De-dupe: one open item of this type per 24h.
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data: existing } = await db.from('attention_queue')
    .select('id').eq('tenant_id', FGA_TENANT_ID).eq('type', type)
    .gte('created_at', since).limit(1);
  if (existing && existing.length) return;
  await db.from('attention_queue').insert({
    tenant_id: FGA_TENANT_ID, type, severity, title, summary,
    payload, produced_by: 'auto-outreach',
  }).then(() => log.info(`Attention raised: ${type}`), (e) => log.warn(`Attention insert failed: ${e.message}`));
}

/** Monday ramp review: +10/day when the trailing week is clean. */
async function rampReview(tenant, capState, log) {
  const cfgv = autosendConfig(tenant);
  if (capState.deliverabilityPaused) {
    log.info('Ramp review: deliverability paused — cap unchanged');
    return { raised: false, reason: 'deliverability_paused' };
  }
  if (capState.sent7d < Math.min(20, cfgv.dailyCap)) {
    return { raised: false, reason: `not_enough_volume (${capState.sent7d} sends in 7d)` };
  }
  const clean = capState.complaints7d === 0 && capState.bounceRate7d < cfgv.bouncePausePct / 2;
  if (!clean) return { raised: false, reason: `not_clean (bounce ${capState.bounceRate7d}%, complaints ${capState.complaints7d})` };
  if (cfgv.dailyCap >= cfgv.dailyMax) return { raised: false, reason: 'at_max' };

  const next = Math.min(cfgv.dailyCap + 10, cfgv.dailyMax);
  await db.from('tenant_config').upsert(
    { tenant_id: FGA_TENANT_ID, key: 'autosend_daily_cap', value: String(next) },
    { onConflict: 'tenant_id,key' },
  );
  log.success(`Ramp: daily cap ${cfgv.dailyCap} -> ${next} (clean week: bounce ${capState.bounceRate7d}%, 0 complaints)`);
  return { raised: true, from: cfgv.dailyCap, to: next };
}

/**
 * Weekly report (Patrick's reporting requirement): full funnel numbers for
 * LAST week, whether the send target was met, why not, and the next
 * recommended targeting improvement. Delivered as a blue attention item so
 * it lands in the same Owner Action feed as everything else.
 */
async function weeklyReport(tenant, cfgv, log) {
  try {
    const now = new Date();
    const day = (now.getUTCDay() + 6) % 7;
    const thisWeekStart = new Date(now); thisWeekStart.setUTCDate(now.getUTCDate() - day); thisWeekStart.setUTCHours(0, 0, 0, 0);
    const lastWeekStart = new Date(thisWeekStart.getTime() - 7 * 86400000);
    const range = (q) => q.gte('created_at', lastWeekStart.toISOString()).lt('created_at', thisWeekStart.toISOString());

    const [found, withEmail, qualified, autoSent, blocked, review, enrolled, replies, bounced, unsubs] = await Promise.all([
      range(db.from('leads').select('id', { count: 'exact', head: true }).eq('tenant_id', FGA_TENANT_ID).eq('lead_source', 'prospecting_agent')),
      range(db.from('leads').select('id', { count: 'exact', head: true }).eq('tenant_id', FGA_TENANT_ID).eq('lead_source', 'prospecting_agent').not('email', 'is', null)),
      range(db.from('leads').select('id', { count: 'exact', head: true }).eq('tenant_id', FGA_TENANT_ID).eq('lead_source', 'prospecting_agent').gte('lead_score', cfgv.scoreThreshold)),
      range(db.from('autosend_decisions').select('id', { count: 'exact', head: true }).eq('tenant_id', FGA_TENANT_ID).eq('decision', 'sent')),
      range(db.from('autosend_decisions').select('id', { count: 'exact', head: true }).eq('tenant_id', FGA_TENANT_ID).eq('decision', 'blocked')),
      range(db.from('autosend_decisions').select('id', { count: 'exact', head: true }).eq('tenant_id', FGA_TENANT_ID).eq('decision', 'needs_review')),
      range(db.from('drip_enrollments').select('id', { count: 'exact', head: true }).eq('tenant_id', FGA_TENANT_ID)),
      range(db.from('conversations').select('id', { count: 'exact', head: true }).eq('tenant_id', FGA_TENANT_ID).eq('direction', 'inbound').eq('channel', 'email')),
      range(db.from('email_events').select('id', { count: 'exact', head: true }).eq('event', 'bounced')),
      range(db.from('drip_suppressions').select('id', { count: 'exact', head: true }).eq('tenant_id', FGA_TENANT_ID).eq('reason', 'unsubscribe_link')),
    ]);

    const sent = autoSent.count || 0;
    const met = sent >= cfgv.weeklyTarget;
    const coverage = (found.count || 0) > 0 ? Math.round(((withEmail.count || 0) / found.count) * 100) : 0;
    const shortfallWhy = met ? null
      : (found.count || 0) < cfgv.weeklyTarget * 2 ? 'discovery volume too low — raise Serper budget or widen industries'
      : coverage < 40 ? `email coverage only ${coverage}% — enrichment is the bottleneck`
      : (review.count || 0) > sent ? 'most drafts held for review — check quality threshold or draft prompts'
      : 'daily ramp cap limited sends — cap rises automatically after clean weeks';

    // Sales intelligence (2026-07-21): reply performance by industry and by
    // score band — MEASURED from last week's contacted leads only. No
    // extrapolation, no fabricated insight; segments with zero sends are
    // simply absent. Best-effort: a failure here never blocks the report.
    let intelligence = null;
    try {
      const { data: sentRows } = await range(
        db.from('autosend_decisions')
          .select('lead_id').eq('tenant_id', FGA_TENANT_ID).eq('decision', 'sent')
      ).limit(1000);
      const sentLeadIds = [...new Set((sentRows || []).map((r) => r.lead_id).filter(Boolean))];
      if (sentLeadIds.length) {
        const { data: sentLeads } = await db.from('leads')
          .select('id, industry, lead_score, status, lifecycle_stage')
          .eq('tenant_id', FGA_TENANT_ID).in('id', sentLeadIds.slice(0, 500));
        const seg = (key) => {
          const buckets = {};
          for (const l of sentLeads || []) {
            const k = key(l) || 'unknown';
            buckets[k] = buckets[k] || { sent: 0, replied: 0 };
            buckets[k].sent++;
            if (l.status === 'replied' || l.lifecycle_stage === 'interested') buckets[k].replied++;
          }
          return buckets;
        };
        intelligence = {
          by_industry: seg((l) => l.industry),
          by_score_band: seg((l) => {
            const s = Number(l.lead_score) || 0;
            return s >= 80 ? '80+' : s >= 60 ? '60-79' : s >= 40 ? '40-59' : '<40';
          }),
        };
      }
    } catch (intelErr) {
      log.warn(`Sales-intelligence rollup failed (non-fatal): ${intelErr.message}`);
    }

    const topSegment = (() => {
      if (!intelligence) return '';
      const entries = Object.entries(intelligence.by_industry)
        .filter(([, v]) => v.sent >= 3 && v.replied > 0)
        .sort((a, b) => (b[1].replied / b[1].sent) - (a[1].replied / a[1].sent));
      if (!entries.length) return '';
      const [name, v] = entries[0];
      return ` Best segment: ${name} (${v.replied}/${v.sent} replied).`;
    })();

    const summary =
      `Found ${found.count || 0} · with email ${withEmail.count || 0} (${coverage}%) · qualified ${qualified.count || 0} · ` +
      `auto-sent ${sent}/${cfgv.weeklyTarget}${met ? ' (TARGET MET)' : ''} · enrolled in drip ${enrolled.count || 0} · ` +
      `replies ${replies.count || 0} · held for review ${review.count || 0} · blocked ${blocked.count || 0} · ` +
      `bounces ${bounced.count || 0} · unsubscribes ${unsubs.count || 0}.` +
      (met ? '' : ` Not met: ${shortfallWhy}.`) + topSegment;

    await db.from('attention_queue').insert({
      tenant_id: FGA_TENANT_ID,
      type: 'autosend_weekly_report',
      severity: met ? 'blue' : 'amber',
      title: `Autonomous outreach last week: ${sent}/${cfgv.weeklyTarget} sent${met ? ' — target met' : ''}`,
      summary,
      payload: {
        found: found.count || 0, with_email: withEmail.count || 0, email_coverage_pct: coverage,
        qualified: qualified.count || 0, auto_sent: sent, target: cfgv.weeklyTarget, target_met: met,
        enrolled_in_drip: enrolled.count || 0, replies: replies.count || 0,
        needs_review: review.count || 0, blocked: blocked.count || 0,
        bounces: bounced.count || 0, unsubscribes: unsubs.count || 0,
        shortfall_reason: shortfallWhy,
        intelligence,
      },
      produced_by: 'auto-outreach',
    });
    log.success(`Weekly report: ${summary}`);
    return { sent, target: cfgv.weeklyTarget, met, shortfall_reason: shortfallWhy };
  } catch (err) {
    log.warn(`Weekly report failed: ${err.message}`);
    return { error: err.message };
  }
}

async function run(tenant, payload = {}) {
  const log = createLogger('auto-outreach', tenant.slug);

  if (tenant.id !== FGA_TENANT_ID) {
    return { success: true, skipped: true, reason: 'not_fga_tenant' };
  }

  const cfgv = autosendConfig(tenant);
  if (!cfgv.enabled) {
    return { success: true, skipped: true, reason: 'autonomous_outreach_disabled' };
  }

  const capState = await computeCapState(db, tenant);

  // Weekly ramp review + weekly report (Monday cron, payload.task='ramp_review').
  if (payload.task === 'ramp_review') {
    const ramp = await rampReview(tenant, capState, log);
    const report = await weeklyReport(tenant, cfgv, log);
    return { success: true, task: 'ramp_review', ...ramp, report, capState };
  }

  if (cfgv.paused) {
    log.warn('autosend_paused=true — skipping run');
    return { success: true, skipped: true, reason: 'kill_switch', capState };
  }
  if (capState.deliverabilityPaused) {
    await raiseAttention(log, {
      type: 'autosend_deliverability',
      severity: 'red',
      title: `Autonomous outreach paused — ${capState.detail}`,
      summary: `The deliverability circuit breaker tripped (bounce rate ${capState.bounceRate7d}% / ${capState.complaints7d} complaints in 7 days). Sends stop automatically until the trailing week is clean. Review email_events and recent targeting.`,
      payload: { bounce_rate_7d: capState.bounceRate7d, complaints_7d: capState.complaints7d, sent_7d: capState.sent7d },
    });
    return { success: true, skipped: true, reason: 'deliverability_paused', capState };
  }
  if (capState.dailyRemaining <= 0) {
    return { success: true, skipped: true, reason: 'daily_cap_reached', capState };
  }

  // ---- Candidate drafts: email drafts, first-touch leads, not recently held.
  const { data: drafts } = await db.from('outreach_sequences')
    .select('*')
    .eq('tenant_id', FGA_TENANT_ID)
    .eq('sequence_type', 'email')
    .eq('sequence_status', 'draft')
    // Newest-first so a fresh lead is never starved by the stale backlog; the
    // floor keeps the whole realistic backlog in the pool (eval is cheap). The
    // set is re-sorted by lead_score below, so fetch order only decides which
    // drafts are considered, not the send order.
    .order('created_at', { ascending: false })
    .limit(Math.max(capState.dailyRemaining * CANDIDATE_MULTIPLIER, CANDIDATE_FLOOR));
  if (!drafts || drafts.length === 0) {
    log.info('No email drafts waiting');
    return { success: true, sent: 0, evaluated: 0, reason: 'no_drafts', capState };
  }

  // Exclude leads with a recent blocked/needs_review decision (re-checked weekly).
  const since = new Date(Date.now() - REEVALUATE_AFTER_DAYS * 86400000).toISOString();
  const { data: recentDenials } = await db.from('autosend_decisions')
    .select('lead_id')
    .eq('tenant_id', FGA_TENANT_ID)
    .in('decision', ['blocked', 'needs_review'])
    .gte('created_at', since);
  const held = new Set((recentDenials || []).map((r) => r.lead_id).filter(Boolean));

  const candidateDrafts = drafts.filter((d) => !held.has(d.lead_id));
  const leadIds = [...new Set(candidateDrafts.map((d) => d.lead_id).filter(Boolean))];
  if (!leadIds.length) {
    return { success: true, sent: 0, evaluated: 0, reason: 'all_candidates_held', capState };
  }
  const { data: leadRows } = await db.from('leads')
    .select('*').eq('tenant_id', FGA_TENANT_ID).in('id', leadIds);
  const leadById = new Map((leadRows || []).map((l) => [l.id, l]));

  // Highest-score leads first.
  candidateDrafts.sort((a, b) =>
    (Number(leadById.get(b.lead_id)?.lead_score) || 0) - (Number(leadById.get(a.lead_id)?.lead_score) || 0));

  const summary = { evaluated: 0, sent: 0, needs_review: 0, blocked: 0, skipped: 0, send_failed: 0 };
  let remaining = capState.dailyRemaining;
  const runCapState = { ...capState };

  for (const sequence of candidateDrafts) {
    if (remaining <= 0) break;
    const lead = leadById.get(sequence.lead_id);
    if (!lead) continue;

    summary.evaluated++;
    runCapState.dailyRemaining = remaining;
    const evaluation = await evaluateLeadForAutoSend(db, { tenant, lead, sequence, capState: runCapState });

    if (evaluation.decision === 'send') {
      const { sendEmailOutreachSequence } = require('../../core/outreach-send');
      const result = await sendEmailOutreachSequence(db, lead.id, sequence.id, { sentVia: 'auto_send' });
      if (result.ok) {
        summary.sent++;
        remaining--;
        await recordDecision(db, { tenant, lead, sequence, evaluation, sent: true });
        log.success(`Auto-sent to ${result.recipient} (${lead.company_name || lead.company || lead.id}) — ${evaluation.gates.draft_quality?.detail}`);
        await sleep(SEND_DELAY_MS);
      } else {
        summary.send_failed++;
        await recordDecision(db, {
          tenant, lead, sequence,
          evaluation: { ...evaluation, decision: 'needs_review', reason: `send_failed:${result.code}` },
          sent: false,
        });
        log.warn(`Send failed for lead ${lead.id}: ${result.code} — ${result.error}`);
      }
    } else if (evaluation.decision === 'needs_review') {
      summary.needs_review++;
      await recordDecision(db, { tenant, lead, sequence, evaluation, sent: false });
    } else if (evaluation.decision === 'blocked') {
      summary.blocked++;
      await recordDecision(db, { tenant, lead, sequence, evaluation, sent: false });
    } else {
      // 'skip' — transient (caps) or wrong-state; caps end the loop.
      summary.skipped++;
      if (['daily_cap', 'deliverability', 'kill_switch'].includes(evaluation.reason)) break;
      await recordDecision(db, { tenant, lead, sequence, evaluation, sent: false });
    }
  }

  // Surface a review queue heads-up when it is piling up.
  if (summary.needs_review >= 5) {
    await raiseAttention(log, {
      type: 'autosend_review_queue',
      severity: 'amber',
      title: `${summary.needs_review} outreach drafts need manual review`,
      summary: 'Autonomous outreach held these sends (low score, weak draft, or missing data). Review them in Pipeline — approving manually still works as before.',
      payload: { needs_review: summary.needs_review },
    });
  }

  log.success(`Run done: ${summary.sent} sent, ${summary.needs_review} to review, ${summary.blocked} blocked, ${summary.skipped} skipped (of ${summary.evaluated} evaluated)`);
  return { success: true, ...summary, capState: { ...capState, dailyRemaining: remaining } };
}

module.exports = run;
