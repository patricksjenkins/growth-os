/**
 * Revenue outcome API — the CEO's answer to "did outreach happen today?"
 *
 * Every number here is derived from the same modules the Chief Revenue Agent
 * uses, so the dashboard cannot drift from the agent's own verdict. That
 * mattered: previous dashboards recomputed metrics independently and
 * disagreed with the underlying records.
 *
 * FGA-internal only.
 */

const express = require('express');
const router = express.Router();
const { getServiceClient } = require('../../db/client');
const { createLogger } = require('../../core/logger');
const { FGA_TENANT_ID } = require('../../core/config');
const {
  DEFAULTS, HEALTH, isUnhealthy, etParts, isBusinessDay,
  expectedByNow, currentCheckpoint, assessHealth, countFirstTouchSends,
  readDailyTarget,
} = require('../../core/revenue/daily-outcome');
const { traceFunnel, primaryBlocker } = require('../../core/revenue/funnel-trace');

const log = createLogger('admin-revenue-outcome');

// GET /api/admin/revenue-outcome — today's outcome, funnel and incident
router.get('/', async (req, res) => {
  try {
    const db = getServiceClient();
    const now = new Date();
    // readDailyTarget is the one shared, tested config read. The original
    // inline read called resolveTenant with a single argument against a
    // two-argument signature, so it always threw and fell back to 25.
    const { target, source: targetSource } = await readDailyTarget(db);

    const [counted, trace, yesterday] = await Promise.all([
      countFirstTouchSends(db, { date: now }),
      traceFunnel(db, { date: now }),
      countFirstTouchSends(db, { date: new Date(now.getTime() - 86400000) }),
    ]);

    const assessed = assessHealth({
      target, sentToday: counted.count, inventory: trace.inventory,
      blockers: trace.blockers, now,
    });
    const blocker = primaryBlocker(trace);
    const checkpoint = currentCheckpoint(now);

    // Open revenue incident (one per condition) + last remediation + any open
    // Tier-2 request sitting with reliability.
    const [
      { data: incidents }, { data: remediations }, { data: lastSend }, reliabilityHandoffs,
    ] = await Promise.all([
      db.from('attention_queue')
        .select('id, severity, title, summary, payload, produced_at')
        .eq('tenant_id', FGA_TENANT_ID).eq('type', 'revenue_outcome')
        .is('resolved_at', null).order('produced_at', { ascending: false }).limit(5),
      db.from('activity_log')
        .select('created_at, metadata').eq('tenant_id', FGA_TENANT_ID)
        .eq('action', 'revenue_remediation').order('created_at', { ascending: false }).limit(5),
      db.from('activity_log')
        .select('created_at, metadata').eq('tenant_id', FGA_TENANT_ID)
        .eq('action', 'outreach_sent').order('created_at', { ascending: false }).limit(1),
      db.from('ops_incidents')
        .select('id, agent_name, issue_type, permission_level, verification_result, detected_at, diagnosis_summary')
        .eq('tenant_id', FGA_TENANT_ID).like('issue_type', 'revenue_%')
        .in('status', ['open', 'remediating', 'awaiting_approval'])
        .order('detected_at', { ascending: false }).limit(10)
        .then((r) => r.data || [], () => []),
    ]);

    // Week-to-date progress against the same invariant.
    const weekDays = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(now.getTime() - i * 86400000);
      if (!isBusinessDay(d)) continue;
      weekDays.push(d);
      if (weekDays.length >= 5) break;
    }
    const weekCounts = await Promise.all(
      weekDays.map((d) => countFirstTouchSends(db, { date: d }).catch(() => ({ count: 0, etDate: etParts(d).date })))
    );

    res.json({
      success: true,
      generated_at: now.toISOString(),
      et_date: counted.etDate,
      is_business_day: isBusinessDay(now),
      target,
      // 'config' | 'default' | 'error_fallback' — error_fallback means the
      // configured target could not be read and 25 is a stand-in, not truth.
      target_source: targetSource,
      sent_today: counted.count,
      remaining: assessed.remaining ?? Math.max(0, target - counted.count),
      expected_by_now: assessed.expected ?? expectedByNow(target, now),
      on_pace: assessed.onPace ?? null,
      health: assessed.health,
      health_reason: assessed.reason,
      unhealthy: isUnhealthy(assessed.health),
      checkpoint: checkpoint?.label || null,
      blocker,
      inventory: trace.inventory,
      funnel: trace.stages,
      supply_chain: trace.supplyChain || [],
      // Stage counts that cannot all be true. Surfaced rather than hidden so
      // the owner is told the evidence is unreliable instead of trusting it.
      funnel_anomalies: trace.anomalies || [],
      block_reasons: trace.blockReasons,
      // Open Tier-2 requests to reliability. Without these the panel could show
      // "blocked" with no indication that anyone had been asked to fix it.
      reliability_handoffs: reliabilityHandoffs,
      // Why rows were excluded from the count, so "21 sent" reconciles.
      send_rejections: counted.rejected || {},
      duplicates_excluded: counted.duplicatesExcluded,
      prospects: counted.prospects,
      yesterday: { et_date: yesterday.etDate, sent: yesterday.count },
      week: weekCounts.map((w) => ({ et_date: w.etDate, sent: w.count, target })),
      incident: incidents && incidents.length ? incidents[0] : null,
      open_incidents: (incidents || []).length,
      last_remediation: remediations && remediations.length ? remediations[0] : null,
      last_provider_accepted_send: lastSend && lastSend.length
        ? { at: lastSend[0].created_at, recipient: lastSend[0].metadata?.recipient || null }
        : null,
      guardian: {
        agent: 'revenue-guardian',
        checkpoints: DEFAULTS.checkpoints.map(([h, m, f, label]) =>
          ({ label, at: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} ET`, expected: Math.round(target * f) })),
      },
    });
  } catch (err) {
    log.error(`revenue-outcome failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/admin/revenue-outcome/sends?date=YYYY-MM-DD
 *
 * WHO was emailed on a given ET day, and WHAT was sent to them.
 *
 * The panel could show "25 / 25" and offer no way to see the 25. A number you
 * cannot open is a number you have to take on faith, which is the opposite of
 * what this department was rebuilt for — Patrick asked to click a day, see the
 * recipients, and read the actual email.
 *
 * Counted the SAME way as the headline figure: the send ledger in activity_log,
 * requiring provider acceptance and a gate receipt. So the list length always
 * equals the number on the tile — it is the same evidence, itemised.
 */
router.get('/sends', async (req, res) => {
  try {
    const db = getServiceClient();
    const etDate = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || ''))
      ? String(req.query.date)
      : etParts(new Date()).date;

    const counted = await countFirstTouchSends(db, {
      date: new Date(`${etDate}T12:00:00Z`), tenantId: FGA_TENANT_ID,
    });
    const prospects = counted.prospects || [];
    if (!prospects.length) return res.json({ success: true, date: etDate, sends: [] });

    // Enrich with the company and the message actually sent. Both are looked up
    // by id, tenant-scoped, so nothing from another tenant can appear here.
    const leadIds = [...new Set(prospects.map((p) => p.lead_id).filter(Boolean))];
    const seqIds = [...new Set(prospects.map((p) => p.sequence_id).filter(Boolean))];

    const [leadsRes, seqRes] = await Promise.all([
      leadIds.length
        ? db.from('leads').select('id, company_name, industry, hq_state, lead_score, status, email')
            .eq('tenant_id', FGA_TENANT_ID).in('id', leadIds)
        : Promise.resolve({ data: [] }),
      seqIds.length
        ? db.from('outreach_sequences')
            .select('id, message_subject, message_body, sequence_status, created_at')
            .eq('tenant_id', FGA_TENANT_ID).in('id', seqIds)
        : Promise.resolve({ data: [] }),
    ]);
    const leadById = new Map((leadsRes.data || []).map((l) => [l.id, l]));
    const seqById = new Map((seqRes.data || []).map((sq) => [sq.id, sq]));

    const sends = prospects.map((p) => {
      const lead = leadById.get(p.lead_id) || null;
      const seq = p.sequence_id ? seqById.get(p.sequence_id) : null;
      return {
        lead_id: p.lead_id,
        sequence_id: p.sequence_id || null,
        company: lead?.company_name || null,
        industry: lead?.industry || null,
        state: lead?.hq_state || null,
        lead_score: lead?.lead_score ?? null,
        lead_status: lead?.status || null,
        recipient: p.recipient || lead?.email || null,
        sent_at: p.sent_at,
        provider_id: p.provider_id || null,
        subject: seq?.message_subject || null,
        body: seq?.message_body || null,
        // Says plainly when the draft row is gone rather than rendering blank.
        body_available: Boolean(seq?.message_body),
      };
    }).sort((a, b) => String(b.sent_at).localeCompare(String(a.sent_at)));

    res.json({ success: true, date: etDate, count: sends.length, sends });
  } catch (err) {
    log.error(`revenue-outcome/sends failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
