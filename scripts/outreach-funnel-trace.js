#!/usr/bin/env node
/**
 * Outreach funnel tracer — WHERE IS EVERY LEAD STUCK, AND WHY?
 *
 * Built 2026-07-22 after a run of one-blocker-at-a-time debugging. The
 * autonomous outreach path has ~11 sequential gates, and each one holds a
 * lead SILENTLY (decision='skip'/'needs_review' is a success, not an error).
 * So every individual bug looked like "the system is being conservative,"
 * and fixing one only revealed the next. This script answers the whole
 * question in one shot: for every FGA lead, which gate stops it?
 *
 * READ-ONLY. Sends nothing. Calls no paid API (the Claude judge at gate 10
 * is NOT invoked — instead we report deterministic-check results and the
 * cached verdict state, which is what decides whether the judge even runs).
 *
 * Usage: node scripts/outreach-funnel-trace.js
 */

require('dotenv').config();

const { getServiceClient } = require('../db/client');
const { resolveTenant } = require('../core/tenant');
const { FGA_TENANT_ID } = require('../core/config');
const {
  autosendConfig, computeCapState, deterministicDraftChecks, stripHtml,
} = require('../core/auto-outreach');
const { isSuppressed, hasActiveEnrollment } = require('../core/growth/suppression');
const { CLOSED_STATUSES } = require('../core/growth/lead-status');

const EMAIL_RE = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/;
const REEVALUATE_AFTER_DAYS = 7;

function bar(n, total, width = 28) {
  const filled = total ? Math.round((n / total) * width) : 0;
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

async function main() {
  const db = getServiceClient();
  const tenant = await resolveTenant(db, FGA_TENANT_ID);
  const cfgv = autosendConfig(tenant);
  const capState = await computeCapState(db, tenant);

  console.log('\n=== OUTREACH FUNNEL TRACE (read-only) ===');
  console.log(`armed=${cfgv.enabled} paused=${cfgv.paused} dailyCap=${capState.dailyCap} ` +
    `sentToday=${capState.sentToday} remaining=${capState.dailyRemaining} ` +
    `scoreThreshold=${cfgv.scoreThreshold} qualityThreshold=${cfgv.qualityThreshold}`);

  // --- The candidate pool exactly as the dispatcher builds it -------------
  const { data: drafts } = await db.from('outreach_sequences')
    .select('*')
    .eq('tenant_id', FGA_TENANT_ID)
    .eq('sequence_type', 'email')
    .eq('sequence_status', 'draft')
    .order('created_at', { ascending: false })
    .limit(3000);

  const since = new Date(Date.now() - REEVALUATE_AFTER_DAYS * 86400000).toISOString();
  const { data: recentDenials } = await db.from('autosend_decisions')
    .select('lead_id').eq('tenant_id', FGA_TENANT_ID)
    .in('decision', ['blocked', 'needs_review']).gte('created_at', since);
  const held = new Set((recentDenials || []).map((r) => r.lead_id).filter(Boolean));

  // Post-fix hold rule: released unless the draft still carries a failing verdict.
  const candidates = (drafts || []).filter((d) => {
    if (!held.has(d.lead_id)) return true;
    const cached = d.metadata?.autosend_quality;
    return !(cached && cached.ok === false);
  });
  const heldOut = (drafts || []).length - candidates.length;

  const leadIds = [...new Set(candidates.map((d) => d.lead_id).filter(Boolean))];
  const { data: leadRows } = leadIds.length
    ? await db.from('leads').select('*').eq('tenant_id', FGA_TENANT_ID).in('id', leadIds)
    : { data: [] };
  const leadById = new Map((leadRows || []).map((l) => [l.id, l]));

  // --- Walk the gates (0-9 faithfully; 10 = deterministic + cache state) --
  const stop = {};           // gate -> count
  const examples = {};       // gate -> sample company
  let readyForJudge = 0;
  const judgeQueue = [];

  for (const seq of candidates) {
    const lead = leadById.get(seq.lead_id);
    const note = (gate, who) => {
      stop[gate] = (stop[gate] || 0) + 1;
      if (!examples[gate]) examples[gate] = who;
    };
    if (!lead) { note('lead_missing', seq.lead_id); continue; }
    const who = lead.company_name || lead.name || lead.id;

    const email = String(lead.email || '').trim().toLowerCase();
    if (!email || !EMAIL_RE.test(email)) { note('valid_email', who); continue; }
    if (lead.status !== 'new_lead') { note(`lead_state:${lead.status}`, who); continue; }
    if (['customer', 'unqualified', 'stale'].includes(lead.lifecycle_stage)) {
      note(`lead_state:lifecycle=${lead.lifecycle_stage}`, who); continue;
    }

    const sup = await isSuppressed(db, FGA_TENANT_ID, { email, phone: lead.phone, leadId: lead.id, channel: 'email' });
    if (sup.suppressed) { note(`suppression:${sup.reason}`, who); continue; }

    const { data: priorSent } = await db.from('outreach_sequences')
      .select('id').eq('tenant_id', FGA_TENANT_ID).eq('lead_id', lead.id)
      .in('sequence_status', ['sent', 'sending']).limit(1);
    if (priorSent && priorSent.length) { note('first_touch_only', who); continue; }
    const enr = await hasActiveEnrollment(db, FGA_TENANT_ID, lead.id);
    if (enr?.enrolled) { note('not_enrolled', who); continue; }

    const employees = Number(lead.employee_count);
    if (Number.isFinite(employees) && employees > 10) { note('icp_fit:employees', who); continue; }
    const score = Number(lead.lead_score);
    if (!Number.isFinite(score) || score < cfgv.scoreThreshold) {
      note(`score_threshold:${Number.isFinite(score) ? `${score}<${cfgv.scoreThreshold}` : 'unscored'}`, who);
      continue;
    }

    // Gate 10 — deterministic first; the judge only runs if this passes.
    const cached = seq.metadata?.autosend_quality;
    if (cached && cached.ok === false) { note('draft_quality:cached_fail', who); continue; }
    const { data: contacts } = await db.from('contacts')
      .select('first_name').eq('tenant_id', FGA_TENANT_ID).eq('lead_id', lead.id).limit(5);
    const contactNames = (contacts || []).map((c) => c.first_name).filter(Boolean);
    const problems = deterministicDraftChecks({
      sequence: seq, lead, bodyText: stripHtml(seq.message_body || ''), contactNames,
    });
    if (problems.length) { note(`draft_quality:${problems[0].split(':')[0]}`, who); continue; }

    readyForJudge++;
    judgeQueue.push({
      company: who,
      score,
      cached_score: cached && typeof cached.score === 'number' ? cached.score : null,
    });
  }

  // --- Report -------------------------------------------------------------
  const total = (drafts || []).length;
  console.log(`\nEmail drafts in 'draft' status: ${total}`);
  console.log(`Held out by recent-denial rule:  ${heldOut}  (drafts still carrying a failing verdict)`);
  console.log(`Entered gate evaluation:         ${candidates.length}\n`);

  console.log('WHERE LEADS STOP:');
  const rows = Object.entries(stop).sort((a, b) => b[1] - a[1]);
  for (const [gate, n] of rows) {
    console.log(`  ${String(n).padStart(4)}  ${bar(n, candidates.length)}  ${gate}`);
    console.log(`        e.g. ${examples[gate]}`);
  }

  console.log(`\nREACH THE AI JUDGE:              ${readyForJudge}`);
  const withCached = judgeQueue.filter((j) => j.cached_score !== null);
  const passing = withCached.filter((j) => j.cached_score >= cfgv.qualityThreshold);
  console.log(`  already judged & passing (>=${cfgv.qualityThreshold}): ${passing.length}`);
  console.log(`  already judged, below threshold:   ${withCached.length - passing.length}`);
  console.log(`  never judged (judge runs next):    ${judgeQueue.length - withCached.length}`);

  const willSend = Math.min(readyForJudge, capState.dailyRemaining);
  console.log(`\nNEXT WINDOW: up to ${capState.dailyRemaining} sendable (cap ${capState.dailyCap}), ` +
    `${readyForJudge} candidates reach the judge -> at most ${willSend} send, ` +
    'judge decides the rest.\n');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
