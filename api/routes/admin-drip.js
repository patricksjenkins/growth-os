/**
 * First Gen Automate — Drip Campaign admin routes (platform owner only).
 * Mounted at /api/admin/drip behind authMiddleware + adminMiddleware.
 *
 * Campaign Control Center backend:
 *   GET    /overview                      flag + campaign + steps + stats + gmail status
 *   POST   /flag                          { enabled } -> tenant_config drip_campaign_enabled
 *   POST   /campaign/generate             create draft campaign + 9 Claude-generated steps
 *   GET    /campaign/:id                  campaign + steps
 *   POST   /campaign/:id/new-version      clone an active campaign into an editable draft
 *   POST   /campaign/:id/activate         all steps approved -> active (archives prior active)
 *   PUT    /steps/:id                     edit subject/body (draft campaigns only)
 *   POST   /steps/:id/approve             approve a step
 *   POST   /steps/:id/regenerate          re-run Claude for one step
 *   GET    /steps/:id/preview             rendered preview (?lead_id= optional)
 *   GET    /enrollments                   list (?status=) with lead info
 *   POST   /enrollments/:id/pause|resume|stop|skip-next
 *   GET    /lead/:leadId                  drip panel data for the LeadDrawer
 *   GET    /review                        ambiguous-inbound human review queue
 *   POST   /review/:id/resolve            { decision: genuine_reply|resume|ignore }
 *   POST   /migrate/preview               existing-prospect migration dry run
 *   POST   /migrate/execute               { lead_ids } explicit confirmation required
 *   GET    /report                        funnel + per-step + coupon reporting
 *   GET    /gmail/status                  inbox connection state
 *   POST   /gmail/connect                 returns the Google OAuth URL
 *   POST   /run                           enqueue an agent run (?dry_run=true supported)
 */

const express = require('express');
const router = express.Router();

const { getServiceClient } = require('../../db/client');
const { createLogger } = require('../../core/logger');
const { FGA_TENANT_ID } = require('../../core/config');
const drip = require('../../core/drip-campaign');
const { stripAiTells, NO_DASH_PROMPT_RULE } = require('../../core/text-style');

const log = createLogger('admin-drip');

function db() { return getServiceClient(); }

// ---------------------------------------------------------------------------
// Overview + feature flag
// ---------------------------------------------------------------------------

async function fetchFlag(client) {
  const { data } = await client
    .from('tenant_config')
    .select('value')
    .eq('tenant_id', FGA_TENANT_ID)
    .eq('key', drip.DRIP_CONFIG_KEY)
    .maybeSingle();
  return data?.value === true || data?.value === 'true';
}

router.get('/overview', async (req, res) => {
  try {
    const client = db();
    const enabled = await fetchFlag(client);

    // Latest campaign of each interesting status
    const { data: campaigns } = await client
      .from('drip_campaigns')
      .select('*')
      .eq('tenant_id', FGA_TENANT_ID)
      .order('version', { ascending: false })
      .limit(10);
    const active = (campaigns || []).find((c) => c.status === 'active') || null;
    const draft = (campaigns || []).find((c) => ['draft', 'pending_approval'].includes(c.status)) || null;
    const current = draft || active;
    const steps = current ? await drip.getCampaignSteps(client, current.id) : [];

    // Enrollment stats
    const { data: enrollments } = await client
      .from('drip_enrollments')
      .select('status')
      .eq('tenant_id', FGA_TENANT_ID);
    const enrollmentCounts = {};
    for (const e of enrollments || []) enrollmentCounts[e.status] = (enrollmentCounts[e.status] || 0) + 1;

    const { count: sentCount } = await client
      .from('drip_sends')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', FGA_TENANT_ID)
      .eq('status', 'sent');
    const { count: reviewCount } = await client
      .from('drip_inbound')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', FGA_TENANT_ID)
      .eq('classification', 'ambiguous')
      .is('reviewed_at', null);
    const { count: suppressedCount } = await client
      .from('drip_suppressions')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', FGA_TENANT_ID);

    // Gmail connection
    const { getGmailConnection } = require('../../core/drip-gmail');
    const conn = await getGmailConnection(client);

    res.json({
      success: true,
      enabled,
      campaign: current,
      active_campaign: active,
      steps,
      touch_points: drip.TOUCH_POINTS,
      stats: {
        enrollments: enrollmentCounts,
        total_sent: sentCount || 0,
        review_pending: reviewCount || 0,
        suppressed: suppressedCount || 0,
      },
      gmail: conn ? { connected: true, address: conn.email_address } : { connected: false },
    });
  } catch (err) {
    log.error(`overview failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/flag', async (req, res) => {
  try {
    const enabled = req.body?.enabled === true || req.body?.enabled === 'true';
    await db().from('tenant_config').upsert(
      [{ tenant_id: FGA_TENANT_ID, key: drip.DRIP_CONFIG_KEY, value: enabled ? 'true' : 'false' }],
      { onConflict: 'tenant_id,key' },
    );
    await db().from('activity_log').insert({
      tenant_id: FGA_TENANT_ID, agent: 'admin', action: enabled ? 'drip_feature_enabled' : 'drip_feature_disabled',
      entity_type: 'campaign', entity_id: null, level: 'info',
      metadata: { by: req.user?.email || 'admin' },
    });
    res.json({ success: true, enabled });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Template generation (Claude) — modules page + approved facts as sources
// ---------------------------------------------------------------------------

async function fetchModulesText() {
  try {
    const resp = await fetch('https://www.firstgenautomate.com/modules', {
      headers: { 'User-Agent': 'FGA-drip-template-generator' },
    });
    const html = await resp.text();
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 12000);
  } catch (err) {
    log.warn(`modules page fetch failed (${err.message}) — generating without it`);
    return null;
  }
}

async function fetchApprovedFacts(client) {
  const { data } = await client
    .from('marketing_approved_facts')
    .select('statistic_text, approved_wording, source_name')
    .eq('active', true)
    .limit(20);
  return data || [];
}

const GENERATION_SYSTEM = `You write prospecting follow-up emails for First Gen Automate (FGA), a fully managed AI-agent platform deployed for small service businesses (plumbers, landscapers, barbers, etc.). Patrick Jenkins, the founder, sends these personally from patrick@firstgenautomate.com.

HARD RULES — violating any of these makes the output unusable:
- Never overpromise. Understate capability. FGA captures leads, texts new leads back in seconds, follows up, requests reviews, and generates content. FGA can NOT see the prospect's calendar, schedule, dispatch, inventory, or pricing — never imply booking jobs or dispatching techs.
- PLAN TIERS MATTER. The AI Voice Receptionist is a SCALE-tier-only flagship feature. It is NOT part of the Growth plan. The first-month-free offer in this campaign covers the GROWTH plan ONLY. Therefore: on any offer/coupon step, never mention, imply, or list the AI Voice Receptionist (or any other Scale-only feature) as included in the free month — doing so promises something the offer does not deliver. Growth covers the lead-capture, speed-to-lead/text-back, follow-up, review-request, and content features. Only describe the Voice Receptionist in non-offer steps, and only as a Scale-tier feature, never as included in the Growth free month.
- Say "deployed"/"set up for you", never "install".
- The word "agent" is good — prospects ask for agents.
- Brand name in prose: "First Gen Automate" on first mention, "FGA" after is fine.
- Plain, honest, founder-to-owner voice. Short paragraphs. No hype words, no fake scarcity, no emojis.
- Use only facts from the provided source material. Invent NO statistics.
- Personalization tokens available: {{first_name}}, {{company}}, {{city}}, and on coupon steps {{coupon_code}} and {{coupon_expires}}. Use {{first_name}} in the greeting.
- Each email: subject under 60 chars, body 90-160 words, exactly one CTA (usually "reply to this email").
- Body must be simple HTML: <p> paragraphs only, no images, no tables.

${NO_DASH_PROMPT_RULE}

Return JSON: {"subject": "...", "body_html": "..."}`;

async function generateStep(tp, sources) {
  const { askClaudeJSON } = require('../../integrations/claude');
  const userMsg = [
    `Write the Day ${tp.day} email of a 9-touch drip campaign. This touch's strategic purpose: ${tp.purpose}.`,
    `Brief: ${tp.brief}`,
    tp.coupon ? 'This step MUST include the {{coupon_code}} token and the {{coupon_expires}} token verbatim. The free month is the GROWTH plan only — do NOT name or imply the AI Voice Receptionist or any Scale-only feature as part of this offer.' : 'Do not mention any discount or coupon.',
    sources.modules ? `\nSource of truth — FGA modules page:\n${sources.modules}` : '',
    sources.facts.length ? `\nApproved facts you may cite (verbatim wording only):\n${sources.facts.map((f) => `- ${f.approved_wording || f.statistic_text} (${f.source_name})`).join('\n')}` : '\nNo approved statistics available — cite none.',
    '\nReturn only the JSON object.',
  ].join('\n');
  const out = await askClaudeJSON(GENERATION_SYSTEM, userMsg, { maxTokens: 1200, retries: 2 });
  if (!out?.subject || !out?.body_html) throw new Error(`generation returned incomplete JSON for day ${tp.day}`);
  // House style: strip em/en dashes, curly quotes, ellipsis so it reads human.
  out.subject = stripAiTells(out.subject);
  out.body_html = stripAiTells(out.body_html);
  if (out.body_plain) out.body_plain = stripAiTells(out.body_plain);
  return out;
}

router.post('/campaign/generate', async (req, res) => {
  try {
    const client = db();

    // refuse if an editable draft already exists
    const { data: existingDraft } = await client
      .from('drip_campaigns')
      .select('id')
      .eq('tenant_id', FGA_TENANT_ID)
      .in('status', ['draft', 'pending_approval'])
      .maybeSingle();
    if (existingDraft) {
      return res.status(409).json({ success: false, error: 'A draft campaign already exists — edit or activate it first.' });
    }

    const { data: latest } = await client
      .from('drip_campaigns')
      .select('version')
      .eq('tenant_id', FGA_TENANT_ID)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle();
    const version = (latest?.version || 0) + 1;

    const { data: campaign, error: campErr } = await client
      .from('drip_campaigns')
      .insert({
        tenant_id: FGA_TENANT_ID,
        name: `Prospect Drip v${version}`,
        status: 'draft',
        version,
        created_by: req.user?.email || 'admin',
      })
      .select()
      .single();
    if (campErr) throw campErr;

    const sources = {
      modules: await fetchModulesText(),
      facts: await fetchApprovedFacts(client),
    };

    const steps = [];
    const failures = [];
    for (const tp of drip.TOUCH_POINTS) {
      try {
        const gen = await generateStep(tp, sources);
        const { data: step, error: stepErr } = await client
          .from('drip_campaign_steps')
          .insert({
            tenant_id: FGA_TENANT_ID,
            campaign_id: campaign.id,
            day_offset: tp.day,
            purpose: tp.purpose,
            subject_template: gen.subject,
            body_html_template: gen.body_html,
            status: 'draft',
            generation_metadata: { generated_at: new Date().toISOString(), used_modules_page: !!sources.modules, facts_count: sources.facts.length },
          })
          .select()
          .single();
        if (stepErr) throw stepErr;
        steps.push(step);
      } catch (genErr) {
        log.error(`Day ${tp.day} generation failed: ${genErr.message}`);
        failures.push({ day: tp.day, error: genErr.message });
      }
    }

    await client.from('activity_log').insert({
      tenant_id: FGA_TENANT_ID, agent: 'admin', action: 'drip_campaign_generated',
      entity_type: 'campaign', entity_id: campaign.id, level: 'info',
      metadata: { version, steps_generated: steps.length, failures },
    });

    res.json({ success: true, campaign, steps, failures });
  } catch (err) {
    log.error(`campaign generate failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/campaign/:id', async (req, res) => {
  try {
    const client = db();
    const { data: campaign } = await client
      .from('drip_campaigns')
      .select('*')
      .eq('id', req.params.id)
      .eq('tenant_id', FGA_TENANT_ID)
      .maybeSingle();
    if (!campaign) return res.status(404).json({ success: false, error: 'Campaign not found' });
    const steps = await drip.getCampaignSteps(client, campaign.id);
    res.json({ success: true, campaign, steps });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Clone an ACTIVE campaign into a new editable draft version. The active
// version keeps sending until the new one is activated (campaign versioning).
router.post('/campaign/:id/new-version', async (req, res) => {
  try {
    const client = db();
    const { data: source } = await client
      .from('drip_campaigns')
      .select('*')
      .eq('id', req.params.id)
      .eq('tenant_id', FGA_TENANT_ID)
      .maybeSingle();
    if (!source) return res.status(404).json({ success: false, error: 'Campaign not found' });

    const { data: existingDraft } = await client
      .from('drip_campaigns')
      .select('id')
      .eq('tenant_id', FGA_TENANT_ID)
      .in('status', ['draft', 'pending_approval'])
      .maybeSingle();
    if (existingDraft) {
      return res.status(409).json({ success: false, error: 'A draft already exists — finish or discard it first.' });
    }

    const { data: latest } = await client
      .from('drip_campaigns')
      .select('version')
      .eq('tenant_id', FGA_TENANT_ID)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle();
    const version = (latest?.version || 0) + 1;

    const { data: clone, error: cloneErr } = await client
      .from('drip_campaigns')
      .insert({
        tenant_id: FGA_TENANT_ID,
        name: `Prospect Drip v${version}`,
        status: 'draft',
        version,
        source_campaign_id: source.id,
        created_by: req.user?.email || 'admin',
      })
      .select()
      .single();
    if (cloneErr) throw cloneErr;

    const sourceSteps = await drip.getCampaignSteps(client, source.id);
    for (const s of sourceSteps) {
      await client.from('drip_campaign_steps').insert({
        tenant_id: FGA_TENANT_ID,
        campaign_id: clone.id,
        day_offset: s.day_offset,
        purpose: s.purpose,
        subject_template: s.subject_template,
        body_html_template: s.body_html_template,
        status: 'draft', // edits require re-approval
        generation_metadata: { cloned_from_step: s.id },
      });
    }

    const steps = await drip.getCampaignSteps(client, clone.id);
    res.json({ success: true, campaign: clone, steps });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/campaign/:id/activate', async (req, res) => {
  try {
    const client = db();
    const { data: campaign } = await client
      .from('drip_campaigns')
      .select('*')
      .eq('id', req.params.id)
      .eq('tenant_id', FGA_TENANT_ID)
      .maybeSingle();
    if (!campaign) return res.status(404).json({ success: false, error: 'Campaign not found' });
    if (campaign.status === 'active') return res.json({ success: true, campaign });

    const steps = await drip.getCampaignSteps(client, campaign.id);
    const expected = drip.TOUCH_DAYS;
    const approvedDays = steps.filter((s) => s.status === 'approved').map((s) => s.day_offset);
    const missing = expected.filter((d) => !approvedDays.includes(d));
    if (missing.length) {
      return res.status(400).json({ success: false, error: `All 9 touch points must be approved before activation. Missing: Day ${missing.join(', Day ')}.` });
    }

    // archive any currently-active campaign (enrollments keep their
    // campaign_id, so in-flight prospects finish on the version they started)
    await client
      .from('drip_campaigns')
      .update({ status: 'archived', updated_at: new Date().toISOString() })
      .eq('tenant_id', FGA_TENANT_ID)
      .eq('status', 'active')
      .neq('id', campaign.id);

    const { data: activated, error } = await client
      .from('drip_campaigns')
      .update({ status: 'active', activated_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', campaign.id)
      .select()
      .single();
    if (error) throw error;

    await client.from('activity_log').insert({
      tenant_id: FGA_TENANT_ID, agent: 'admin', action: 'drip_campaign_activated',
      entity_type: 'campaign', entity_id: campaign.id, level: 'info',
      metadata: { version: campaign.version, by: req.user?.email || 'admin' },
    });

    res.json({ success: true, campaign: activated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Steps: edit / approve / regenerate / preview
// ---------------------------------------------------------------------------

async function getEditableStep(client, stepId) {
  const { data: step } = await client
    .from('drip_campaign_steps')
    .select('*, drip_campaigns!inner(status)')
    .eq('id', stepId)
    .eq('tenant_id', FGA_TENANT_ID)
    .maybeSingle();
  return step;
}

router.put('/steps/:id', async (req, res) => {
  try {
    const client = db();
    const step = await getEditableStep(client, req.params.id);
    if (!step) return res.status(404).json({ success: false, error: 'Step not found' });
    if (!['draft', 'pending_approval'].includes(step.drip_campaigns.status)) {
      return res.status(400).json({ success: false, error: 'Active campaigns are read-only. Create a new version to edit.' });
    }
    const updates = { updated_at: new Date().toISOString(), edited_by_user: true, status: 'draft', approved_at: null, approved_by: null };
    if (typeof req.body?.subject_template === 'string') updates.subject_template = req.body.subject_template.slice(0, 200);
    if (typeof req.body?.body_html_template === 'string') updates.body_html_template = req.body.body_html_template;
    const { data, error } = await client
      .from('drip_campaign_steps')
      .update(updates)
      .eq('id', step.id)
      .select()
      .single();
    if (error) throw error;
    res.json({ success: true, step: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/steps/:id/approve', async (req, res) => {
  try {
    const client = db();
    const step = await getEditableStep(client, req.params.id);
    if (!step) return res.status(404).json({ success: false, error: 'Step not found' });
    // coupon steps must keep their tokens — server-side guard
    const tp = drip.TOUCH_POINTS.find((t) => t.day === step.day_offset);
    if (tp?.coupon) {
      const text = `${step.subject_template} ${step.body_html_template}`;
      if (!text.includes('{{coupon_code}}')) {
        return res.status(400).json({ success: false, error: `Day ${step.day_offset} must include the {{coupon_code}} token.` });
      }
    }
    const { data, error } = await client
      .from('drip_campaign_steps')
      .update({ status: 'approved', approved_at: new Date().toISOString(), approved_by: req.user?.email || 'admin', updated_at: new Date().toISOString() })
      .eq('id', step.id)
      .select()
      .single();
    if (error) throw error;
    res.json({ success: true, step: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/steps/:id/regenerate', async (req, res) => {
  try {
    const client = db();
    const step = await getEditableStep(client, req.params.id);
    if (!step) return res.status(404).json({ success: false, error: 'Step not found' });
    if (!['draft', 'pending_approval'].includes(step.drip_campaigns.status)) {
      return res.status(400).json({ success: false, error: 'Active campaigns are read-only.' });
    }
    const tp = drip.TOUCH_POINTS.find((t) => t.day === step.day_offset);
    if (!tp) return res.status(400).json({ success: false, error: 'Unknown touch point' });
    const sources = { modules: await fetchModulesText(), facts: await fetchApprovedFacts(client) };
    const gen = await generateStep(tp, sources);
    const { data, error } = await client
      .from('drip_campaign_steps')
      .update({
        subject_template: gen.subject,
        body_html_template: gen.body_html,
        status: 'draft',
        approved_at: null,
        approved_by: null,
        edited_by_user: false,
        generation_metadata: { regenerated_at: new Date().toISOString(), used_modules_page: !!sources.modules },
        updated_at: new Date().toISOString(),
      })
      .eq('id', step.id)
      .select()
      .single();
    if (error) throw error;
    res.json({ success: true, step: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/steps/:id/preview', async (req, res) => {
  try {
    const client = db();
    const { data: step } = await client
      .from('drip_campaign_steps')
      .select('*')
      .eq('id', req.params.id)
      .eq('tenant_id', FGA_TENANT_ID)
      .maybeSingle();
    if (!step) return res.status(404).json({ success: false, error: 'Step not found' });

    let lead = { id: 'preview', name: 'Sam Carter', company_name: 'Carter Plumbing', city: 'Denver', email: 'preview@example.com' };
    if (req.query.lead_id) {
      const { data: realLead } = await client
        .from('leads').select('*').eq('id', req.query.lead_id).eq('tenant_id', FGA_TENANT_ID).maybeSingle();
      if (realLead) lead = realLead;
    }
    const rendered = await drip.renderStepEmail(client, { step, lead, enrollment: null, preview: true });
    res.json({ success: true, preview: rendered });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Enrollments
// ---------------------------------------------------------------------------

router.get('/enrollments', async (req, res) => {
  try {
    const client = db();
    let q = client
      .from('drip_enrollments')
      .select('*, leads(id, name, company_name, email, status)')
      .eq('tenant_id', FGA_TENANT_ID)
      .order('next_send_at', { ascending: true, nullsFirst: false })
      .limit(Math.min(Number(req.query.limit) || 200, 500));
    if (req.query.status) q = q.eq('status', req.query.status);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ success: true, enrollments: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/enrollments/:id/pause', async (req, res) => {
  try {
    const enrollment = await drip.pauseEnrollment(db(), req.params.id, {
      reason: req.body?.reason || 'manual', until: req.body?.until || null, by: req.user?.email || 'admin',
    });
    if (!enrollment) return res.status(400).json({ success: false, error: 'Enrollment not pausable' });
    res.json({ success: true, enrollment });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/enrollments/:id/resume', async (req, res) => {
  try {
    const enrollment = await drip.resumeEnrollment(db(), req.params.id, { by: req.user?.email || 'admin' });
    if (!enrollment) return res.status(400).json({ success: false, error: 'Enrollment not resumable' });
    res.json({ success: true, enrollment });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/enrollments/:id/stop', async (req, res) => {
  try {
    const enrollment = await drip.stopEnrollment(db(), req.params.id, {
      status: 'stopped', reason: req.body?.reason || 'manual', by: req.user?.email || 'admin',
    });
    if (!enrollment) return res.status(404).json({ success: false, error: 'Enrollment not found' });
    res.json({ success: true, enrollment });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Skip the next touch point — advances the cursor without sending. The
// skipped touch is recorded in drip_sends for the audit trail.
router.post('/enrollments/:id/skip-next', async (req, res) => {
  try {
    const client = db();
    const { data: enrollment } = await client
      .from('drip_enrollments').select('*').eq('id', req.params.id).eq('tenant_id', FGA_TENANT_ID).maybeSingle();
    if (!enrollment || enrollment.status !== 'active' || !enrollment.next_step_day) {
      return res.status(400).json({ success: false, error: 'Enrollment has no skippable touch' });
    }
    const skippedDay = enrollment.next_step_day;
    await client.from('drip_sends').insert({
      tenant_id: FGA_TENANT_ID,
      enrollment_id: enrollment.id,
      lead_id: enrollment.lead_id,
      day_offset: skippedDay,
      status: 'skipped',
      skip_reason: `manual_skip:${req.user?.email || 'admin'}`,
      scheduled_for: enrollment.next_send_at,
    }).then(() => {}, () => {});

    const idx = drip.TOUCH_DAYS.indexOf(skippedDay);
    const nextDay = idx >= 0 && idx < drip.TOUCH_DAYS.length - 1 ? drip.TOUCH_DAYS[idx + 1] : null;
    let updated;
    if (nextDay === null) {
      updated = await drip.stopEnrollment(client, enrollment.id, { status: 'completed', reason: 'final_touch_skipped', by: req.user?.email || 'admin' });
    } else {
      const tz = enrollment.metadata?.timezone || drip.DEFAULT_TZ;
      let nextAt = drip.computeSendAt(enrollment.day1_at, nextDay, tz);
      if (nextAt <= new Date()) nextAt = drip.computeSendAt(new Date().toISOString(), 1, tz);
      const { data } = await client
        .from('drip_enrollments')
        .update({ next_step_day: nextDay, next_send_at: nextAt.toISOString(), updated_at: new Date().toISOString() })
        .eq('id', enrollment.id)
        .select()
        .single();
      updated = data;
    }
    await client.from('activity_log').insert({
      tenant_id: FGA_TENANT_ID, agent: req.user?.email || 'admin', action: 'drip_touch_skipped',
      entity_type: 'lead', entity_id: enrollment.lead_id, level: 'info',
      metadata: { enrollment_id: enrollment.id, skipped_day: skippedDay },
    });
    res.json({ success: true, enrollment: updated, skipped_day: skippedDay });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// LeadDrawer panel: enrollment + send history + coupon + inbound for a lead.
router.get('/lead/:leadId', async (req, res) => {
  try {
    const client = db();
    const leadId = req.params.leadId;
    const [{ data: enrollment }, { data: sends }, { data: coupon }, { data: inbound }] = await Promise.all([
      client.from('drip_enrollments').select('*').eq('lead_id', leadId).eq('tenant_id', FGA_TENANT_ID)
        .order('created_at', { ascending: false }).limit(1).maybeSingle(),
      client.from('drip_sends').select('*').eq('lead_id', leadId).eq('tenant_id', FGA_TENANT_ID)
        .order('day_offset', { ascending: true }),
      client.from('drip_coupons').select('*').eq('lead_id', leadId).maybeSingle(),
      client.from('drip_inbound').select('*').eq('lead_id', leadId).eq('tenant_id', FGA_TENANT_ID)
        .order('created_at', { ascending: false }).limit(10),
    ]);
    res.json({
      success: true,
      enrollment: enrollment || null,
      sends: sends || [],
      coupon: coupon || null,
      inbound: inbound || [],
      touch_points: drip.TOUCH_POINTS,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Human review queue (ambiguous inbound)
// ---------------------------------------------------------------------------

router.get('/review', async (req, res) => {
  try {
    const client = db();
    const { data, error } = await client
      .from('drip_inbound')
      .select('*, leads(id, name, company_name, email)')
      .eq('tenant_id', FGA_TENANT_ID)
      .eq('classification', 'ambiguous')
      .is('reviewed_at', null)
      .order('created_at', { ascending: true });
    if (error) throw error;
    res.json({ success: true, items: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// decision: 'genuine_reply' (stop -> Replied) | 'resume' (false alarm,
// continue campaign) | 'ignore' (leave paused-for-review, mark reviewed)
router.post('/review/:id/resolve', async (req, res) => {
  try {
    const client = db();
    const decision = req.body?.decision;
    if (!['genuine_reply', 'resume', 'ignore'].includes(decision)) {
      return res.status(400).json({ success: false, error: 'decision must be genuine_reply | resume | ignore' });
    }
    const { data: item } = await client
      .from('drip_inbound').select('*').eq('id', req.params.id).eq('tenant_id', FGA_TENANT_ID).maybeSingle();
    if (!item) return res.status(404).json({ success: false, error: 'Review item not found' });

    const by = req.user?.email || 'admin';
    let actionTaken = 'reviewed_ignored';

    if (decision === 'genuine_reply' && item.enrollment_id) {
      await drip.stopEnrollment(client, item.enrollment_id, { status: 'replied', reason: 'human_review_genuine_reply', by });
      if (item.lead_id) {
        await client.from('leads').update({ status: 'replied' }).eq('id', item.lead_id).eq('tenant_id', FGA_TENANT_ID);
      }
      actionTaken = 'stopped_replied';
    } else if (decision === 'resume' && item.enrollment_id) {
      await drip.resumeEnrollment(client, item.enrollment_id, { by });
      actionTaken = 'resumed';
    }

    const { data: updated, error } = await client
      .from('drip_inbound')
      .update({
        reviewed_at: new Date().toISOString(),
        reviewed_by: by,
        review_decision: decision,
        action_taken: actionTaken,
      })
      .eq('id', item.id)
      .select()
      .single();
    if (error) throw error;
    res.json({ success: true, item: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Existing-prospect migration (preview + explicit execute)
// ---------------------------------------------------------------------------

// Candidates: leads already contacted via approved outreach (the historical
// equivalent of Day 1) with no live enrollment, not suppressed, not terminal.
async function buildMigrationPlan(client) {
  const campaign = await drip.getActiveCampaign(client);
  if (!campaign) return { error: 'No active campaign — activate one before migrating.' };

  const { data: leads } = await client
    .from('leads')
    .select('id, name, company_name, email, status, lifecycle_stage')
    .eq('tenant_id', FGA_TENANT_ID)
    .eq('lifecycle_stage', 'sequenced')
    .limit(2000);

  const ids = (leads || []).map((l) => l.id);
  const { data: existing } = ids.length
    ? await client.from('drip_enrollments').select('lead_id').in('lead_id', ids)
    : { data: [] };
  const enrolledIds = new Set((existing || []).map((e) => e.lead_id));

  const plan = [];
  for (const lead of leads || []) {
    if (enrolledIds.has(lead.id)) continue;
    if (lead.status === 'replied') { plan.push({ lead, action: 'skip', reason: 'already_replied' }); continue; }
    if (drip.TERMINAL_LEAD_STATUSES.has(lead.status) && lead.status !== 'no_response') {
      plan.push({ lead, action: 'skip', reason: `terminal_status_${lead.status}` });
      continue;
    }
    if (!lead.email) { plan.push({ lead, action: 'skip', reason: 'no_email' }); continue; }
    const suppressed = await drip.isSuppressed(client, lead.email);
    if (suppressed) { plan.push({ lead, action: 'skip', reason: `suppressed_${suppressed}` }); continue; }

    // Day 1 = when we first actually emailed this prospect. Prefer the admin
    // send path's activity_log 'outreach_sent' row; if absent, fall back to
    // the outreach_sequences row the automated outreach worker marks 'sent'
    // (it records its send time in metadata.sent_at but writes NO activity_log
    // entry). Only when neither exists has the prospect truly never been
    // emailed (e.g. a draft was generated but never sent).
    let day1At = null;
    const { data: sentLog } = await client
      .from('activity_log')
      .select('created_at, metadata')
      .eq('tenant_id', FGA_TENANT_ID)
      .eq('entity_id', lead.id)
      .eq('action', 'outreach_sent')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (sentLog) {
      day1At = sentLog.metadata?.sent_at || sentLog.created_at;
    } else {
      const { data: sentSeqs } = await client
        .from('outreach_sequences')
        .select('metadata, updated_at, created_at')
        .eq('tenant_id', FGA_TENANT_ID)
        .eq('lead_id', lead.id)
        .eq('sequence_status', 'sent');
      const times = (sentSeqs || [])
        .map((s) => s.metadata?.sent_at || s.updated_at || s.created_at)
        .filter(Boolean)
        .sort();
      if (times.length) day1At = times[0];
    }
    if (!day1At) { plan.push({ lead, action: 'skip', reason: 'no_outreach_sent_record' }); continue; }
    const next = drip.nextFutureTouch(day1At);
    if (!next) {
      plan.push({ lead, action: 'mark_no_response', day1_at: day1At, reason: 'past_day_180' });
    } else {
      plan.push({ lead, action: 'enroll', day1_at: day1At, start_at_day: next.day });
    }
  }
  return { campaign, plan };
}

router.post('/migrate/preview', async (req, res) => {
  try {
    const client = db();
    const result = await buildMigrationPlan(client);
    if (result.error) return res.status(400).json({ success: false, error: result.error });
    const summary = { enroll: 0, mark_no_response: 0, skip: 0 };
    for (const p of result.plan) summary[p.action] = (summary[p.action] || 0) + 1;
    // Surface the master flag so the UI can warn that enrolls will be
    // skipped as feature_disabled until the campaign is enabled (the
    // execute path runs enrollLead, which no-ops while the flag is off).
    const enabled = await fetchFlag(client);
    res.json({ success: true, summary, plan: result.plan, enabled });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/migrate/execute', async (req, res) => {
  try {
    if (req.body?.confirm !== true) {
      return res.status(400).json({ success: false, error: 'Explicit confirmation required: pass { "confirm": true }.' });
    }
    const client = db();
    const result = await buildMigrationPlan(client);
    if (result.error) return res.status(400).json({ success: false, error: result.error });

    // optional narrowing to specific leads
    const onlyIds = Array.isArray(req.body?.lead_ids) ? new Set(req.body.lead_ids) : null;
    const { resolveTenant } = require('../../core/tenant');
    const tenant = await resolveTenant(client, FGA_TENANT_ID).catch(() => null);

    const outcome = { enrolled: 0, marked_no_response: 0, skipped: 0, errors: [] };
    for (const p of result.plan) {
      if (onlyIds && !onlyIds.has(p.lead.id)) continue;
      try {
        if (p.action === 'enroll') {
          const r = await drip.enrollLead(client, {
            leadId: p.lead.id,
            email: p.lead.email,
            day1At: p.day1_at,
            enrolledBy: 'migration',
            startAtDay: p.start_at_day,
            catchUp: true,
            tenant,
            lead: p.lead,
          });
          if (r.enrolled) outcome.enrolled++;
          else { outcome.skipped++; outcome.errors.push({ lead_id: p.lead.id, reason: r.skipped_reason }); }
        } else if (p.action === 'mark_no_response') {
          await client.from('leads').update({ status: 'no_response' }).eq('id', p.lead.id).eq('tenant_id', FGA_TENANT_ID);
          await client.from('activity_log').insert({
            tenant_id: FGA_TENANT_ID, agent: 'migration', action: 'drip_migrated_no_response',
            entity_type: 'lead', entity_id: p.lead.id, level: 'info',
            metadata: { day1_at: p.day1_at },
          });
          outcome.marked_no_response++;
        } else {
          outcome.skipped++;
        }
      } catch (itemErr) {
        outcome.errors.push({ lead_id: p.lead.id, reason: itemErr.message });
      }
    }

    await client.from('activity_log').insert({
      tenant_id: FGA_TENANT_ID, agent: req.user?.email || 'admin', action: 'drip_migration_executed',
      entity_type: 'campaign', entity_id: result.campaign.id, level: 'info',
      metadata: outcome,
    });
    res.json({ success: true, ...outcome });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

router.get('/report', async (req, res) => {
  try {
    const client = db();
    const [{ data: enrollments }, { data: sends }, { data: coupons }, { count: suppressed }] = await Promise.all([
      client.from('drip_enrollments').select('status, next_step_day').eq('tenant_id', FGA_TENANT_ID),
      client.from('drip_sends').select('day_offset, status').eq('tenant_id', FGA_TENANT_ID),
      client.from('drip_coupons').select('status'),
      client.from('drip_suppressions').select('id', { count: 'exact', head: true }).eq('tenant_id', FGA_TENANT_ID),
    ]);

    const byStatus = {};
    for (const e of enrollments || []) byStatus[e.status] = (byStatus[e.status] || 0) + 1;
    const perStep = {};
    for (const d of drip.TOUCH_DAYS) perStep[d] = { sent: 0, skipped: 0, failed: 0 };
    for (const s of sends || []) {
      if (!perStep[s.day_offset]) perStep[s.day_offset] = { sent: 0, skipped: 0, failed: 0 };
      perStep[s.day_offset][s.status] = (perStep[s.day_offset][s.status] || 0) + 1;
    }
    const couponStats = {};
    for (const c of coupons || []) couponStats[c.status] = (couponStats[c.status] || 0) + 1;

    res.json({
      success: true,
      enrollments_by_status: byStatus,
      sends_per_step: perStep,
      coupons: couponStats,
      suppressed: suppressed || 0,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Gmail connection
// ---------------------------------------------------------------------------

router.get('/gmail/status', async (req, res) => {
  try {
    const { getGmailConnection } = require('../../core/drip-gmail');
    const conn = await getGmailConnection(db());
    res.json({ success: true, connected: !!conn, address: conn?.email_address || null });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/gmail/connect', async (req, res) => {
  try {
    const { buildGmailConnectUrl } = require('../../core/drip-gmail');
    const url = buildGmailConnectUrl();
    res.json({ success: true, url });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Manual run (supports dry_run)
// ---------------------------------------------------------------------------

router.post('/run', async (req, res) => {
  try {
    const { enqueueJob } = require('../../db/queries/jobs');
    const payload = {};
    if (req.body?.task === 'sync_replies') payload.task = 'sync_replies';
    if (req.body?.dry_run === true || req.body?.dry_run === 'true') payload.dry_run = true;
    const job = await enqueueJob(FGA_TENANT_ID, 'drip-campaign', payload);
    res.json({ success: true, job_id: job?.id || null, payload });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
