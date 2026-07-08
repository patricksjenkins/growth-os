/**
 * Admin — Autonomous Outreach status + controls (2026-07-03)
 *
 * GET  /status   one consolidated payload for the Growth page panel:
 *                config, caps/ramp state, weekly target progress, queue
 *                counts, deliverability, decision log tail, go-live checklist
 * POST /pause    flip the emergency kill switch (autosend_paused)
 * POST /resume   clear it
 * POST /enable   arm autonomous mode (autonomous_outreach_enabled=true)
 * POST /disable  disarm it
 *
 * Mounted at /api/admin/autosend behind auth+admin middleware.
 */

const express = require('express');
const { createLogger } = require('../../core/logger');
const { getServiceClient } = require('../../db/client');
const { FGA_TENANT_ID } = require('../../core/config');
const { resolveTenant, clearTenantCache } = require('../../core/tenant');
const { autosendConfig, computeCapState, isoWeekStartIso } = require('../../core/auto-outreach');

const router = express.Router();
const log = createLogger('admin-autosend');

async function setFlag(key, value) {
  const db = getServiceClient();
  await db.from('tenant_config').upsert(
    { tenant_id: FGA_TENANT_ID, key, value: String(value) },
    { onConflict: 'tenant_id,key' },
  );
  try { clearTenantCache(FGA_TENANT_ID); } catch (_) { /* cache helper optional */ }
}

router.get('/status', async (req, res) => {
  try {
    const db = getServiceClient();
    const tenant = await resolveTenant(db, FGA_TENANT_ID);
    const cfgv = autosendConfig(tenant);
    const capState = await computeCapState(db, tenant);
    const weekStart = isoWeekStartIso();

    const [draftsRes, reviewRes, blockedRes, autoSentWeekRes, enrolledWeekRes, repliesWeekRes, decisionsRes] = await Promise.all([
      db.from('outreach_sequences').select('id', { count: 'exact', head: true })
        .eq('tenant_id', FGA_TENANT_ID).eq('sequence_type', 'email').eq('sequence_status', 'draft'),
      db.from('leads').select('id', { count: 'exact', head: true })
        .eq('tenant_id', FGA_TENANT_ID).eq('automation_status', 'needs_review'),
      db.from('leads').select('id', { count: 'exact', head: true })
        .eq('tenant_id', FGA_TENANT_ID).in('automation_status', ['blocked_suppressed', 'blocked_duplicate', 'blocked_no_email']),
      db.from('autosend_decisions').select('id', { count: 'exact', head: true })
        .eq('tenant_id', FGA_TENANT_ID).eq('decision', 'sent').gte('created_at', weekStart),
      db.from('drip_enrollments').select('id', { count: 'exact', head: true })
        .eq('tenant_id', FGA_TENANT_ID).gte('created_at', weekStart),
      db.from('leads').select('id', { count: 'exact', head: true })
        .eq('tenant_id', FGA_TENANT_ID).eq('status', 'replied').gte('updated_at', weekStart),
      db.from('autosend_decisions').select('id, lead_id, decision, reason, created_at, quality')
        .eq('tenant_id', FGA_TENANT_ID).order('created_at', { ascending: false }).limit(25),
    ]);

    // Go-live checklist. Split by what the code actually enforces:
    //  - REQUIRED: the auto-send gate hard-refuses without a postal address.
    //  - RECOMMENDED: safety + deliverability prerequisites (not code-gated,
    //    but you shouldn't ramp volume without them). Each item reflects LIVE
    //    state, so it flips green on its own as pieces come online.
    // NOT .maybeSingle(): it throws on 2+ rows, and a second mailbox can be
    // connected for invoice scanning. That would 500 this whole endpoint and
    // blank the Growth Engine page. Take the primary inbox.
    const { data: gmailConns } = await db.from('email_connections')
      .select('email_address, updated_at').eq('tenant_id', FGA_TENANT_ID).eq('provider', 'gmail')
      .order('is_primary', { ascending: false }).order('created_at', { ascending: true }).limit(1);
    const gmailConn = (gmailConns && gmailConns[0]) || null;
    let dnsRecords = (() => {
      try { const raw = tenant.config?.outreach_domain_dns; return raw ? JSON.parse(raw) : []; } catch { return []; }
    })();
    let domainStatus = tenant.config?.outreach_domain_status || (dnsRecords.length ? 'verifying' : 'not_started');

    // The stored status is a guess written once at provisioning time. While it
    // is not 'verified', ask Resend for the truth (and nudge a DNS re-check).
    // Once verified we stop calling out — no per-pageload API hit forever.
    if (domainStatus !== 'verified') {
      const { reconcileOutreachDomain } = require('../../core/resend-domain');
      const rec = await reconcileOutreachDomain(db, FGA_TENANT_ID);
      if (rec.ok) {
        domainStatus = rec.status;
        if (rec.records?.length) dnsRecords = rec.records;
      }
    }
    const fromEmail = tenant.config?.autosend_from_email || null;
    const checklist = {
      required: [
        { key: 'postal_address', label: 'Postal address on file (required by law for cold email)', ok: Boolean(cfgv.postalAddress) },
      ],
      recommended: [
        { key: 'reply_sync', label: 'Reply detection connected (stops outreach the moment someone replies)', ok: Boolean(gmailConn) },
        { key: 'drip', label: 'Follow-up sequence enabled', ok: String(tenant.config?.drip_campaign_enabled) === 'true' },
        { key: 'bounce_webhook', label: 'Bounce and spam-complaint tracking active', ok: String(tenant.config?.resend_webhook_active) === 'true' },
        {
          // Two distinct facts, previously conflated into one amber row that
          // could never go green: the domain being verified, and cold email
          // actually being SENT from it.
          key: 'sending_domain',
          label: 'Dedicated sending domain verified',
          ok: domainStatus === 'verified',
          detail: domainStatus === 'verified'
            ? `${tenant.config?.outreach_domain_name || 'subdomain'} verified with Resend`
            : (dnsRecords.length ? 'DNS added, waiting on verification' : 'not started'),
        },
        {
          key: 'sending_domain_active',
          label: 'Cold email sends from the dedicated domain',
          ok: Boolean(fromEmail),
          optional: true,
          detail: fromEmail
            ? `sending as ${fromEmail} (replies still go to patrick@firstgenautomate.com)`
            : (domainStatus === 'verified'
              ? 'verified and ready — sender not switched yet, so cold email still goes out on the main domain'
              : 'available once the domain verifies'),
        },
        { key: 'webhook_signature', label: 'Signed webhook verification (extra hardening, optional)', ok: Boolean(process.env.RESEND_WEBHOOK_SECRET), optional: true },
      ],
      sending_domain: {
        name: tenant.config?.outreach_domain_name || null,
        from_email: fromEmail,
        status: domainStatus,
        dns_records: dnsRecords,
      },
    };

    res.json({
      success: true,
      data: {
      config: {
        enabled: cfgv.enabled,
        paused: cfgv.paused,
        daily_cap: cfgv.dailyCap,
        daily_max: cfgv.dailyMax,
        weekly_target: cfgv.weeklyTarget,
        score_threshold: cfgv.scoreThreshold,
        quality_threshold: cfgv.qualityThreshold,
      },
      week: {
        auto_sent: autoSentWeekRes.count || 0,
        target: cfgv.weeklyTarget,
        enrolled_in_drip: enrolledWeekRes.count || 0,
        replies: repliesWeekRes.count || 0,
      },
      today: {
        sent: capState.sentToday,
        cap: capState.dailyCap,
        remaining: capState.dailyRemaining,
      },
      queue: {
        drafts_ready: draftsRes.count || 0,
        needs_review: reviewRes.count || 0,
        blocked: blockedRes.count || 0,
      },
      deliverability: {
        paused: capState.deliverabilityPaused,
        bounce_rate_7d: capState.bounceRate7d,
        complaints_7d: capState.complaints7d,
        sent_7d: capState.sent7d,
      },
      checklist,
      recent_decisions: decisionsRes.data || [],
      },
    });
  } catch (err) {
    log.error(`/status failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/pause', async (_req, res) => {
  await setFlag('autosend_paused', 'true');
  res.json({ success: true, paused: true });
});
router.post('/resume', async (_req, res) => {
  await setFlag('autosend_paused', 'false');
  res.json({ success: true, paused: false });
});
router.post('/enable', async (_req, res) => {
  await setFlag('autonomous_outreach_enabled', 'true');
  res.json({ success: true, enabled: true });
});
router.post('/disable', async (_req, res) => {
  await setFlag('autonomous_outreach_enabled', 'false');
  res.json({ success: true, enabled: false });
});

/**
 * POST /api/admin/autosend/verify-domain — force a Resend DNS re-check.
 *
 * Read-only against the world: it asks Resend to re-evaluate the DNS records
 * and persists whatever Resend reports. It does NOT change the sending
 * identity (see autosend_from_email).
 */
router.post('/verify-domain', async (_req, res) => {
  try {
    const db = getServiceClient();
    const { reconcileOutreachDomain } = require('../../core/resend-domain');
    const result = await reconcileOutreachDomain(db, FGA_TENANT_ID);
    res.status(result.ok ? 200 : 502).json({ success: result.ok, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
