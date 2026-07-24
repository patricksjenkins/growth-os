/**
 * Review Queue — approve held outreach drafts without hunting for them.
 *
 * Built 2026-07-24. The dashboard alert "7 outreach drafts need manual
 * review" linked to the Growth Engine page and stopped there; the only way
 * to actually approve was Pipeline -> find the lead -> open detail -> approve,
 * 96 drafts deep. This route serves the drafts themselves and approves them
 * in place, one or many at a time.
 *
 * SCOPE: FGA internal only. Every read/write goes through the shared
 * review-queue predicate, which is FGA-pinned.
 *
 * SENDING: approve delegates to sendEmailOutreachSequence — the same choke
 * point the autonomous sender, the bulk sender and the lead-detail approve
 * button use, including its atomic draft->sending claim. That claim is what
 * makes double-clicking Approve (or two tabs racing) safe: exactly one caller
 * wins and the rest get 'already_processed'.
 */

const express = require('express');
const router = express.Router();
const { getServiceClient } = require('../../db/client');
const { createLogger } = require('../../core/logger');
const { FGA_TENANT_ID } = require('../../core/config');
const { listReviewableDrafts } = require('../../core/growth/review-queue');
const { sendEmailOutreachSequence } = require('../../core/outreach-send');

const log = createLogger('admin-review-queue');

// Ceiling on one approve request. Approving is a real outbound send to a
// real person, so a fat-fingered "select all" on a 96-draft backlog must not
// become 96 emails in one keystroke. The UI chunks larger selections and
// shows progress; this is the server-side backstop.
const MAX_BULK = 25;
const SEND_DELAY_MS = 250;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Sends already made today — context for how much more to approve. */
async function sentToday(db) {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const { count } = await db
    .from('activity_log')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', FGA_TENANT_ID)
    .eq('action', 'outreach_sent')
    .gte('created_at', start.toISOString())
    .then((r) => r, () => ({ count: 0 }));
  return count || 0;
}

// ---------------------------------------------------------------------------
// GET /api/admin/review-queue — every draft waiting on Patrick
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const db = getServiceClient();
    const items = await listReviewableDrafts(db);
    const byReason = {};
    for (const it of items) byReason[it.hold_reason] = (byReason[it.hold_reason] || 0) + 1;
    res.json({
      success: true,
      total: items.length,
      sent_today: await sentToday(db),
      max_bulk: MAX_BULK,
      by_reason: byReason,
      items,
    });
  } catch (err) {
    log.error(`review-queue list failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/admin/review-queue/approve — approve & send, one or many
//
// Body: { items: [{ sequence_id, lead_id }, ...] }  (max MAX_BULK)
// Returns per-item results so a partial failure is visible, not swallowed.
// ---------------------------------------------------------------------------
router.post('/approve', async (req, res) => {
  try {
    const db = getServiceClient();
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (items.length === 0) {
      return res.status(400).json({ success: false, error: 'No drafts selected' });
    }
    if (items.length > MAX_BULK) {
      return res.status(400).json({
        success: false,
        error: `Too many at once — approve up to ${MAX_BULK} per request`,
      });
    }

    // Only drafts that are genuinely in the queue may be approved from here.
    // Without this, a stale or hand-crafted sequence_id could send an email
    // this screen never showed anyone.
    const queue = await listReviewableDrafts(db);
    const allowed = new Map(queue.map((q) => [q.sequence_id, q]));

    const results = [];
    for (const raw of items) {
      const sequenceId = String(raw?.sequence_id || '');
      const queued = allowed.get(sequenceId);
      if (!queued) {
        results.push({ sequence_id: sequenceId, ok: false, code: 'not_in_queue', error: 'Draft is no longer in the review queue' });
        continue;
      }
      const result = await sendEmailOutreachSequence(db, queued.lead_id, sequenceId, { sentVia: 'review_queue' });
      results.push({
        sequence_id: sequenceId,
        lead_id: queued.lead_id,
        company: queued.company,
        ok: Boolean(result.ok),
        code: result.code || null,
        error: result.error || null,
        recipient: result.recipient || queued.recipient || null,
      });
      if (result.ok) {
        log.success(`Approved from review queue -> ${result.recipient} (${queued.company})`);
        await sleep(SEND_DELAY_MS);
      } else {
        log.warn(`Review-queue approve failed for ${queued.company}: ${result.code} — ${result.error}`);
      }
    }

    const sent = results.filter((r) => r.ok).length;
    res.json({ success: true, sent, failed: results.length - sent, results });
  } catch (err) {
    log.error(`review-queue approve failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/admin/review-queue/reject — discard drafts
//
// Body: { items: [{ sequence_id, lead_id }, ...], reason?: string }
// Marks each draft rejected and drops the lead back to 'enriched' so the
// next outreach run writes a fresh draft. No Claude call is queued here —
// the scheduled run picks these up on its own (bulk-queuing regenerations
// would spend real tokens on a keystroke).
// ---------------------------------------------------------------------------
router.post('/reject', async (req, res) => {
  try {
    const db = getServiceClient();
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const reason = String(req.body?.reason || '').trim() || null;
    if (items.length === 0) {
      return res.status(400).json({ success: false, error: 'No drafts selected' });
    }
    if (items.length > MAX_BULK) {
      return res.status(400).json({ success: false, error: `Reject up to ${MAX_BULK} per request` });
    }

    const queue = await listReviewableDrafts(db);
    const allowed = new Map(queue.map((q) => [q.sequence_id, q]));

    const results = [];
    for (const raw of items) {
      const sequenceId = String(raw?.sequence_id || '');
      const queued = allowed.get(sequenceId);
      if (!queued) {
        results.push({ sequence_id: sequenceId, ok: false, error: 'Not in the review queue' });
        continue;
      }
      await db.from('outreach_sequences')
        .update({ sequence_status: 'rejected' })
        .eq('id', sequenceId)
        .eq('tenant_id', FGA_TENANT_ID);
      await db.from('conversations')
        .update({ metadata: { draft_status: 'rejected', rejected_at: new Date().toISOString(), reject_reason: reason } })
        .eq('tenant_id', FGA_TENANT_ID)
        .eq('sequence_id', sequenceId);
      await db.from('leads')
        .update({ lifecycle_stage: 'enriched' })
        .eq('id', queued.lead_id)
        .eq('tenant_id', FGA_TENANT_ID);
      results.push({ sequence_id: sequenceId, lead_id: queued.lead_id, company: queued.company, ok: true });
    }

    const rejected = results.filter((r) => r.ok).length;
    log.info(`Review queue: ${rejected} draft(s) rejected${reason ? ` — ${reason}` : ''}`);
    res.json({ success: true, rejected, results });
  } catch (err) {
    log.error(`review-queue reject failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
