/**
 * First Gen Automate — Targeted Campaigns (admin-only routes)
 *
 * Mounted at /api/admin/targeted-campaigns behind authMiddleware +
 * adminMiddleware (platform-owner only — the only privileged role on this
 * platform; all permission enforcement is server-side here).
 *
 * Owner-defined targeted prospecting campaigns: 7-step wizard → strategy /
 * messaging review → pilot batch → explicit pilot approval → daily batches to
 * a hard goal. The agent is IDLE unless a campaign is executable; launches and
 * approvals here enqueue the agent job EVENT-DRIVEN (no polling).
 */

const express = require('express');
const router = express.Router();

const { getServiceClient } = require('../../db/client');
const { createLogger } = require('../../core/logger');
const { FGA_TENANT_ID } = require('../../core/config');
const { enqueueJob } = require('../../db/queries/jobs');
const tc = require('../../core/targeted-campaigns');

const log = createLogger('admin-targeted-campaigns');

function actorOf(req) {
  return req.user?.email || 'admin';
}

async function getCampaign(db, id) {
  const { data, error } = await db
    .from('targeted_campaigns').select('*')
    .eq('id', id).eq('tenant_id', FGA_TENANT_ID).maybeSingle();
  if (error) throw error;
  return data;
}

async function getGlobalKill(db) {
  const { data } = await db.from('tenant_config')
    .select('value').eq('tenant_id', FGA_TENANT_ID)
    .eq('key', tc.GLOBAL_KILL_KEY).maybeSingle();
  const v = data?.value;
  return v === true || v === 'true' || v === '"true"' || v === '1';
}

async function snapshotVersion(db, campaign, actor) {
  const version = (campaign.current_version || 1) + 1;
  await db.from('targeted_campaign_versions').insert({
    tenant_id: FGA_TENANT_ID,
    campaign_id: campaign.id,
    version,
    snapshot: {
      name: campaign.name,
      opportunity: campaign.opportunity,
      audience: campaign.audience,
      qualification: campaign.qualification,
      solution: campaign.solution,
      messaging: campaign.messaging,
      goal_qualified: campaign.goal_qualified,
      pilot_size: campaign.pilot_size,
      daily_batch_cap: campaign.daily_batch_cap,
      budget: campaign.budget,
    },
    created_by: actor,
  });
  return version;
}

async function enqueueCampaignRun(campaignId) {
  await enqueueJob(FGA_TENANT_ID, 'targeted-campaign', { campaign_id: campaignId });
}

// ───────────────────────────────────────────────────────────────────────
// GET / — campaign list + cross-campaign dashboard summary + global kill
// ───────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const db = getServiceClient();
    const [{ data: campaigns, error }, globalKill, { data: recs }] = await Promise.all([
      db.from('targeted_campaigns').select('*')
        .eq('tenant_id', FGA_TENANT_ID).order('created_at', { ascending: false }),
      getGlobalKill(db),
      db.from('targeted_campaign_recommendations').select('*')
        .eq('tenant_id', FGA_TENANT_ID).eq('status', 'proposed')
        .order('created_at', { ascending: false }).limit(10),
    ]);
    if (error) throw error;

    const list = campaigns || [];
    const active = list.filter((c) => tc.isExecutable(c.status));
    const summary = {
      total: list.length,
      executable: active.length,
      pilots_awaiting_approval: list.filter((c) => c.status === 'pilot_awaiting_approval').length,
      blocked_by_limits: list.filter((c) => ['budget_limit_reached', 'api_limit_reached', 'audience_exhausted'].includes(c.status)).length,
      total_qualified: list.reduce((s, c) => s + (c.qualified_count || 0), 0),
      total_email_ready: list.reduce((s, c) => s + (c.outreach_ready_email_count || 0), 0),
      total_fb_dm_ready: list.reduce((s, c) => s + (c.fb_dm_ready_count || 0), 0),
      total_serper_calls: list.reduce((s, c) => s + (c.serper_calls_used || 0), 0),
      total_ai_calls: list.reduce((s, c) => s + (c.ai_calls_used || 0), 0),
      total_apify_calls: list.reduce((s, c) => s + (c.apify_calls_used || 0), 0),
      estimated_cost_usd: Math.round(list.reduce((s, c) => s + tc.estimateCost(c), 0) * 100) / 100,
      agent_idle: active.length === 0,
    };
    res.json({
      success: true,
      data: {
        campaigns: list.map((c) => ({ ...c, status_label: tc.STATUS_LABELS[c.status] || c.status })),
        summary,
        global_kill: globalKill,
        statuses: tc.STATUS_LABELS,
        recommendations: recs || [],
      },
    });
  } catch (err) {
    log.error(`list failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ───────────────────────────────────────────────────────────────────────
// POST / — create a draft campaign (wizard step 1 save)
// ───────────────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const db = getServiceClient();
    const b = req.body || {};
    const draft = {
      tenant_id: FGA_TENANT_ID,
      name: String(b.name || '').trim(),
      status: 'draft',
      opportunity: b.opportunity || {},
      audience: b.audience || {},
      qualification: b.qualification || {},
      solution: b.solution || {},
      messaging: b.messaging || {},
      goal_qualified: Number(b.goal_qualified) || 100,
      pilot_size: Number(b.pilot_size) || 10,
      daily_batch_cap: Math.min(Number(b.daily_batch_cap) || 25, 25),
      budget: b.budget || {},
      created_by: actorOf(req),
    };
    const check = tc.validateCampaignConfig(draft);
    if (!check.valid) return res.status(400).json({ success: false, error: check.errors.join('; ') });

    const { data, error } = await db.from('targeted_campaigns').insert(draft).select().single();
    if (error) throw error;
    await db.from('targeted_campaign_versions').insert({
      tenant_id: FGA_TENANT_ID, campaign_id: data.id, version: 1,
      snapshot: draft, created_by: actorOf(req),
    });
    await tc.logCampaignActivity(FGA_TENANT_ID, data.id, actorOf(req), 'created', { name: data.name });
    res.json({ success: true, data });
  } catch (err) {
    log.error(`create failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ───────────────────────────────────────────────────────────────────────
// Global kill switch (targeted campaigns ONLY — never the standard agent)
// ───────────────────────────────────────────────────────────────────────
router.post('/kill-switch', async (req, res) => {
  try {
    const db = getServiceClient();
    const enabled = req.body?.enabled === true;
    await db.from('tenant_config').upsert(
      [{ tenant_id: FGA_TENANT_ID, key: tc.GLOBAL_KILL_KEY, value: enabled ? 'true' : 'false' }],
      { onConflict: 'tenant_id,key' },
    );
    log.warn(`Global targeted-campaign kill switch ${enabled ? 'ENABLED' : 'disabled'} by ${actorOf(req)}`);
    res.json({ success: true, data: { global_kill: enabled } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ───────────────────────────────────────────────────────────────────────
// FB DM manual queue (cross-campaign) — deliberately a QUEUE page, not an
// attention alarm (Patrick: FB DMs are a manual backup, never auto-sent).
// ───────────────────────────────────────────────────────────────────────
router.get('/fb-dm-queue', async (req, res) => {
  try {
    const db = getServiceClient();
    const { data: seqs, error } = await db
      .from('outreach_sequences')
      .select('id, lead_id, sequence_name, message_body, sequence_status, metadata, created_at')
      .eq('tenant_id', FGA_TENANT_ID)
      .eq('sequence_type', 'facebook_dm')
      .eq('sequence_status', 'draft')
      .not('metadata->>campaign_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw error;
    const leadIds = [...new Set((seqs || []).map((s) => s.lead_id))];
    let leadsById = {};
    if (leadIds.length) {
      const { data: leads } = await db.from('leads')
        .select('id, company_name, industry, city, hq_state, metadata')
        .in('id', leadIds);
      leadsById = Object.fromEntries((leads || []).map((l) => [l.id, l]));
    }
    res.json({
      success: true,
      data: (seqs || []).map((s) => ({
        ...s,
        lead: leadsById[s.lead_id] || null,
        facebook_url: leadsById[s.lead_id]?.metadata?.facebook_url || null,
      })),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ───────────────────────────────────────────────────────────────────────
// Recommendations (proposed by agents/owner — NEVER auto-executed)
// ───────────────────────────────────────────────────────────────────────
router.post('/recommendations/:id/decide', async (req, res) => {
  try {
    const db = getServiceClient();
    const decision = req.body?.decision === 'accepted' ? 'accepted' : 'dismissed';
    const { data: rec, error } = await db.from('targeted_campaign_recommendations')
      .update({ status: decision, decided_at: new Date().toISOString() })
      .eq('id', req.params.id).eq('tenant_id', FGA_TENANT_ID).eq('status', 'proposed')
      .select().maybeSingle();
    if (error) throw error;
    if (!rec) return res.status(404).json({ success: false, error: 'recommendation not found or already decided' });

    let campaign = null;
    if (decision === 'accepted') {
      const cfg = rec.suggested_config || {};
      const { data: created, error: cErr } = await db.from('targeted_campaigns').insert({
        tenant_id: FGA_TENANT_ID,
        name: cfg.name || rec.title,
        status: 'draft',
        opportunity: cfg.opportunity || { description: rec.rationale || rec.title },
        audience: cfg.audience || {},
        qualification: cfg.qualification || {},
        solution: cfg.solution || {},
        messaging: cfg.messaging || {},
        goal_qualified: Number(cfg.goal_qualified) || 100,
        pilot_size: Number(cfg.pilot_size) || 10,
        daily_batch_cap: Math.min(Number(cfg.daily_batch_cap) || 25, 25),
        budget: cfg.budget || {},
        created_by: actorOf(req),
      }).select().single();
      if (cErr) throw cErr;
      campaign = created;
      await db.from('targeted_campaign_recommendations')
        .update({ campaign_id: created.id }).eq('id', rec.id);
      await tc.logCampaignActivity(FGA_TENANT_ID, created.id, actorOf(req), 'created_from_recommendation', { recommendation_id: rec.id });
    }
    res.json({ success: true, data: { recommendation: rec, campaign } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ───────────────────────────────────────────────────────────────────────
// GET /:id — full campaign detail (campaign + variants + recent batches)
// ───────────────────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const db = getServiceClient();
    const campaign = await getCampaign(db, req.params.id);
    if (!campaign) return res.status(404).json({ success: false, error: 'campaign not found' });
    const [{ data: variants }, { data: batches }, { data: approvals }] = await Promise.all([
      db.from('targeted_campaign_variants').select('*')
        .eq('campaign_id', campaign.id).order('label'),
      db.from('targeted_campaign_batches').select('*')
        .eq('campaign_id', campaign.id).order('batch_number', { ascending: false }).limit(50),
      db.from('targeted_campaign_approvals').select('*')
        .eq('campaign_id', campaign.id).order('created_at', { ascending: false }).limit(50),
    ]);
    res.json({
      success: true,
      data: {
        campaign: { ...campaign, status_label: tc.STATUS_LABELS[campaign.status] || campaign.status },
        variants: variants || [],
        batches: batches || [],
        approvals: approvals || [],
        estimated_cost_usd: Math.round(tc.estimateCost(campaign) * 100) / 100,
        allowed_transitions: tc.ALLOWED_TRANSITIONS[campaign.status] || [],
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ───────────────────────────────────────────────────────────────────────
// PUT /:id — update config (only while draft / review states); bumps version
// ───────────────────────────────────────────────────────────────────────
const EDITABLE_STATUSES = ['draft', 'strategy_review', 'messaging_review', 'paused', 'audience_exhausted', 'budget_limit_reached', 'api_limit_reached'];

router.put('/:id', async (req, res) => {
  try {
    const db = getServiceClient();
    const campaign = await getCampaign(db, req.params.id);
    if (!campaign) return res.status(404).json({ success: false, error: 'campaign not found' });
    if (!EDITABLE_STATUSES.includes(campaign.status)) {
      return res.status(400).json({ success: false, error: `campaign is not editable in status '${campaign.status}'` });
    }
    const b = req.body || {};
    const updates = {};
    for (const k of ['name', 'opportunity', 'audience', 'qualification', 'solution', 'messaging', 'budget']) {
      if (b[k] !== undefined) updates[k] = b[k];
    }
    for (const k of ['goal_qualified', 'pilot_size', 'daily_batch_cap']) {
      if (b[k] !== undefined) updates[k] = Number(b[k]);
    }
    if (updates.daily_batch_cap != null) updates.daily_batch_cap = Math.min(updates.daily_batch_cap, 25);

    const merged = { ...campaign, ...updates };
    const check = tc.validateCampaignConfig(merged);
    if (!check.valid) return res.status(400).json({ success: false, error: check.errors.join('; ') });

    const newVersion = await snapshotVersion(db, merged, actorOf(req));
    const { data, error } = await db.from('targeted_campaigns')
      .update({ ...updates, current_version: newVersion, updated_at: new Date().toISOString() })
      .eq('id', campaign.id).eq('tenant_id', FGA_TENANT_ID).select().single();
    if (error) throw error;
    await tc.logCampaignActivity(FGA_TENANT_ID, campaign.id, actorOf(req), 'config_updated', { version: newVersion, fields: Object.keys(updates) });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ───────────────────────────────────────────────────────────────────────
// DELETE /:id — permanently delete a campaign and all its child records
// (variants, batches, runs, candidates, lead links, approvals, versions,
// activity, usage all cascade via FK). Leads already created in the
// pipeline are NOT deleted — only their campaign link rows. Blocked while
// the campaign is executable: kill/cancel it first.
// ───────────────────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const db = getServiceClient();
    const campaign = await getCampaign(db, req.params.id);
    if (!campaign) return res.status(404).json({ success: false, error: 'campaign not found' });
    if (tc.isExecutable(campaign.status)) {
      return res.status(400).json({ success: false, error: `campaign is '${campaign.status}' — kill or cancel it before deleting` });
    }
    const { error } = await db.from('targeted_campaigns')
      .delete().eq('id', campaign.id).eq('tenant_id', FGA_TENANT_ID);
    if (error) throw error;
    log.info(`campaign deleted: ${campaign.id} (${campaign.name}) by ${actorOf(req)}`);
    res.json({ success: true, data: { id: campaign.id, deleted: true } });
  } catch (err) {
    log.error(`delete failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ───────────────────────────────────────────────────────────────────────
// Variants (messaging step) — upsert A/B/C; AI-assisted generation is ONE
// owner-triggered Claude call (zero AI calls per lead at send time).
// ───────────────────────────────────────────────────────────────────────
router.post('/:id/variants', async (req, res) => {
  try {
    const db = getServiceClient();
    const campaign = await getCampaign(db, req.params.id);
    if (!campaign) return res.status(404).json({ success: false, error: 'campaign not found' });
    const variants = Array.isArray(req.body?.variants) ? req.body.variants : [];
    const saved = [];
    for (const v of variants) {
      const label = String(v.label || '').toUpperCase();
      if (!['A', 'B', 'C'].includes(label)) continue;
      const row = {
        tenant_id: FGA_TENANT_ID,
        campaign_id: campaign.id,
        label,
        email_subject: v.email_subject || null,
        email_body: v.email_body || null,
        fb_dm_body: v.fb_dm_body || null,
        follow_up_body: v.follow_up_body || null,
        status: v.status === 'approved' ? 'approved' : 'draft',
        updated_at: new Date().toISOString(),
      };
      const { data, error } = await db.from('targeted_campaign_variants')
        .upsert(row, { onConflict: 'campaign_id,label' }).select().single();
      if (error) throw error;
      saved.push(data);
    }
    await tc.logCampaignActivity(FGA_TENANT_ID, campaign.id, actorOf(req), 'variants_saved', { labels: saved.map((s) => s.label) });
    res.json({ success: true, data: saved });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/:id/variants/generate', async (req, res) => {
  try {
    const db = getServiceClient();
    const campaign = await getCampaign(db, req.params.id);
    if (!campaign) return res.status(404).json({ success: false, error: 'campaign not found' });

    const { askClaudeJSON } = require('../../integrations/claude');
    const aud = campaign.audience || {};
    const systemPrompt = `You write cold outreach message TEMPLATES for First Gen Automate (FGA), a fully managed automation service for very small businesses. Return ONLY valid JSON.
HARD RULES:
- Use {{first_name}}, {{company}}, {{city}}, {{industry}} placeholders.
- NEVER overpromise. FGA captures leads, texts back to acknowledge + collect info, follows up, asks for reviews, generates content. FGA does NOT see calendars/schedules/dispatch — never promise booking, scheduling, or dispatching.
- Never name specific FGA clients. Never invent metrics.
- FGA is DEPLOYED for the customer (never say "install").
- Plain, human, direct tone. Short. No hype, minimal jargon.`;
    const userPrompt = `Campaign: "${campaign.name}"
Opportunity: ${(campaign.opportunity || {}).description || ''}
Audience: ${(aud.industries || []).join(', ')} in ${(aud.states || []).join(', ')}, ${aud.employee_min || 1}-${aud.employee_max || 5} employees, website rule: ${aud.website_rule || 'no_website'}
FGA solution angle: ${((campaign.solution || {}).modules || []).join(', ')} — ${(campaign.solution || {}).pitch_angle || ''}
Messaging strategy: ${(campaign.messaging || {}).strategy || ''}

Write THREE distinct variants (A, B, C), each with:
- email_subject (under 60 chars)
- email_body (90-140 words, plain text, ends naturally — a signature is appended automatically, do NOT include one)
- fb_dm_body (40-80 words, casual, no links)
- follow_up_body (50-90 words, polite nudge referencing the first email)

Return JSON: { "variants": [ { "label": "A", "email_subject": "...", "email_body": "...", "fb_dm_body": "...", "follow_up_body": "..." }, ... ] }`;

    const result = await askClaudeJSON(systemPrompt, userPrompt, { maxTokens: 3000, tenantSlug: 'fga' });
    const variants = Array.isArray(result.variants) ? result.variants.slice(0, 3) : [];
    await tc.logCampaignActivity(FGA_TENANT_ID, campaign.id, actorOf(req), 'variants_generated', { count: variants.length });
    res.json({ success: true, data: variants });
  } catch (err) {
    log.error(`variant generation failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ───────────────────────────────────────────────────────────────────────
// Approvals + lifecycle transitions (explicit human gates)
// ───────────────────────────────────────────────────────────────────────
router.post('/:id/approve', async (req, res) => {
  try {
    const db = getServiceClient();
    const campaign = await getCampaign(db, req.params.id);
    if (!campaign) return res.status(404).json({ success: false, error: 'campaign not found' });
    const stage = req.body?.stage;
    const decision = req.body?.decision === 'rejected' ? 'rejected' : 'approved';
    const note = req.body?.note || null;
    if (!['strategy', 'messaging', 'launch_pilot', 'pilot_result', 'continue'].includes(stage)) {
      return res.status(400).json({ success: false, error: 'invalid stage' });
    }

    // Stage-specific gates BEFORE recording the approval.
    if (decision === 'approved') {
      if (stage === 'messaging' || stage === 'launch_pilot') {
        const cfgCheck = tc.validateCampaignConfig(campaign, { forLaunch: true });
        if (!cfgCheck.valid) return res.status(400).json({ success: false, error: cfgCheck.errors.join('; ') });
        const { data: variants } = await db.from('targeted_campaign_variants')
          .select('*').eq('campaign_id', campaign.id).eq('status', 'approved');
        const vCheck = tc.validateVariants(variants);
        if (!vCheck.valid) return res.status(400).json({ success: false, error: `approved variants invalid: ${vCheck.errors.join('; ')}` });
      }
      if ((stage === 'launch_pilot' || stage === 'continue') && await getGlobalKill(db)) {
        return res.status(400).json({ success: false, error: 'global targeted-campaign kill switch is ON — disable it first' });
      }
    }

    await db.from('targeted_campaign_approvals').insert({
      tenant_id: FGA_TENANT_ID, campaign_id: campaign.id,
      stage, decision, decided_by: actorOf(req), note,
    });

    // Transition map per (stage, decision).
    let transition = null;
    let enqueue = false;
    if (decision === 'approved') {
      if (stage === 'strategy' && campaign.status === 'strategy_review') transition = 'messaging_review';
      if (stage === 'messaging' && campaign.status === 'messaging_review') transition = 'ready_for_pilot';
      if (stage === 'launch_pilot' && campaign.status === 'ready_for_pilot') { enqueue = true; }
      if ((stage === 'pilot_result' || stage === 'continue') && campaign.status === 'pilot_awaiting_approval') {
        transition = 'approved_to_continue'; enqueue = true;
      }
    } else {
      if (stage === 'strategy' && campaign.status === 'strategy_review') transition = 'draft';
      if (stage === 'messaging' && campaign.status === 'messaging_review') transition = 'draft';
      if ((stage === 'pilot_result' || stage === 'continue') && campaign.status === 'pilot_awaiting_approval') transition = 'paused';
    }

    let updated = campaign;
    if (transition) {
      const r = await tc.transitionCampaign(campaign.id, campaign.status, transition, {
        actor: actorOf(req), detail: { stage, decision, note },
      });
      if (!r.success) return res.status(409).json({ success: false, error: r.error });
      updated = r.campaign;
    }
    if (enqueue) {
      // Event-driven launch — the agent runs from the job queue, no polling.
      await enqueueCampaignRun(campaign.id);
      await tc.logCampaignActivity(FGA_TENANT_ID, campaign.id, actorOf(req), 'run_enqueued', { stage });
    }
    res.json({ success: true, data: { campaign: updated, enqueued: enqueue } });
  } catch (err) {
    log.error(`approve failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/:id/transition', async (req, res) => {
  try {
    const db = getServiceClient();
    const campaign = await getCampaign(db, req.params.id);
    if (!campaign) return res.status(404).json({ success: false, error: 'campaign not found' });
    const to = req.body?.to;
    if (!tc.STATUSES.includes(to)) return res.status(400).json({ success: false, error: 'invalid status' });
    // Moving INTO an executable status requires the launch-grade config check.
    if (tc.isExecutable(to)) {
      const check = tc.validateCampaignConfig(campaign, { forLaunch: true });
      if (!check.valid) return res.status(400).json({ success: false, error: check.errors.join('; ') });
      if (await getGlobalKill(db)) {
        return res.status(400).json({ success: false, error: 'global targeted-campaign kill switch is ON' });
      }
    }
    const r = await tc.transitionCampaign(campaign.id, campaign.status, to, { actor: actorOf(req) });
    if (!r.success) return res.status(409).json({ success: false, error: r.error });
    // Resuming into an executable status re-engages the agent next cron run;
    // an explicit immediate kick is available via POST /:id/run.
    res.json({ success: true, data: r.campaign });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Campaign kill switch (pause + flag). Resume clears the flag.
router.post('/:id/kill', async (req, res) => {
  try {
    const db = getServiceClient();
    const campaign = await getCampaign(db, req.params.id);
    if (!campaign) return res.status(404).json({ success: false, error: 'campaign not found' });
    const updates = { kill_switch: true, updated_at: new Date().toISOString() };
    const { data, error } = await db.from('targeted_campaigns')
      .update(updates).eq('id', campaign.id).select().single();
    if (error) throw error;
    if (tc.canTransition(campaign.status, 'paused')) {
      await tc.transitionCampaign(campaign.id, campaign.status, 'paused', {
        actor: actorOf(req), detail: { kill_switch: true },
      });
    }
    await tc.logCampaignActivity(FGA_TENANT_ID, campaign.id, actorOf(req), 'kill_switch_on', {});
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/:id/resume', async (req, res) => {
  try {
    const db = getServiceClient();
    const campaign = await getCampaign(db, req.params.id);
    if (!campaign) return res.status(404).json({ success: false, error: 'campaign not found' });
    const to = req.body?.to; // which executable status to resume into
    if (!tc.isExecutable(to)) return res.status(400).json({ success: false, error: 'resume target must be an executable status' });
    if (await getGlobalKill(db)) return res.status(400).json({ success: false, error: 'global targeted-campaign kill switch is ON' });
    await db.from('targeted_campaigns')
      .update({ kill_switch: false, updated_at: new Date().toISOString() }).eq('id', campaign.id);
    const r = await tc.transitionCampaign(campaign.id, campaign.status, to, { actor: actorOf(req), detail: { resumed: true } });
    if (!r.success) return res.status(409).json({ success: false, error: r.error });
    res.json({ success: true, data: r.campaign });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /:id/run — manual "run now" (only when executable; respects all caps).
router.post('/:id/run', async (req, res) => {
  try {
    const db = getServiceClient();
    const campaign = await getCampaign(db, req.params.id);
    if (!campaign) return res.status(404).json({ success: false, error: 'campaign not found' });
    if (!tc.isExecutable(campaign.status)) {
      return res.status(400).json({ success: false, error: `campaign status '${campaign.status}' is not executable` });
    }
    if (campaign.kill_switch) return res.status(400).json({ success: false, error: 'campaign kill switch is ON' });
    if (await getGlobalKill(db)) return res.status(400).json({ success: false, error: 'global targeted-campaign kill switch is ON' });
    await enqueueCampaignRun(campaign.id);
    await tc.logCampaignActivity(FGA_TENANT_ID, campaign.id, actorOf(req), 'run_enqueued', { manual: true });
    res.json({ success: true, data: { enqueued: true } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ───────────────────────────────────────────────────────────────────────
// Drill-down tab data
// ───────────────────────────────────────────────────────────────────────
router.get('/:id/prospects', async (req, res) => {
  try {
    const db = getServiceClient();
    const { data: members, error } = await db
      .from('targeted_campaign_memberships').select('*')
      .eq('campaign_id', req.params.id).eq('tenant_id', FGA_TENANT_ID)
      .order('created_at', { ascending: false }).limit(500);
    if (error) throw error;
    const leadIds = [...new Set((members || []).map((m) => m.lead_id))];
    let leadsById = {};
    if (leadIds.length) {
      const { data: leads } = await db.from('leads')
        .select('id, company_name, industry, city, hq_state, email, phone, lifecycle_stage, status, metadata')
        .in('id', leadIds);
      leadsById = Object.fromEntries((leads || []).map((l) => [l.id, l]));
    }
    res.json({ success: true, data: (members || []).map((m) => ({ ...m, lead: leadsById[m.lead_id] || null })) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/:id/runs', async (req, res) => {
  try {
    const db = getServiceClient();
    const { data, error } = await db.from('targeted_campaign_runs').select('*')
      .eq('campaign_id', req.params.id).eq('tenant_id', FGA_TENANT_ID)
      .order('started_at', { ascending: false }).limit(100);
    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/:id/activity', async (req, res) => {
  try {
    const db = getServiceClient();
    const { data, error } = await db.from('targeted_campaign_activity').select('*')
      .eq('campaign_id', req.params.id).eq('tenant_id', FGA_TENANT_ID)
      .order('created_at', { ascending: false }).limit(200);
    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/:id/usage', async (req, res) => {
  try {
    const db = getServiceClient();
    const { data, error } = await db.from('targeted_campaign_usage').select('*')
      .eq('campaign_id', req.params.id).eq('tenant_id', FGA_TENANT_ID)
      .order('created_at', { ascending: false }).limit(200);
    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Outreach tab — drafts/sends created by this campaign (sequences carry
// metadata.campaign_id). Email approvals/sends still flow through the
// existing Pipeline approval queue + sendEmailOutreachSequence.
router.get('/:id/outreach', async (req, res) => {
  try {
    const db = getServiceClient();
    const { data: seqs, error } = await db
      .from('outreach_sequences')
      .select('id, lead_id, sequence_type, sequence_status, sequence_name, message_subject, created_at, metadata')
      .eq('tenant_id', FGA_TENANT_ID)
      .eq('metadata->>campaign_id', req.params.id)
      .order('created_at', { ascending: false }).limit(500);
    if (error) throw error;
    const leadIds = [...new Set((seqs || []).map((s) => s.lead_id))];
    let leadsById = {};
    if (leadIds.length) {
      const { data: leads } = await db.from('leads')
        .select('id, company_name').in('id', leadIds);
      leadsById = Object.fromEntries((leads || []).map((l) => [l.id, l]));
    }
    res.json({ success: true, data: (seqs || []).map((s) => ({ ...s, company: leadsById[s.lead_id]?.company_name || null })) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/:id/versions', async (req, res) => {
  try {
    const db = getServiceClient();
    const { data, error } = await db.from('targeted_campaign_versions').select('*')
      .eq('campaign_id', req.params.id).eq('tenant_id', FGA_TENANT_ID)
      .order('version', { ascending: false }).limit(50);
    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
