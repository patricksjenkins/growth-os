/**
 * FGA — Targeted Campaign Prospecting Agent
 *
 * A SECOND, fully separate prospecting workflow driven by owner-defined
 * campaigns (e.g. "Florida pool-opening season"). Completely independent from
 * the standard prospecting agent (worker/agents/prospecting.js):
 *  - own tables (targeted_campaign*), own schedule entry, own run history
 *  - leads inserted with lead_source='targeted_campaign_agent' so they NEVER
 *    count toward the standard agent's weekly-50 target
 *  - own kill switches (campaign.kill_switch + tenant_config
 *    targeted_campaigns_kill_switch) that do NOT affect the standard agent
 *
 * IDLE BY DEFAULT — this agent makes ZERO paid API calls (Serper / Claude /
 * Apify) unless a campaign is in an executable status (ready_for_pilot,
 * pilot_running, approved_to_continue, active). The scheduler `when`
 * predicate (core/targeted-campaigns.countExecutableCampaigns) means the job
 * isn't even ENQUEUED when nothing is executable; this run() re-checks status
 * + kill switches before any paid call as a second line of defense.
 *
 * REUSED SHARED SERVICES (not duplicated):
 *  - enrichment.enrichOne (Serper + Apify FB scrape + Claude contact hunt)
 *  - shared `leads` table + dedup (duplicates LINK via memberships)
 *  - outreach_sequences/conversations draft rows → the existing Pipeline
 *    approval queue, sendEmailOutreachSequence, drip enrollment, manual FB DM
 *    panel all work unchanged
 *
 * MESSAGING — variants are owner-written templates with {{placeholders}}
 * rendered per-lead by string substitution: ZERO AI calls per lead.
 *
 * CONCURRENCY — at most ONE run per campaign, claimed atomically via
 * UPDATE ... WHERE active_run_id IS NULL. Stale locks (>30 min) are cleared.
 * Campaign counters are only mutated by the single locked run.
 */

'use strict';

const axios = require('axios');
const { askClaudeJSON } = require('../../integrations/claude');
const { createLogger } = require('../../core/logger');
const { getConfig } = require('../../core/config');
const { db } = require('../../db/client');
const { sanitizePhone } = require('../../core/utils');
const { buildSignatureBlock } = require('../../core/email-signature');
const enrichment = require('./enrichment');
const tc = require('../../core/targeted-campaigns');

// Per-RUN safety caps (campaign-level budget caps live on the campaign row).
const DEFAULT_MAX_SERPER_CALLS_PER_RUN = 15;
const DEFAULT_MAX_CANDIDATES_PER_RUN = 50;
const ZERO_YIELD_LIMIT = 3; // consecutive zero-yield runs → audience_exhausted
const STALE_LOCK_MINUTES = 30;
const DEFAULT_FIT_THRESHOLD = 50;

const STATE_NAMES = {
  AL: 'Alabama', AR: 'Arkansas', FL: 'Florida', GA: 'Georgia', KY: 'Kentucky',
  LA: 'Louisiana', MS: 'Mississippi', NC: 'North Carolina', SC: 'South Carolina',
  TN: 'Tennessee', VA: 'Virginia', TX: 'Texas', CO: 'Colorado', IL: 'Illinois',
  NY: 'New York', CA: 'California', OH: 'Ohio', PA: 'Pennsylvania',
  MO: 'Missouri', OK: 'Oklahoma', WV: 'West Virginia', IN: 'Indiana',
};
function stateName(abbr) { return STATE_NAMES[abbr] || abbr; }

function safeArray(v) { return Array.isArray(v) ? v : []; }
function normalizeState(v) { return v ? String(v).trim().toUpperCase() : null; }

function hasLiveWebsite(candidate) {
  const val = candidate.website;
  if (!val) return false;
  const s = String(val).trim().toLowerCase();
  if (!s) return false;
  const directoryPatterns = [
    'facebook.com', 'yelp.com', 'nextdoor.com', 'maps.google', 'g.page',
    'google.com/maps', 'bbb.org', 'angi.com', 'thumbtack.com', 'linkedin.com',
    'instagram.com', 'tiktok.com', 'yellowpages.com', 'manta.com',
  ];
  if (directoryPatterns.some((p) => s.includes(p))) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested via _internals)
// ---------------------------------------------------------------------------

/** Clamp the daily batch cap to the spec'd 1..25 window (default 25). */
function clampDailyCap(n) {
  const v = Number(n);
  if (!Number.isInteger(v) || v < 1) return 25;
  return Math.min(v, 25);
}

/**
 * Build a BOUNDED set of campaign discovery queries (industries × states),
 * shaped by the campaign's website_rule, capped to maxSerperCalls. dayOffset
 * rotates the starting pair so consecutive runs cover the full grid.
 */
function buildCampaignQueries(audience, maxSerperCalls, dayOffset = 0) {
  const industries = safeArray(audience.industries);
  const states = safeArray(audience.states).map(normalizeState).filter(Boolean);
  const rule = audience.website_rule || 'no_website';
  const pairs = [];
  for (const ind of industries) for (const st of states) pairs.push({ ind, st });
  if (pairs.length === 0 || maxSerperCalls <= 0) return [];

  const start = ((dayOffset % pairs.length) + pairs.length) % pairs.length;
  const ordered = pairs.slice(start).concat(pairs.slice(0, start));

  const queries = [];
  for (const { ind, st } of ordered) {
    const n = stateName(st);
    if (rule === 'no_website') {
      queries.push(`"${ind}" owner-operated ${n} "no website"`);
      queries.push(`small ${ind} business ${n} site:facebook.com`);
    } else {
      queries.push(`small ${ind} business ${n} owner-operated`);
      queries.push(`"${ind}" ${n} local business contact`);
    }
    if (queries.length >= maxSerperCalls) break;
  }
  return queries.slice(0, maxSerperCalls);
}

/**
 * Campaign-fit score — SEPARATE from the general qualification score.
 * Measures how well a candidate matches THIS campaign's audience rules.
 */
function campaignFitScore(candidate, audience) {
  let score = 0;
  const states = safeArray(audience.states).map(normalizeState);
  const industries = safeArray(audience.industries).map((i) => String(i).toLowerCase());
  const empMin = audience.employee_min != null ? Number(audience.employee_min) : 1;
  const empMax = audience.employee_max != null ? Number(audience.employee_max) : 5;
  const rule = audience.website_rule || 'no_website';

  const st = normalizeState(candidate.state);
  if (st && states.includes(st)) score += 25;
  else if (st) score -= 40; // wrong state is near-disqualifying for a targeted campaign

  const ind = String(candidate.industry || '').toLowerCase();
  if (ind && industries.includes(ind)) score += 25;
  else if (ind) score -= 20;

  const employees = Number(candidate.employee_count);
  if (Number.isFinite(employees) && employees >= empMin && employees <= empMax) score += 20;
  else if (!Number.isFinite(employees)) score += 8;
  else score -= 15;

  const hasSite = hasLiveWebsite(candidate);
  if (rule === 'no_website') {
    if (!hasSite) score += 15; else score -= 100;
  } else if (rule === 'require_website') {
    if (hasSite) score += 15; else score -= 100;
  } // allow_any: neutral

  if (candidate.phone) score += 8;
  if (candidate.facebook_url) score += 5;
  if (candidate.contact_name) score += 5;

  const kws = safeArray(audience.excluded_keywords).map((k) => String(k).toLowerCase());
  if (kws.length) {
    const hay = [candidate.company, candidate.industry, candidate.reason, candidate.website]
      .filter(Boolean).join(' ').toLowerCase();
    if (kws.some((k) => hay.includes(k))) score -= 100;
  }
  return score;
}

/**
 * Contact status from enrichment result:
 * email → outreach_ready_email; FB only → fb_dm_ready; neither → not_ready.
 * (email OR usable FB page = outreach-ready per spec.)
 */
function contactStatusFor(enriched) {
  if (enriched.contact_email) return 'outreach_ready_email';
  if (enriched.facebook_url) return 'fb_dm_ready';
  return 'not_ready';
}

/** Round-robin: pick the approved variant with the fewest assignments. */
function pickVariant(variants) {
  const approved = safeArray(variants).filter((v) => v.status === 'approved');
  if (!approved.length) return null;
  return approved.reduce((min, v) =>
    ((v.assigned_count || 0) < (min.assigned_count || 0) ? v : min), approved[0]);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Discovery (Serper + Claude) — mirrors prospecting.js patterns, but with the
// campaign's own audience rules (campaigns MAY allow functional websites).
// ---------------------------------------------------------------------------

async function searchSerper(query, num = 10) {
  const { withRetry } = require('../../integrations/_retry');
  const response = await withRetry(
    () => axios.post(
      'https://google.serper.dev/search',
      { q: query, num, gl: 'us', hl: 'en' },
      {
        headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' },
        timeout: 30000,
      }
    ),
    {
      attempts: 2, // bounded retries (max 2 attempts beyond none — spec: max 2 retries)
      onRetry: (err, attempt, delayMs) =>
        console.warn(`[targeted-campaign] Serper retry ${attempt} in ${delayMs}ms: ${err.message}`),
    }
  );
  return response.data || {};
}

async function extractCandidatesWithClaude(searchPayload, campaign, tenant) {
  const aud = campaign.audience || {};
  const rule = aud.website_rule || 'no_website';
  const empMin = aud.employee_min != null ? Number(aud.employee_min) : 1;
  const empMax = aud.employee_max != null ? Number(aud.employee_max) : 5;
  const websiteRuleText = rule === 'no_website'
    ? `- NO live company website. Facebook pages, Yelp, Google Business Profile,
  Angi, Thumbtack, directories DON'T count as a website (still eligible).
  If a business obviously has a real company website, DO NOT include it.`
    : rule === 'require_website'
      ? '- MUST have its own live company website (not just social/directory pages).'
      : '- A website is fine but NOT required — include businesses with or without one.';

  const systemPrompt = 'You extract structured prospecting candidates from web search results. Return ONLY valid JSON.';
  const userPrompt = `
You are a prospecting scout for a targeted outreach campaign:
"${campaign.name}" — ${(campaign.opportunity || {}).description || ''}

ICP (all must hold):
- ${empMin}-${empMax} employees (owner-operated micro-business). If the exact
  count isn't visible, estimate from signals and set "employee_count": null
  with "size_estimated": true rather than rejecting.
${websiteRuleText}
- Based in one of these states: ${safeArray(aud.states).join(', ')}
- Industries: ${safeArray(aud.industries).join(', ')}
- Excluded keywords: ${safeArray(aud.excluded_keywords).join(', ') || '(none)'}
- No franchises / chains / multi-state operators / national lead-gen sites.

Return JSON:
{
  "candidates": [
    {
      "company": "string",
      "website": "string or null",
      "industry": "string — one of the target industries above",
      "state": "2-letter abbreviation or null",
      "city": "string or null",
      "employee_count": 2,
      "size_estimated": false,
      "facebook_url": "string or null",
      "phone": "string or null",
      "address": "string or null",
      "contact_name": "string or null",
      "reason": "short explanation",
      "confidence": 0.0,
      "source_urls": ["https://..."]
    }
  ]
}

Rules: confidence 0-1; JSON only.

Search results:
${JSON.stringify(searchPayload)}
`;
  const result = await askClaudeJSON(systemPrompt, userPrompt, {
    maxTokens: 4000,
    tenantSlug: tenant.slug,
  });
  return safeArray(result.candidates);
}

// ---------------------------------------------------------------------------
// Lead shell + dedup (shared leads table is the source of truth)
// ---------------------------------------------------------------------------

async function findExistingLead(tenantId, candidate) {
  const { data: byName } = await db
    .from('leads').select('id, metadata, email, lifecycle_stage')
    .eq('tenant_id', tenantId).eq('company_name', candidate.company).maybeSingle();
  if (byName) return byName;
  if (candidate.website) {
    const domain = String(candidate.website)
      .replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
    const { data: byDomain } = await db
      .from('leads').select('id, metadata, email, lifecycle_stage')
      .eq('tenant_id', tenantId).eq('domain', domain).maybeSingle();
    if (byDomain) return byDomain;
  }
  if (candidate.phone) {
    const { data: byPhone } = await db
      .from('leads').select('id, metadata, email, lifecycle_stage')
      .eq('tenant_id', tenantId).eq('phone', candidate.phone).maybeSingle();
    if (byPhone) return byPhone;
  }
  return null;
}

async function insertLeadShell(tenantId, campaign, candidate, fitScore) {
  const domain = candidate.website
    ? String(candidate.website).replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]
    : null;
  let city = candidate.city || null;
  if (!city && candidate.address) {
    const m = String(candidate.address).match(/^([^,]+),\s*[A-Z]{2}/);
    if (m) city = m[1].trim();
  }
  const { data, error } = await db
    .from('leads')
    .insert({
      tenant_id: tenantId,
      name: candidate.contact_name || candidate.company,
      company_name: candidate.company,
      industry: candidate.industry || null,
      service_type: candidate.industry || null,
      size: null,
      employee_count_actual: candidate.employee_count || null,
      website: candidate.website || null,
      domain,
      phone: sanitizePhone(candidate.phone),
      address: candidate.address || null,
      city,
      hq_state: normalizeState(candidate.state),
      status: 'new_lead',
      lifecycle_stage: 'prospect',
      lead_source: 'targeted_campaign_agent',
      enrichment_status: 'pending',
      metadata: {
        campaign_id: campaign.id,
        campaign_name: campaign.name,
        campaign_fit_score: fitScore,
        reason: candidate.reason || null,
        source_urls: candidate.source_urls || [],
        confidence: candidate.confidence || null,
        facebook_url: candidate.facebook_url || null,
        owner_name: candidate.contact_name || null,
        size_estimated: !!candidate.size_estimated || !Number.isFinite(Number(candidate.employee_count)),
        address: candidate.address || null,
      },
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ---------------------------------------------------------------------------
// Draft creation — REUSES outreach_sequences + conversations so the existing
// Pipeline approval queue / sendEmailOutreachSequence / drip / manual FB DM
// panel all work unchanged. Email is auto-sendable after approval; FB DM is
// ALWAYS manual (never auto-sent).
// ---------------------------------------------------------------------------

async function createDraftsForLead(tenant, campaign, lead, variant, enriched) {
  const ctx = tc.leadTemplateContext({
    company: lead.company_name,
    contact_name: enriched.extracted?.owner_name || lead.metadata?.owner_name,
    city: lead.city,
    state: lead.hq_state,
    industry: lead.industry,
  });

  const { data: contacts } = await db
    .from('contacts').select('id, email, is_primary_contact')
    .eq('tenant_id', tenant.id).eq('lead_id', lead.id)
    .order('is_primary_contact', { ascending: false }).limit(3);
  const emailContact = (contacts || []).find((c) => c.email) || null;
  const contactId = emailContact?.id || (contacts && contacts[0]?.id) || null;

  const created = { email_sequence_id: null, fb_sequence_id: null };
  const signature = buildSignatureBlock(tenant);

  if (enriched.contact_email) {
    const subject = tc.renderTemplate(variant.email_subject, ctx);
    const bodyPlain = `${tc.renderTemplate(variant.email_body, ctx)}\n\n${signature}`;
    const bodyHtml = escapeHtml(bodyPlain).replace(/\n/g, '<br>');
    const { data: seq, error: seqErr } = await db.from('outreach_sequences').insert({
      tenant_id: tenant.id,
      lead_id: lead.id,
      contact_id: emailContact?.id || contactId,
      sequence_name: `Targeted: ${campaign.name} (Variant ${variant.label})`,
      sequence_type: 'email',
      sequence_status: 'draft',
      step_number: 1,
      message_subject: subject,
      message_body: bodyPlain,
      metadata: { campaign_id: campaign.id, variant_id: variant.id, variant_label: variant.label },
    }).select().single();
    if (seqErr) throw seqErr;
    created.email_sequence_id = seq.id;
    await db.from('conversations').insert({
      tenant_id: tenant.id,
      lead_id: lead.id,
      contact_id: emailContact?.id || contactId,
      sequence_id: seq.id,
      channel: 'email',
      direction: 'outbound',
      message_subject: subject,
      message_body: bodyPlain,
      metadata: {
        channel: 'email',
        body_html: bodyHtml,
        draft_status: 'awaiting_approval',
        generated_at: new Date().toISOString(),
        campaign_id: campaign.id,
        variant_label: variant.label,
      },
    });
  }

  if (enriched.facebook_url && variant.fb_dm_body) {
    const dmBody = tc.renderTemplate(variant.fb_dm_body, ctx);
    const { data: seq, error: seqErr } = await db.from('outreach_sequences').insert({
      tenant_id: tenant.id,
      lead_id: lead.id,
      contact_id: contactId,
      sequence_name: `Targeted: ${campaign.name} (Variant ${variant.label})`,
      sequence_type: 'facebook_dm',
      sequence_status: 'draft',
      step_number: 1,
      message_subject: null,
      message_body: dmBody,
      metadata: { campaign_id: campaign.id, variant_id: variant.id, variant_label: variant.label },
    }).select().single();
    if (seqErr) throw seqErr;
    created.fb_sequence_id = seq.id;
    await db.from('conversations').insert({
      tenant_id: tenant.id,
      lead_id: lead.id,
      contact_id: contactId,
      sequence_id: seq.id,
      channel: 'facebook_dm',
      direction: 'outbound',
      message_subject: null,
      message_body: dmBody,
      metadata: {
        channel: 'facebook_dm',
        facebook_url: enriched.facebook_url,
        draft_status: 'awaiting_approval',
        generated_at: new Date().toISOString(),
        campaign_id: campaign.id,
        variant_label: variant.label,
      },
    });
  }

  // Advance past the standard outreach agent's scan window ('enriched'/'scored').
  await db.from('leads')
    .update({ lifecycle_stage: 'sequenced', updated_at: new Date().toISOString() })
    .eq('id', lead.id).eq('tenant_id', tenant.id);

  return created;
}

// ---------------------------------------------------------------------------
// Run lock
// ---------------------------------------------------------------------------

async function claimRunLock(campaignId, runId) {
  // Clear stale locks first (>30 min — a crashed run never released).
  const staleBefore = new Date(Date.now() - STALE_LOCK_MINUTES * 60 * 1000).toISOString();
  await db.from('targeted_campaigns')
    .update({ active_run_id: null, active_run_started_at: null })
    .eq('id', campaignId)
    .not('active_run_id', 'is', null)
    .lt('active_run_started_at', staleBefore);

  const { data, error } = await db.from('targeted_campaigns')
    .update({ active_run_id: runId, active_run_started_at: new Date().toISOString() })
    .eq('id', campaignId)
    .is('active_run_id', null)
    .select('id')
    .maybeSingle();
  if (error) return false;
  return !!data;
}

async function releaseRunLock(campaignId, runId) {
  await db.from('targeted_campaigns')
    .update({ active_run_id: null, active_run_started_at: null })
    .eq('id', campaignId)
    .eq('active_run_id', runId);
}

// ---------------------------------------------------------------------------
// Batch resolution
// ---------------------------------------------------------------------------

function etToday() {
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, '0')}-${String(et.getDate()).padStart(2, '0')}`;
}

async function resolveBatch(campaign) {
  // Pilot phase: continue an open pilot batch or create one.
  if (campaign.status === 'pilot_running' || campaign.status === 'ready_for_pilot') {
    const { data: openPilot } = await db.from('targeted_campaign_batches')
      .select('*').eq('campaign_id', campaign.id)
      .eq('batch_type', 'pilot').eq('status', 'running')
      .maybeSingle();
    if (openPilot) return { batch: openPilot, batchType: 'pilot' };
    const { data: nextNum } = await db.from('targeted_campaign_batches')
      .select('batch_number').eq('campaign_id', campaign.id)
      .order('batch_number', { ascending: false }).limit(1).maybeSingle();
    const { data: batch, error } = await db.from('targeted_campaign_batches').insert({
      tenant_id: campaign.tenant_id,
      campaign_id: campaign.id,
      batch_number: (nextNum?.batch_number || 0) + 1,
      batch_type: 'pilot',
      batch_date: etToday(),
      target_count: campaign.pilot_size,
      status: 'running',
    }).select().single();
    if (error) throw error;
    return { batch, batchType: 'pilot' };
  }

  // Daily phase: one batch per ET day (partial unique index enforces).
  const today = etToday();
  const { data: todays } = await db.from('targeted_campaign_batches')
    .select('*').eq('campaign_id', campaign.id)
    .eq('batch_type', 'daily').eq('batch_date', today)
    .maybeSingle();
  if (todays) {
    if (todays.status !== 'running') return { batch: null, batchType: 'daily', reason: 'daily_batch_done' };
    return { batch: todays, batchType: 'daily' };
  }
  const { data: nextNum } = await db.from('targeted_campaign_batches')
    .select('batch_number').eq('campaign_id', campaign.id)
    .order('batch_number', { ascending: false }).limit(1).maybeSingle();
  const remaining = Math.max(0, campaign.goal_qualified - campaign.qualified_count);
  const target = Math.min(clampDailyCap(campaign.daily_batch_cap), remaining);
  const { data: batch, error } = await db.from('targeted_campaign_batches').insert({
    tenant_id: campaign.tenant_id,
    campaign_id: campaign.id,
    batch_number: (nextNum?.batch_number || 0) + 1,
    batch_type: 'daily',
    batch_date: today,
    target_count: target,
    status: 'running',
  }).select().single();
  if (error) {
    if (String(error.message || '').includes('uq_tc_batches_daily_per_day')) {
      return { batch: null, batchType: 'daily', reason: 'daily_batch_done' };
    }
    throw error;
  }
  return { batch, batchType: 'daily' };
}

// ---------------------------------------------------------------------------
// Per-campaign execution
// ---------------------------------------------------------------------------

async function runCampaign(tenant, campaign, log, payload = {}) {
  // ── Pre-flight (NO paid calls yet) ──────────────────────────────────
  if (!tc.isExecutable(campaign.status)) {
    return { campaign_id: campaign.id, skipped: true, reason: `status_${campaign.status}` };
  }
  if (campaign.kill_switch) {
    return { campaign_id: campaign.id, skipped: true, reason: 'campaign_kill_switch' };
  }
  if (tc.isGloballyKilled(tenant)) {
    return { campaign_id: campaign.id, skipped: true, reason: 'global_kill_switch' };
  }
  const limitHit = tc.checkCampaignLimits(campaign);
  if (limitHit) {
    const r = await tc.transitionCampaign(campaign.id, campaign.status, limitHit.status, {
      actor: 'agent', detail: { limit: limitHit.limit },
    });
    if (r.success) {
      await tc.notifyCampaign(tenant.id, campaign.id, {
        title: `Campaign "${campaign.name}": ${tc.STATUS_LABELS[limitHit.status]}`,
        message: limitHit.limit === 'goal'
          ? `Lead goal of ${campaign.goal_qualified} reached — campaign completed.`
          : `The ${limitHit.limit} limit was reached. The campaign stopped and will not spend further until you adjust limits and resume.`,
        priority: 'high',
      });
    }
    return { campaign_id: campaign.id, skipped: true, reason: `limit_${limitHit.limit}` };
  }

  // ── Create run row + claim lock ─────────────────────────────────────
  const runType = (campaign.status === 'ready_for_pilot' || campaign.status === 'pilot_running') ? 'pilot' : 'daily';
  const { data: runRow, error: runErr } = await db.from('targeted_campaign_runs').insert({
    tenant_id: tenant.id, campaign_id: campaign.id, run_type: runType, status: 'running',
  }).select().single();
  if (runErr) throw runErr;

  const locked = await claimRunLock(campaign.id, runRow.id);
  if (!locked) {
    await db.from('targeted_campaign_runs')
      .update({ status: 'completed', stop_reason: 'lock_held', finished_at: new Date().toISOString() })
      .eq('id', runRow.id);
    return { campaign_id: campaign.id, skipped: true, reason: 'run_lock_held' };
  }

  const usage = { serper: 0, anthropic: 0, apify: 0 };
  let stopReason = 'exhausted_candidates';
  let newQualified = 0;
  let newEmailReady = 0;
  let newFbReady = 0;
  let processedCount = 0;
  let linkedExisting = 0;
  const processed = [];
  const errors = [];

  try {
    // Status transitions at run start.
    if (campaign.status === 'ready_for_pilot') {
      const r = await tc.transitionCampaign(campaign.id, 'ready_for_pilot', 'pilot_running', { actor: 'agent' });
      if (!r.success) throw new Error(`could not start pilot: ${r.error}`);
      campaign = r.campaign;
    } else if (campaign.status === 'approved_to_continue') {
      const r = await tc.transitionCampaign(campaign.id, 'approved_to_continue', 'active', { actor: 'agent' });
      if (!r.success) throw new Error(`could not activate: ${r.error}`);
      campaign = r.campaign;
    }

    const { batch, batchType, reason } = await resolveBatch(campaign);
    if (!batch) {
      stopReason = reason || 'no_batch';
      await db.from('targeted_campaign_runs')
        .update({ status: 'completed', stop_reason: stopReason, finished_at: new Date().toISOString() })
        .eq('id', runRow.id);
      return { campaign_id: campaign.id, skipped: true, reason: stopReason };
    }
    await db.from('targeted_campaign_runs').update({ batch_id: batch.id }).eq('id', runRow.id);

    const batchRemaining = Math.max(0, batch.target_count - batch.qualified_count);
    const goalRemaining = Math.max(0, campaign.goal_qualified - campaign.qualified_count);
    const needed = Math.min(batchRemaining, goalRemaining);
    if (needed === 0) {
      stopReason = goalRemaining === 0 ? 'goal_reached' : 'batch_target_met';
    } else {
      // ── Discovery (paid calls start here) ───────────────────────────
      const budget = campaign.budget || {};
      const serperBudgetLeft = budget.max_serper_calls != null
        ? Math.max(0, Number(budget.max_serper_calls) - campaign.serper_calls_used)
        : Infinity;
      const maxSerper = Math.min(
        Number(payload.max_serper_calls || DEFAULT_MAX_SERPER_CALLS_PER_RUN),
        serperBudgetLeft
      );
      const dayOffset = Math.floor(Date.now() / 86400000) + (batch.batch_number || 0);
      const queries = buildCampaignQueries(campaign.audience || {}, maxSerper, dayOffset);
      log.info(`[${campaign.name}] ${batchType} batch #${batch.batch_number}: need ${needed}, ${queries.length} Serper queries (cap ${maxSerper})`);

      const allResults = [];
      for (const q of queries) {
        try {
          const d = await searchSerper(q, 10);
          usage.serper++;
          allResults.push({ query: q, organic: d.organic || [], places: d.places || [] });
        } catch (err) {
          usage.serper++;
          log.warn(`[${campaign.name}] Serper failed: ${q}`, { error: err.message });
        }
      }

      let candidates = [];
      if (allResults.length) {
        candidates = await extractCandidatesWithClaude({ results: allResults }, campaign, tenant);
        usage.anthropic++;
      }

      const threshold = Number((campaign.qualification || {}).fit_score_threshold) || DEFAULT_FIT_THRESHOLD;
      const scored = candidates
        .filter((c) => c && c.company)
        .map((c) => ({ candidate: c, fit: campaignFitScore(c, campaign.audience || {}) }))
        .filter((s) => s.fit >= threshold)
        .sort((a, b) => b.fit - a.fit);
      log.info(`[${campaign.name}] ${candidates.length} raw → ${scored.length} ≥ fit threshold ${threshold}`);

      // Load approved variants once (round-robin assignment per qualified lead).
      const { data: variants } = await db.from('targeted_campaign_variants')
        .select('*').eq('campaign_id', campaign.id).eq('status', 'approved');

      const maxCandidates = Number(payload.max_candidates || DEFAULT_MAX_CANDIDATES_PER_RUN);

      for (const { candidate, fit } of scored) {
        if (newQualified >= needed) { stopReason = goalRemaining - newQualified <= 0 ? 'goal_reached' : 'batch_target_met'; break; }
        if (processedCount >= maxCandidates) { stopReason = 'candidate_cap'; break; }
        // Hard AI/Apify budget re-check mid-run.
        const liveLimits = tc.checkCampaignLimits({
          ...campaign,
          qualified_count: campaign.qualified_count + newQualified,
          serper_calls_used: campaign.serper_calls_used + usage.serper,
          ai_calls_used: campaign.ai_calls_used + usage.anthropic,
          apify_calls_used: campaign.apify_calls_used + usage.apify,
        });
        if (liveLimits) { stopReason = `limit_${liveLimits.limit}`; break; }

        try {
          const key = tc.candidateKey(campaign.id, candidate);
          const { data: existingMember } = await db.from('targeted_campaign_memberships')
            .select('id').eq('campaign_id', campaign.id).eq('candidate_key', key).maybeSingle();
          if (existingMember) {
            processed.push({ company: candidate.company, action: 'already_in_campaign' });
            continue;
          }

          const existingLead = await findExistingLead(tenant.id, candidate);
          if (existingLead) {
            // LINK — never duplicate the lead record, never re-enrich,
            // never draft (it may already be in another flow).
            const md = existingLead.metadata || {};
            const cs = (existingLead.email || (Array.isArray(md.contact_channels_found) && md.contact_channels_found.includes('email')))
              ? 'outreach_ready_email'
              : (md.facebook_url ? 'fb_dm_ready' : 'not_ready');
            const { error: memErr } = await db.from('targeted_campaign_memberships').insert({
              tenant_id: tenant.id, campaign_id: campaign.id, lead_id: existingLead.id,
              batch_id: batch.id, run_id: runRow.id, candidate_key: key,
              campaign_version: campaign.current_version, campaign_fit_score: fit,
              contact_status: cs, is_existing_lead: true,
              outcome: { linked_reason: 'existing_lead' },
            });
            if (!memErr) linkedExisting++;
            processed.push({ company: candidate.company, action: 'linked_existing', lead_id: existingLead.id });
            continue;
          }

          // New business: shell → shared enrichment → drafts.
          const lead = await insertLeadShell(tenant.id, campaign, candidate, fit);
          processedCount++;
          const enriched = await enrichment.enrichOne(tenant, lead);
          usage.anthropic++; // enrichOne makes ~1 Claude call (estimate)
          if (candidate.facebook_url || enriched.facebook_url) usage.apify++; // FB scrape estimate

          const cs = contactStatusFor(enriched);
          const isReady = cs !== 'not_ready';
          let outcome = { enrich_reason: enriched.reason };
          let variantId = null;

          if (isReady) {
            const variant = pickVariant(variants);
            if (variant) {
              const drafts = await createDraftsForLead(tenant, campaign, lead, variant, enriched);
              outcome = { ...outcome, ...drafts };
              variantId = variant.id;
              variant.assigned_count = (variant.assigned_count || 0) + 1;
              await db.from('targeted_campaign_variants')
                .update({ assigned_count: variant.assigned_count }).eq('id', variant.id);
            }
            newQualified++;
            if (cs === 'outreach_ready_email') newEmailReady++; else newFbReady++;
          }

          await db.from('targeted_campaign_memberships').insert({
            tenant_id: tenant.id, campaign_id: campaign.id, lead_id: lead.id,
            batch_id: batch.id, run_id: runRow.id, variant_id: variantId,
            candidate_key: key, campaign_version: campaign.current_version,
            campaign_fit_score: fit,
            general_score: lead.metadata?.prospect_score || null,
            contact_status: cs, is_existing_lead: false, outcome,
          });
          processed.push({ company: candidate.company, action: isReady ? 'QUALIFIED' : 'not_ready', fit, contact_status: cs, lead_id: lead.id });
        } catch (err) {
          log.error(`[${campaign.name}] candidate failed: ${candidate.company}`, err);
          errors.push({ company: candidate.company || null, error: err.message });
        }
      }
    }

    // ── Persist counters (single locked run — safe read-modify-write) ──
    const zeroYield = newQualified === 0 && linkedExisting === 0 && stopReason === 'exhausted_candidates';
    const newStreak = zeroYield ? (campaign.zero_yield_streak || 0) + 1 : 0;
    await db.from('targeted_campaigns').update({
      qualified_count: campaign.qualified_count + newQualified,
      outreach_ready_email_count: campaign.outreach_ready_email_count + newEmailReady,
      fb_dm_ready_count: campaign.fb_dm_ready_count + newFbReady,
      candidates_processed: campaign.candidates_processed + processedCount,
      serper_calls_used: campaign.serper_calls_used + usage.serper,
      ai_calls_used: campaign.ai_calls_used + usage.anthropic,
      apify_calls_used: campaign.apify_calls_used + usage.apify,
      zero_yield_streak: newStreak,
      updated_at: new Date().toISOString(),
    }).eq('id', campaign.id);

    // Usage ledger rows (append-only).
    const usageRows = Object.entries(usage)
      .filter(([, calls]) => calls > 0)
      .map(([provider, calls]) => ({
        tenant_id: tenant.id, campaign_id: campaign.id, run_id: runRow.id, provider, calls,
      }));
    if (usageRows.length) await db.from('targeted_campaign_usage').insert(usageRows);

    // Batch bookkeeping (this locked run is the only writer, so the batch row
    // we loaded via resolveBatch is current).
    const batchQualifiedNow = batch.qualified_count + newQualified;
    const batchDone = batchType === 'daily' || batchQualifiedNow >= batch.target_count
      || stopReason === 'goal_reached' || newStreak >= ZERO_YIELD_LIMIT;
    await db.from('targeted_campaign_batches').update({
      qualified_count: batchQualifiedNow,
      status: batchDone ? 'completed' : 'running',
      finished_at: batchDone ? new Date().toISOString() : null,
      stats: {
        last_run_id: runRow.id, stop_reason: stopReason,
        candidates_processed: processedCount, linked_existing: linkedExisting,
        errors: errors.length, usage,
      },
    }).eq('id', batch.id);

    // ── Post-run status transitions + notifications ────────────────────
    const { data: freshCamp } = await db.from('targeted_campaigns').select('*').eq('id', campaign.id).single();

    if (batchType === 'pilot' && batchDone && freshCamp.status === 'pilot_running') {
      const r = await tc.transitionCampaign(campaign.id, 'pilot_running', 'pilot_awaiting_approval', {
        actor: 'agent', detail: { batch_id: batch.id, qualified: batchQualifiedNow },
      });
      if (r.success) {
        await tc.notifyCampaign(tenant.id, campaign.id, {
          title: `Pilot complete: "${campaign.name}"`,
          message: `The pilot batch produced ${batchQualifiedNow} outreach-ready prospects. Review the results and approve to continue, or stop the campaign.`,
          priority: 'high',
        });
      }
    } else if (newStreak >= ZERO_YIELD_LIMIT && tc.isExecutable(freshCamp.status)) {
      const r = await tc.transitionCampaign(campaign.id, freshCamp.status, 'audience_exhausted', {
        actor: 'agent', detail: { zero_yield_streak: newStreak },
      });
      if (r.success) {
        await tc.notifyCampaign(tenant.id, campaign.id, {
          title: `Audience exhausted: "${campaign.name}"`,
          message: `${newStreak} consecutive runs found no new qualifying businesses. The campaign stopped at ${freshCamp.qualified_count}/${freshCamp.goal_qualified}. Broaden the audience or complete the campaign.`,
          priority: 'high',
        });
      }
    } else {
      const postLimits = tc.checkCampaignLimits(freshCamp);
      if (postLimits && tc.isExecutable(freshCamp.status)) {
        const r = await tc.transitionCampaign(campaign.id, freshCamp.status, postLimits.status, {
          actor: 'agent', detail: { limit: postLimits.limit },
        });
        if (r.success) {
          await tc.notifyCampaign(tenant.id, campaign.id, {
            title: `Campaign "${campaign.name}": ${tc.STATUS_LABELS[postLimits.status]}`,
            message: postLimits.limit === 'goal'
              ? `Lead goal of ${freshCamp.goal_qualified} reached — campaign completed with ${freshCamp.qualified_count} outreach-ready prospects.`
              : `The ${postLimits.limit} limit was reached after this run. The campaign will not spend further until you adjust limits and resume.`,
            priority: 'high',
          });
        }
      }
    }

    const stats = {
      batch_id: batch.id, batch_type: batchType,
      new_qualified: newQualified, email_ready: newEmailReady, fb_dm_ready: newFbReady,
      candidates_processed: processedCount, linked_existing: linkedExisting,
      usage, errors: errors.length,
    };
    await db.from('targeted_campaign_runs').update({
      status: 'completed', stop_reason: stopReason, stats,
      finished_at: new Date().toISOString(),
    }).eq('id', runRow.id);
    await tc.logCampaignActivity(tenant.id, campaign.id, 'agent', 'run_completed', { run_id: runRow.id, ...stats, stop_reason: stopReason });

    return {
      campaign_id: campaign.id, campaign_name: campaign.name,
      run_id: runRow.id, stop_reason: stopReason, ...stats, processed,
    };
  } catch (err) {
    await db.from('targeted_campaign_runs').update({
      status: 'failed', error: err.message, finished_at: new Date().toISOString(),
    }).eq('id', runRow.id);
    await tc.logCampaignActivity(tenant.id, campaign.id, 'agent', 'run_failed', { run_id: runRow.id, error: err.message });
    throw err;
  } finally {
    await releaseRunLock(campaign.id, runRow.id);
  }
}

// ---------------------------------------------------------------------------
// MAIN AGENT
// ---------------------------------------------------------------------------

/**
 * @param {Object} tenant
 * @param {Object} payload - { campaign_id?, max_serper_calls?, max_candidates? }
 */
async function run(tenant, payload = {}) {
  const log = createLogger('targeted-campaign', tenant.slug);

  // Global kill — affects ONLY this agent, never the standard one.
  if (tc.isGloballyKilled(tenant)) {
    log.info('Global targeted-campaign kill switch is ON — idle');
    return { success: true, skipped: true, reason: 'global_kill_switch', campaigns: [] };
  }

  let query = db.from('targeted_campaigns').select('*').eq('tenant_id', tenant.id);
  if (payload.campaign_id) {
    query = query.eq('id', payload.campaign_id);
  } else {
    query = query.in('status', tc.EXECUTABLE_STATUSES).eq('kill_switch', false);
  }
  const { data: campaigns, error } = await query;
  if (error) throw error;

  if (!campaigns || campaigns.length === 0) {
    // Idle: zero paid API calls were made.
    log.info('No executable campaigns — idle (0 API calls)');
    return { success: true, idle: true, campaigns: [], message: 'No executable campaigns' };
  }

  if (!process.env.SERPER_API_KEY) throw new Error('SERPER_API_KEY is required');
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is required');

  const results = [];
  for (const campaign of campaigns) {
    try {
      results.push(await runCampaign(tenant, campaign, log, payload));
    } catch (err) {
      log.error(`Campaign run failed: ${campaign.name}`, err);
      results.push({ campaign_id: campaign.id, success: false, error: err.message });
    }
  }

  const summary = {
    success: true,
    campaigns_run: results.filter((r) => !r.skipped && !r.error).length,
    campaigns_skipped: results.filter((r) => r.skipped).length,
    total_new_qualified: results.reduce((s, r) => s + (r.new_qualified || 0), 0),
    results,
  };
  log.success('Targeted campaign agent complete', {
    campaigns_run: summary.campaigns_run,
    total_new_qualified: summary.total_new_qualified,
  });
  return summary;
}

module.exports = run;
// Pure helpers exposed for unit tests (no DB / no network).
module.exports._internals = {
  buildCampaignQueries,
  campaignFitScore,
  contactStatusFor,
  pickVariant,
  clampDailyCap,
  hasLiveWebsite,
  escapeHtml,
  etToday,
  DEFAULT_MAX_SERPER_CALLS_PER_RUN,
  DEFAULT_MAX_CANDIDATES_PER_RUN,
  ZERO_YIELD_LIMIT,
  DEFAULT_FIT_THRESHOLD,
};
