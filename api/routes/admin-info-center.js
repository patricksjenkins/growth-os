/**
 * Information Center — the ONE approved cross-tenant surface (2026-07-22,
 * Patrick's Command Center purpose directive).
 *
 * The FGA Command Center runs FGA's business; client tenants' operations live
 * in their own Command Centers. This administration endpoint provides the
 * approved cross-tenant SUMMARY: tenant health, platform alerts, support
 * status, deliverability, and activity COUNTS.
 *
 * Privacy rules, enforced structurally:
 *  - No message bodies, no customer names, no lead names — counts, statuses,
 *    and tenant-level facts only. Nothing here selects a content column.
 *  - Every row carries its tenant id + name.
 *  - Every query is explicitly tenant-scoped (client tenants only — never
 *    FGA's own operations, never demo tenants) and explicitly limited
 *    (PostgREST silently caps unbounded selects; see the 2026-07-22
 *    dashboard reconciliation).
 *  - Mounted behind authMiddleware + adminMiddleware — FGA administrators
 *    only. Drilldowns link to tenant-labeled admin views.
 */

const express = require('express');
const router = express.Router();
const { getServiceClient, fetchAllRows } = require('../../db/client');
const { createLogger } = require('../../core/logger');
const { FGA_TENANT_ID } = require('../../core/config');
const { isBillingActive } = require('../../core/revenue');

const log = createLogger('admin-info-center');

const DAY_MS = 86400000;

router.get('/', async (_req, res) => {
  try {
    const db = getServiceClient();
    const now = Date.now();
    const since30d = new Date(now - 30 * DAY_MS).toISOString();
    const since24h = new Date(now - DAY_MS).toISOString();

    // Client tenants only: never FGA, never demos. This is the explicit
    // scope — there is no fallback to "all".
    const { data: allTenants, error: tErr } = await db
      .from('tenants')
      .select('id, name, slug, status, vertical, is_demo, created_at');
    if (tErr) throw tErr;
    const clients = (allTenants || []).filter((t) => !t.is_demo && t.id !== FGA_TENANT_ID);
    const clientIds = clients.map((t) => t.id);
    if (!clientIds.length) {
      return res.json({ success: true, tenants: [], platform: { incidents: [], deliverability_warnings: [] } });
    }

    // Config for tier/billing/email-identity per tenant.
    const { data: cfgRows } = await db
      .from('tenant_config')
      .select('tenant_id, key, value')
      .in('tenant_id', clientIds)
      .in('key', [
        'tier', 'monthly_rate', 'is_complimentary', 'billing_active',
        'subscription_status', 'trial_ends_at', 'churned_at',
        'onboarding_completed_at', 'go_live_at', 'payment_failed_at',
        'resend_domain_status', 'resend_domain_name', 'telnyx_phone_number',
      ])
      .limit(2000);
    const cfg = {};
    for (const r of cfgRows || []) {
      cfg[r.tenant_id] = cfg[r.tenant_id] || {};
      let v = r.value;
      if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) { /* raw string */ } }
      cfg[r.tenant_id][r.key] = v;
    }

    /*
     * Bounded 30d activity pulls — COUNT-safe columns only. No bodies, no names.
     *
     * PAGED. `.limit(10000)` does not do what it looks like: PostgREST caps a
     * response at 1000 rows and reports nothing. agent_jobs alone had 6163
     * rows across client tenants in this window (2026-08-10), so the per-client
     * activity counts on this page were reading about a sixth of reality and
     * presenting it as the total. Same defect that had the Operations Guardian
     * paging Patrick about two healthy agents — see db/client.js fetchAllRows.
     */
    const paged = (build, cap = 50000) => fetchAllRows(
      (from, to) => build().range(from, to), { cap },
    );
    const [leadsRes, convRes, jobsRes, voiceRes, supportRes, incidentsRes] = await Promise.all([
      paged(() => db.from('leads').select('tenant_id, created_at').in('tenant_id', clientIds)
        .gte('created_at', since30d).order('created_at', { ascending: false })),
      paged(() => db.from('conversations').select('tenant_id, channel, direction, created_at')
        .in('tenant_id', clientIds)
        .gte('created_at', since30d).order('created_at', { ascending: false })),
      paged(() => db.from('agent_jobs').select('tenant_id, status, created_at').in('tenant_id', clientIds)
        .gte('created_at', since30d).order('created_at', { ascending: false })),
      paged(() => db.from('voice_calls').select('tenant_id, created_at').in('tenant_id', clientIds)
        .gte('created_at', since30d).order('created_at', { ascending: false }))
        .then((r) => r, () => ({ data: [] })),
      db.from('support_threads').select('tenant_id, status').in('tenant_id', clientIds)
        .in('status', ['open', 'pending']).limit(1000)
        .then((r) => r, () => ({ data: [] })),
      db.from('ops_incidents')
        .select('agent_name, issue_type, severity, status, detected_at, tenant_id')
        .in('status', ['open', 'remediating', 'awaiting_approval', 'escalated'])
        .order('detected_at', { ascending: false }).limit(25)
        .then((r) => r, () => ({ data: [] })),
    ]);

    const byTenant = (rows) => {
      const m = {};
      for (const r of rows || []) m[r.tenant_id] = (m[r.tenant_id] || []).concat([r]);
      return m;
    };
    const leadsBy = byTenant(leadsRes.data);
    const convBy = byTenant(convRes.data);
    const jobsBy = byTenant(jobsRes.data);
    const voiceBy = byTenant(voiceRes.data);
    const supportBy = byTenant(supportRes.data);

    const tenants = clients.map((t) => {
      const c = cfg[t.id] || {};
      const conv = convBy[t.id] || [];
      const jobs = jobsBy[t.id] || [];
      const lastActivity = [
        ...(leadsBy[t.id] || []).map((r) => r.created_at),
        ...conv.map((r) => r.created_at),
        ...jobs.map((r) => r.created_at),
      ].sort().reverse()[0] || null;
      let health = 'red';
      if (t.status === 'active' && lastActivity) {
        const days = (now - new Date(lastActivity).getTime()) / DAY_MS;
        if (days <= 7) health = 'green';
        else if (days <= 21) health = 'yellow';
      } else if (t.status !== 'active') {
        health = 'onboarding';
      }
      const failed24h = jobs.filter((j) => j.status === 'failed' && j.created_at >= since24h).length;
      const emailIdentity = c.resend_domain_status || 'not_provisioned';
      const issues = [];
      if (c.payment_failed_at) issues.push('payment_failed');
      if (failed24h > 0) issues.push(`${failed24h}_failed_jobs_24h`);
      if (emailIdentity !== 'verified' && emailIdentity !== 'not_provisioned') issues.push('email_identity_unverified');
      if ((supportBy[t.id] || []).length > 0) issues.push('open_support');

      return {
        tenant_id: t.id,
        tenant_name: t.name,
        slug: t.slug,
        vertical: t.vertical,
        status: t.status,
        tier: c.tier || 'growth',
        billing_active: isBillingActive({
          isComplimentary: c.is_complimentary === 'true' || c.is_complimentary === true,
          monthlyRate: Number(c.monthly_rate || 0) || (c.tier === 'scale' ? 399 : 249),
          churnedAt: c.churned_at || null,
          subscriptionStatus: c.subscription_status || null,
          billingActiveFlag: c.billing_active === 'true' || c.billing_active === true,
          trialEndsAt: c.trial_ends_at || null,
          status: t.status,
        }, now),
        in_onboarding: t.status !== 'active' || !(c.onboarding_completed_at || c.go_live_at),
        health,
        last_activity: lastActivity,
        email_identity: emailIdentity,
        has_phone_number: Boolean(c.telnyx_phone_number),
        open_support: (supportBy[t.id] || []).length,
        issues,
        counts_30d: {
          leads: (leadsBy[t.id] || []).length,
          inbound_messages: conv.filter((r) => r.direction === 'inbound').length,
          outbound_messages: conv.filter((r) => r.direction === 'outbound').length,
          web_chats: conv.filter((r) => r.channel === 'web_chat' && r.direction === 'inbound').length,
          voice_calls: (voiceBy[t.id] || []).length,
          agent_runs: jobs.length,
          failed_jobs: jobs.filter((j) => j.status === 'failed').length,
        },
      };
    });

    const tenantNameById = Object.fromEntries(clients.map((t) => [t.id, t.name]));
    const platform = {
      incidents: (incidentsRes.data || []).map((i) => ({
        agent: i.agent_name,
        issue: i.issue_type,
        severity: i.severity,
        status: i.status,
        detected_at: i.detected_at,
        tenant_name: i.tenant_id ? (tenantNameById[i.tenant_id] || (i.tenant_id === FGA_TENANT_ID ? 'FGA' : 'unknown')) : 'platform',
      })),
      deliverability_warnings: tenants
        .filter((t) => t.issues.includes('email_identity_unverified'))
        .map((t) => ({ tenant_id: t.tenant_id, tenant_name: t.tenant_name, email_identity: t.email_identity })),
    };

    res.json({ success: true, tenants, platform });
  } catch (err) {
    log.error(`info-center failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
