/**
 * Growth OS — Lead Scoring Agent
 * Scores enriched leads against tenant ICP config.
 *
 * Multi-tenant: reads ICP parameters from tenant_config via getConfig().
 * Uses `leads` table (not legacy `clients`), tenant-scoped.
 *
 * 100-point scoring: size(30) + industry(20) + geography(15) + growth(15) + benefits(10) + contact quality(10)
 */

const { createLogger } = require('../../core/logger');
const { getConfig, FGA_TENANT_ID } = require('../../core/config');
const { db } = require('../../db/client');
const { claudeHaiku } = require('../../integrations/claude');
const { evaluateEmployeeFit, ICP_VERSION } = require('../../core/growth/eligibility');
const { automatedContactAllowed } = require('../../core/growth/intake-safety');
const { PROSPECT_SOURCES, isProspectSource } = require('../../core/lead-sources');
const { fgaLifecycleAfterResearch } = require('../../core/growth/lifecycle');
const { enqueueFgaOutreachHandoffs } = require('../../core/growth/handoffs');
const { DATABASE_FIRST_CUTOFF } = require('../../core/growth/seven-touch-plan');
const { NEVER_RESTART_STATUSES } = require('../../core/growth/restart-policy');
const SCORE_VERSION = 'size-first-reachable-v4';
const SCORE_VERSION_PATH = 'metadata->score_breakdown->>score_version';
const SCORE_UPGRADE_SCAN_LIMIT = 1000;
const FGA_SCORE_UPGRADE_SHARE = 0.75;

const EMPLOYEE_SEGMENT_PRIORITY = Object.freeze({
  verified_sweet_spot_1_9: 4000,
  estimated_sweet_spot_1_9: 3500,
  verified_small_business_10_19: 3000,
  estimated_small_business_10_19: 2500,
});
const FGA_NEVER_READY_LIFECYCLES = new Set(['customer', 'unqualified']);

// ============================================================================
// HELPERS
// ============================================================================

function safeArray(v) {
  return Array.isArray(v) ? v : [];
}

function resolveScoringThresholds(tenant, strictMicroBusiness) {
  const scoringRules = getConfig(tenant, 'scoring_rules', { tier_a: 70, tier_b: 50 });
  return {
    // FGA qualification, restart, and provider-dispatch gates must describe
    // the same cohort. The SaaS preset's generic Tier-A value is intentionally
    // retained for customer tenants but cannot override FGA's send threshold.
    tierAThreshold: strictMicroBusiness
      ? Number(getConfig(tenant, 'autosend_score_threshold', 60))
      : Number(scoringRules.tier_a || 70),
    tierBThreshold: Number(scoringRules.tier_b || 50),
  };
}

function fgaScoringBlockReason(lead = {}) {
  if (!isProspectSource(lead.lead_source)) return 'not_outbound_prospect';
  if (!automatedContactAllowed(lead)) return 'intake_quarantined';
  if (NEVER_RESTART_STATUSES.has(String(lead.status || '').toLowerCase())) {
    return 'terminal_or_engaged_status';
  }
  if (FGA_NEVER_READY_LIFECYCLES.has(String(lead.lifecycle_stage || '').toLowerCase())) {
    return 'terminal_lifecycle';
  }
  return null;
}

function shouldHandoffToOutreach(tenantId, lead, scoring, {
  skipOutreachHandoff = false,
} = {}) {
  return tenantId === FGA_TENANT_ID
    && !skipOutreachHandoff
    && lead?.status === 'new_lead'
    && isProspectSource(lead?.lead_source)
    && scoring?.outreach_ready === true;
}

function storedScoreVersion(lead = {}) {
  return lead.metadata?.score_breakdown?.score_version
    || lead.metadata?.score_version
    || null;
}

function needsScoreVersionUpgrade(lead = {}) {
  return lead.lead_score !== null
    && lead.lead_score !== undefined
    && storedScoreVersion(lead) !== SCORE_VERSION;
}

function scoreUpgradePriority(lead = {}) {
  const employeeFit = evaluateEmployeeFit(lead);
  const createdAt = Date.parse(lead.created_at || '');
  const cutoff = Date.parse(DATABASE_FIRST_CUTOFF);
  const existingInventory = Number.isFinite(createdAt) && createdAt < cutoff;
  return (existingInventory ? 10000 : 0)
    + (EMPLOYEE_SEGMENT_PRIORITY[employeeFit.segment] || 0)
    + Math.max(0, 100 - Number(lead.lead_score || 0));
}

function selectFgaScoreVersionUpgrades(rows = [], limit = 0) {
  const max = Math.max(0, Number(limit) || 0);
  return rows
    .filter((lead) => needsScoreVersionUpgrade(lead)
      && lead.tenant_id === FGA_TENANT_ID
      && !fgaScoringBlockReason(lead)
      && Boolean(lead.email)
      && evaluateEmployeeFit(lead).eligible)
    .sort((a, b) => scoreUpgradePriority(b) - scoreUpgradePriority(a)
      || String(a.created_at || '').localeCompare(String(b.created_at || ''))
      || String(a.id || '').localeCompare(String(b.id || '')))
    .slice(0, max);
}

async function fetchFgaScoreVersionUpgrades(client, tenantId, stages, limit) {
  if (tenantId !== FGA_TENANT_ID || limit <= 0) return [];
  const scanLimit = Math.min(SCORE_UPGRADE_SCAN_LIMIT, Math.max(limit * 5, limit));
  const prospectSources = [...PROSPECT_SOURCES];
  const base = () => client.from('leads')
    .select('*')
    .eq('tenant_id', tenantId)
    .in('lifecycle_stage', stages)
    .in('lead_source', prospectSources)
    .not('lead_score', 'is', null)
    .not('email', 'is', null);
  const [outdated, missing] = await Promise.all([
    base()
      .not(SCORE_VERSION_PATH, 'eq', SCORE_VERSION)
      .not(SCORE_VERSION_PATH, 'is', null)
      .limit(scanLimit),
    base()
      .is(SCORE_VERSION_PATH, null)
      .limit(scanLimit),
  ]);
  if (outdated.error) throw new Error(`score_version_outdated_read_failed:${outdated.error.message}`);
  if (missing.error) throw new Error(`score_version_missing_read_failed:${missing.error.message}`);
  return selectFgaScoreVersionUpgrades(
    [...(outdated.data || []), ...(missing.data || [])],
    limit,
  );
}

function parseEmployeeRange(sizeText) {
  if (!sizeText) return null;
  const s = String(sizeText).trim();

  const rangeMap = {
    '20-50': 35, '50-100': 75, '100-150': 125,
    '150-250': 200, '100-250': 175, '250-500': 375,
    '500-1000': 750, '1000-5000': 2500
  };

  if (rangeMap[s]) return rangeMap[s];

  const match = s.match(/(\d+)\s*-\s*(\d+)/);
  if (match) return Math.round((Number(match[1]) + Number(match[2])) / 2);

  return null;
}

function parseNotes(notes) {
  const lower = (notes || '').toLowerCase();
  const growthSignals = [];
  const benefitsSignals = [];

  if (lower.includes('growth signals:')) growthSignals.push('growth_signals_present');
  if (lower.includes('benefits signals:')) benefitsSignals.push('benefits_signals_present');
  if (lower.includes('employees:')) growthSignals.push('employee_signal_present');
  if (lower.includes('outreach angle:')) benefitsSignals.push('outreach_angle_present');

  return { growthSignals, benefitsSignals };
}

/**
 * Extract urgency signals from a lead's notes / message body.
 * Module 13.4 — multi-signal scoring including "urgency words".
 * Returns 0-10 score (more urgency words detected → higher score).
 */
function urgencyWordScore(textBlob) {
  if (!textBlob) return 0;
  const lower = String(textBlob).toLowerCase();
  // Tiered by intensity — "now" / "today" are stronger signals than "soon"
  const high = ['asap', 'urgent', 'emergency', 'today', 'right now', 'broken', 'flooding', 'leaking', 'no power', 'not working'];
  const mid = ['this week', 'tomorrow', 'soon', 'quickly', 'fast', 'priority'];
  const low = ['next week', 'next month', 'when you can', 'whenever'];

  let score = 0;
  for (const word of high) { if (lower.includes(word)) score += 4; }
  for (const word of mid)  { if (lower.includes(word)) score += 2; }
  for (const word of low)  { if (lower.includes(word)) score -= 1; }
  return Math.max(0, Math.min(10, score));
}

/**
 * Score how complete the lead profile is. Module 13.4 — "completeness
 * of their inquiry" as a signal of buyer intent. A lead with name +
 * phone + email + a substantive note is a hotter lead than a phone-only
 * drive-by.
 */
function completenessScore(lead) {
  let score = 0;
  if (lead.name && lead.name.trim().length > 1) score += 2;
  if (lead.phone) score += 2;
  if (lead.email) score += 2;
  if (lead.address || lead.city) score += 1;
  if (lead.notes && lead.notes.trim().length > 30) score += 2;
  if (lead.service_type) score += 1;
  return Math.min(10, score);
}

/**
 * Score how fast the lead responded to the first outbound message.
 * Module 13.4 — response speed as a primary signal. Computed by
 * comparing the lead's first inbound conversation timestamp against
 * the outbound that preceded it.
 */
async function responseSpeedScore(tenantId, leadId) {
  try {
    const { data: convs } = await db
      .from('conversations')
      .select('direction, created_at')
      .eq('tenant_id', tenantId)
      .eq('lead_id', leadId)
      .order('created_at', { ascending: true })
      .limit(10);
    if (!convs || convs.length < 2) return 0;
    // Find the first outbound, then the first inbound after it.
    const firstOut = convs.find(c => c.direction === 'outbound');
    if (!firstOut) return 0;
    const firstInAfter = convs.find(c => c.direction === 'inbound' && new Date(c.created_at) > new Date(firstOut.created_at));
    if (!firstInAfter) return 0;
    const minutes = (new Date(firstInAfter.created_at) - new Date(firstOut.created_at)) / 60000;
    if (minutes < 5) return 10;
    if (minutes < 30) return 8;
    if (minutes < 120) return 6;
    if (minutes < 360) return 4;
    if (minutes < 1440) return 2; // 24h
    return 1;
  } catch {
    return 0;
  }
}

function extractConfidence(metadata) {
  if (!metadata) return null;
  const conf = metadata.enrichment_confidence;
  return conf != null ? Number(conf) : null;
}

// ============================================================================
// SCORING ENGINE
// ============================================================================

function computeScore(lead, contacts, config, signals = {}) {
  let sizeScore = 0;
  let industryScore = 0;
  let geographyScore = 0;
  let growthScore = 0;
  let benefitsScore = 0;
  let contactQualityScore = 0;

  const employeeFit = config.strictMicroBusiness
    ? evaluateEmployeeFit(lead)
    : null;
  const estimatedEmployees = lead.employee_count_actual || parseEmployeeRange(lead.size);
  const state = lead.hq_state || null;
  const confidence = extractConfidence(lead.metadata);
  const parsedNotes = parseNotes(lead.notes);

  // Module 13.4 — new signal categories layered on top of rule-based.
  // Each is 0-10 normalized; we add them as bonus points to the total.
  const urgencyScore = signals.urgency != null ? signals.urgency : urgencyWordScore([lead.notes, lead.service_type].filter(Boolean).join(' '));
  const completenessOfInquiry = signals.completeness != null ? signals.completeness : completenessScore(lead);
  const responseSpeed = signals.responseSpeed != null ? signals.responseSpeed : 0;
  const fgaReadinessBlock = config.strictMicroBusiness
    ? fgaScoringBlockReason(lead)
    : null;

  if (config.strictMicroBusiness) {
    // FGA's own wide-net rule: industry never excludes. Verified 1-9 teams
    // receive the strongest priority, estimated 1-9 teams follow, and 10-19
    // remains eligible at a lower priority. Unknown or 20+ cannot become
    // outreach-ready.
    const segmentScores = {
      verified_sweet_spot_1_9: 30,
      estimated_sweet_spot_1_9: 27,
      verified_small_business_10_19: 24,
      estimated_small_business_10_19: 21,
    };
    sizeScore = segmentScores[employeeFit.segment] || 0;
  } else if (estimatedEmployees !== null) {
    // Preserve the existing scoring contract for customer tenants.
    if (estimatedEmployees >= config.minEmployees && estimatedEmployees <= config.maxEmployees) {
      sizeScore = 30;
    } else if (estimatedEmployees >= 10 && estimatedEmployees < config.minEmployees) {
      sizeScore = 12;
    } else if (estimatedEmployees > config.maxEmployees && estimatedEmployees <= 300) {
      sizeScore = 15;
    }
  }

  if (config.strictMicroBusiness) {
    // FGA wide-net rule: industry affects prioritization slightly but never
    // excludes an otherwise qualified micro-business.
    if (lead.industry && config.targetIndustries.includes(lead.industry)) {
      industryScore = 20;
    } else if (lead.industry) {
      industryScore = 15;
    } else {
      industryScore = 10;
    }
  } else {
    // Preserve customer-tenant vertical scoring exactly as it operated before
    // this FGA-only overhaul.
    const highValueIndustries = [
      'Manufacturing', 'Construction', 'Architecture/Engineering',
      'Legal Services', 'Law Firm', 'Technology', 'SaaS'
    ];
    const lowerValueIndustries = [
      'Marketing Agency', 'Marketing', 'Advertising', 'Creative'
    ];
    if (lead.industry && config.targetIndustries.includes(lead.industry)) {
      if (highValueIndustries.includes(lead.industry)) industryScore = 25;
      else if (lowerValueIndustries.includes(lead.industry)) industryScore = 10;
      else industryScore = 20;
    } else if (lead.industry) {
      industryScore = 5;
    }
  }

  // Geography Fit (15 points)
  if (state && config.targetStates.includes(state)) {
    geographyScore = 15;
  } else if (state) {
    geographyScore = 5;
  }

  // Growth Signals (15 points)
  growthScore = Math.min(15, parsedNotes.growthSignals.length * 5);
  if (confidence !== null && confidence >= 0.85) {
    growthScore = Math.min(15, growthScore + 5);
  }

  // Benefits Signals (10 points)
  benefitsScore = Math.min(10, parsedNotes.benefitsSignals.length * 5);

  // Contact Quality (10 points)
  const contactCount = contacts.length;
  const primaryDecisionMaker = contacts.find(c =>
    ['decision_maker', 'influencer'].includes(c.role_in_buying)
  );

  if (contactCount >= 2 && primaryDecisionMaker) {
    contactQualityScore = 10;
  } else if (contactCount === 1 && primaryDecisionMaker) {
    contactQualityScore = 7;
  } else if (contactCount >= 1) {
    contactQualityScore = 4;
  } else if (config.strictMicroBusiness && lead.email) {
    // A lead-level email is still a grounded reachable contact when
    // enrichment has not produced a separate contacts-table row. This is
    // FGA-only: customer-tenant scoring remains unchanged.
    contactQualityScore = 4;
  }

  // Total combines the original 100-point rule scoring with the new
  // intent signals (urgency / completeness / response speed). New
  // signals can bump or trim the score by up to ±30, clamped to 0-100.
  const baseTotal = sizeScore + industryScore + geographyScore + growthScore + benefitsScore + contactQualityScore;
  const intentBoost = urgencyScore + completenessOfInquiry + responseSpeed; // 0-30
  // Scale the intent boost so it can lift a borderline lead into the
  // next tier but not dominate the rule-based ICP fit.
  const total = Math.max(0, Math.min(100, baseTotal + Math.round(intentBoost * 0.6)));

  // Tier assignment from tenant config thresholds
  let tier = 'C';
  let recommendation = 'Deprioritize';
  let outreachReady = false;

  if ((!config.strictMicroBusiness || (employeeFit.eligible && !fgaReadinessBlock))
      && total >= config.tierAThreshold) {
    tier = 'A';
    recommendation = 'Ready for outreach';
    outreachReady = true;
  } else if (config.strictMicroBusiness && fgaReadinessBlock) {
    tier = 'C';
    recommendation = 'Not eligible for autonomous outreach';
  } else if (config.strictMicroBusiness && employeeFit.decision === 'needs_evidence') {
    tier = 'B';
    recommendation = 'Verify employee count before outreach';
  } else if (config.strictMicroBusiness && employeeFit.decision === 'ineligible') {
    tier = 'C';
    recommendation = 'Outside FGA size ICP';
  } else if (total >= config.tierBThreshold) {
    tier = 'B';
    recommendation = 'Review / nurture';
  }

  return {
    size_score: sizeScore,
    industry_score: industryScore,
    geography_score: geographyScore,
    growth_signals_score: growthScore,
    benefits_signals_score: benefitsScore,
    contact_quality_score: contactQualityScore,
    urgency_score: urgencyScore,
    completeness_score: completenessOfInquiry,
    response_speed_score: responseSpeed,
    intent_boost: Math.round(intentBoost * 0.6),
    total_score: total,
    tier,
    recommendation,
    outreach_ready: outreachReady,
    contact_count: contactCount,
    confidence,
    employee_fit: employeeFit,
    outreach_block_reason: fgaReadinessBlock,
    icp_version: config.strictMicroBusiness ? ICP_VERSION : null,
    score_version: config.strictMicroBusiness ? SCORE_VERSION : 'legacy-tenant-scoring-v1',
  };
}

/**
 * Module 13.7 — Generate an explainable score summary using Claude.
 * Output is a 1-3 sentence plain-English explanation of WHY this lead
 * got this score, citing the top 2-3 signals that drove it. Stored in
 * metadata.score_explanation so the mobile lead-detail screen can show
 * "Why is this an A?" next to the score badge.
 *
 * Falls back to a deterministic explanation if Claude fails — scoring
 * must never block on the model.
 */
async function generateScoreExplanation(tenant, lead, scoring) {
  const signals = [
    { label: 'Industry fit', score: scoring.industry_score, max: 25 },
    { label: 'Size fit', score: scoring.size_score, max: 30 },
    { label: 'Geography', score: scoring.geography_score, max: 15 },
    { label: 'Urgency in inquiry', score: scoring.urgency_score, max: 10 },
    { label: 'Profile completeness', score: scoring.completeness_score, max: 10 },
    { label: 'Response speed', score: scoring.response_speed_score, max: 10 },
    { label: 'Contact quality', score: scoring.contact_quality_score, max: 10 },
    { label: 'Growth signals', score: scoring.growth_signals_score, max: 15 },
    { label: 'Benefits signals', score: scoring.benefits_signals_score, max: 10 },
  ];
  // Top 3 drivers
  const drivers = [...signals].sort((a, b) => (b.score / b.max) - (a.score / a.max)).slice(0, 3);
  // Bottom 1-2 if total is below A
  const drags = scoring.tier !== 'A'
    ? [...signals].sort((a, b) => (a.score / a.max) - (b.score / b.max)).slice(0, 2)
    : [];

  const fallback = deterministicScoreExplanation(scoring, drivers);

  try {
    const systemPrompt = `You explain lead scores in plain English to a small business owner. Output 1-3 sentences, no jargon, no marketing fluff. Focus on the 2-3 strongest reasons this lead scored where they did, and if the score is below tier A, mention the biggest reason why. Output ONLY the explanation text — no headers, no labels, no "Explanation:" prefix.`;
    const userMessage = `Lead: ${lead.company_name || lead.name || '(no name)'}\nIndustry: ${lead.industry || 'unknown'}\nState: ${lead.hq_state || 'unknown'}\nNotes: ${(lead.notes || '').slice(0, 300)}\n\nFinal score: ${scoring.total_score}/100, tier ${scoring.tier}\n\nSignal breakdown:\n${signals.map(s => `- ${s.label}: ${s.score}/${s.max}`).join('\n')}\n\nWrite the explanation now.`;
    const text = await claudeHaiku(systemPrompt, userMessage, { maxTokens: 200, tenantSlug: tenant.slug });
    const cleaned = String(text || '').trim();
    return cleaned && cleaned.length > 20 ? cleaned : fallback;
  } catch {
    return fallback;
  }
}

function deterministicScoreExplanation(scoring, rankedSignals = null) {
  const signals = rankedSignals || [
    { label: 'Size fit', score: scoring.size_score, max: 30 },
    { label: 'Industry fit', score: scoring.industry_score, max: 25 },
    { label: 'Geography', score: scoring.geography_score, max: 15 },
    { label: 'Contact quality', score: scoring.contact_quality_score, max: 10 },
    { label: 'Profile completeness', score: scoring.completeness_score, max: 10 },
  ].sort((a, b) => (b.score / b.max) - (a.score / a.max)).slice(0, 3);
  return `Tier ${scoring.tier} (${scoring.total_score}/100). Top drivers: ${signals.map(
    signal => `${signal.label} (${signal.score}/${signal.max})`,
  ).join(', ')}.`;
}

// ============================================================================
// MAIN AGENT
// ============================================================================

/**
 * @param {Object} tenant - Resolved tenant (from resolveTenant)
 * @param {Object} payload - { limit }
 */
async function run(tenant, payload = {}) {
  const log = createLogger('scoring', tenant.slug);
  // Throughput (2026-07-22): the default was 25/run against ONE weekday run
  // = 125 leads/week of capacity, while prospecting adds ~112 new leads/week
  // — and re-scoring consumed most of those slots. Scoring could never catch
  // up, so a 200+ lead backlog sat at lead_score=NULL, which the autosend
  // score gate reads as 0 and parks in needs_review forever. Each lead costs
  // one Haiku call at maxTokens=200 (fractions of a cent), so capacity was
  // never the real constraint. Override per-run with payload.limit, or per
  // tenant with tenant_config.scoring_batch_limit.
  const strictMicroBusiness = tenant.id === FGA_TENANT_ID;
  const defaultLimit = strictMicroBusiness ? 250 : 150;
  const limit = Number(payload.limit || getConfig(tenant, 'scoring_batch_limit', defaultLimit));

  // Load ICP config from tenant_config (via getConfig layered resolution)
  const targetStates = safeArray(getConfig(tenant, 'target_states', []));
  const targetIndustries = safeArray(getConfig(tenant, 'target_industries', []));
  const minEmployees = strictMicroBusiness
    ? 1
    : Number(getConfig(tenant, 'min_employees', 20));
  const maxEmployees = strictMicroBusiness
    ? 19
    : Number(getConfig(tenant, 'max_employees', 150));
  const thresholds = resolveScoringThresholds(tenant, strictMicroBusiness);

  const config = {
    targetStates,
    targetIndustries,
    minEmployees,
    maxEmployees,
    strictMicroBusiness,
    ...thresholds,
  };

  log.info('Starting scoring run', { limit, ...config });

  // Fetch leads ready for scoring or re-scoring. Module 13.3 — score
  // updates as new signals come in. Originally this filter was strictly
  // lifecycle_stage='enriched' (one-shot). Now we also re-score leads
  // that are already scored when they have:
  //   - A specific lead_id payload (event-driven re-score, e.g. reply
  //     classification just fired and the lead got new context).
  //   - A scored lead whose updated_at is more recent than the last
  //     score_breakdown.scored_at (the cron sweeper picks these up).
  const SCORING_STAGES = ['enriched', 'scored', 'contacted', 'estimate_given', 'sequenced', 'stale'];
  let leads;
  let fetchErr;
  const scoreVersionUpgradeIds = new Set();
  const onlyScoreVersionMismatch = strictMicroBusiness
    && payload.only_score_version_mismatch === true;
  if (payload.lead_id) {
    ({ data: leads, error: fetchErr } = await db
      .from('leads')
      .select('*')
      .eq('tenant_id', tenant.id)
      .eq('id', payload.lead_id));
    if (needsScoreVersionUpgrade(leads?.[0])) scoreVersionUpgradeIds.add(String(leads[0].id));
  } else {
    leads = [];

    // FGA score contracts are versioned. When size evidence began accepting
    // grounded ranges, hundreds of otherwise suitable small businesses kept
    // their old zero-size score because the generic rescore queue was ordered
    // by age. Reserve most FGA capacity for exact-tenant version upgrades,
    // with existing database inventory and 1-9 employee teams ranked first.
    // Version upgrades can restore a never-contacted prospect to the normal
    // email-drafting queue. That queue is idempotent and provider-disconnected;
    // the separate sender still enforces the daily cap and database-first rank.
    if (strictMicroBusiness) {
      const upgradeLimit = onlyScoreVersionMismatch
        ? limit
        : Math.max(1, Math.floor(limit * FGA_SCORE_UPGRADE_SHARE));
      try {
        const upgrades = await fetchFgaScoreVersionUpgrades(
          db,
          tenant.id,
          SCORING_STAGES,
          upgradeLimit,
        );
        leads.push(...upgrades);
        for (const lead of upgrades) scoreVersionUpgradeIds.add(String(lead.id));
      } catch (error) {
        fetchErr = error;
      }
    }

    // NEVER-SCORED LEADS GO NEXT (2026-07-22 starvation fix).
    //
    // This window intentionally includes already-scored leads so their score
    // can refresh as new signals arrive — but it was ordered by updated_at
    // ASCENDING under a hard limit. A freshly discovered lead has the NEWEST
    // updated_at, so it sorted dead last and the limited slots were consumed
    // re-scoring old leads. Net effect: 46 leads sat at lead_score=NULL,
    // which the autosend score gate reads as 0 and parks in needs_review
    // forever. Same class as the auto-outreach oldest-first starvation.
    //
    // Customer tenants preserve the deployed unscored-first behavior. FGA's
    // remaining capacity keeps new supply moving after its reserved upgrade
    // share has been consumed.
    let remaining = limit - leads.length;
    if (!fetchErr && !onlyScoreVersionMismatch && remaining > 0) {
      const { data: unscored, error: unErr } = await db
        .from('leads')
        .select('*')
        .eq('tenant_id', tenant.id)
        .in('lifecycle_stage', SCORING_STAGES)
        .is('lead_score', null)
        .order('created_at', { ascending: false })
        .limit(remaining);
      fetchErr = unErr;
      leads.push(...(unscored || []));
      remaining = limit - leads.length;
    }

    // Exact-FGA scoring is deterministic and event-driven after the initial
    // score/version pass. Re-reading unchanged current-version rows merely
    // rewrites updated_at, which makes the same rows look changed again and
    // creates a permanent daily loop. New evidence already enqueues an exact
    // lead_id scoring job; the daily FGA sweep is only a safety net for
    // unscored/version-stale rows. Customer tenants retain their deployed
    // generic re-score behavior.
    if (!strictMicroBusiness && !fetchErr && !onlyScoreVersionMismatch && remaining > 0) {
      let rescoreQuery = db.from('leads')
        .select('*')
        .eq('tenant_id', tenant.id)
        .in('lifecycle_stage', SCORING_STAGES)
        .not('lead_score', 'is', null);
      const { data: rescore, error: rescoreErr } = await rescoreQuery
        .order('updated_at', { ascending: true, nullsFirst: true })
        .limit(remaining);
      fetchErr = rescoreErr;
      leads.push(...(rescore || []));
    }
  }

  if (fetchErr) throw fetchErr;

  if (!leads || leads.length === 0) {
    log.info('No enriched leads to score');
    return { success: true, scored: 0, message: 'No enriched leads available for scoring' };
  }

  let scored = 0;
  let tierA = 0, tierB = 0, tierC = 0;
  let scoreVersionUpgraded = 0;
  const processed = [];
  const errors = [];
  const readyForOutreach = [];

  for (const lead of leads) {
    try {
      if (!automatedContactAllowed(lead)) {
        processed.push({ lead_id: lead.id, action: 'intake_quarantined' });
        continue;
      }

      // Fetch contacts for this lead (tenant-scoped for defense-in-depth)
      const { data: contacts, error: contactErr } = await db
        .from('contacts')
        .select('id, first_name, last_name, title, email, linkedin_url, role_in_buying, is_primary_contact')
        .eq('tenant_id', tenant.id)
        .eq('lead_id', lead.id);

      if (contactErr) throw contactErr;

      // Module 13.4 — gather the additional intent signals before
      // computing the score. responseSpeed needs a DB lookup so it's
      // pulled in here rather than inside computeScore (which stays
      // synchronous for unit-testability).
      const responseSpeed = await responseSpeedScore(tenant.id, lead.id);
      const scoring = computeScore(lead, contacts || [], config, { responseSpeed });
      const scoreVersionUpgrade = scoreVersionUpgradeIds.has(String(lead.id));

      // Module 13.7 — generate an AI explanation of WHY this score
      // (used by the mobile lead-detail "Why is this an A?" widget).
      // FGA scores up to 150 database prospects per daily run. Calling a
      // language model serially for a display-only explanation made the
      // scoring job take minutes and compete with the 07:40 restart window.
      // The score is already deterministic and fully explainable from its
      // breakdown, so FGA uses that same evidence directly. Customer tenants
      // retain their deployed model-assisted explanation behavior.
      const explanation = strictMicroBusiness
        ? deterministicScoreExplanation(scoring)
        : await generateScoreExplanation(tenant, lead, scoring);

      // Build full score breakdown for metadata
      const scoreBreakdown = {
        size: scoring.size_score,
        industry: scoring.industry_score,
        geography: scoring.geography_score,
        growth: scoring.growth_signals_score,
        benefits: scoring.benefits_signals_score,
        contacts: scoring.contact_quality_score,
        urgency: scoring.urgency_score,
        completeness: scoring.completeness_score,
        response_speed: scoring.response_speed_score,
        intent_boost: scoring.intent_boost,
        employee_fit: scoring.employee_fit,
        outreach_block_reason: scoring.outreach_block_reason,
        icp_version: scoring.icp_version,
        score_version: scoring.score_version,
        scored_at: new Date().toISOString()
      };

      // Update lead with score, tier, recommendation, and explainability
      const { error: updateErr } = await db
        .from('leads')
        .update({
          lead_score: scoring.total_score,
          priority_tier: scoring.tier,
          outreach_ready: scoring.outreach_ready,
          outreach_recommendation: scoring.recommendation,
          // Re-scoring refreshes evidence; it must not regress an FGA lead
          // that has already been sequenced, contacted, or replied. Customer
          // tenants retain the deployed assignment above this FGA boundary.
          lifecycle_stage: strictMicroBusiness
            ? fgaLifecycleAfterResearch(lead, 'scored')
            : 'scored',
          metadata: {
            ...(lead.metadata || {}),
            score_breakdown: scoreBreakdown,
            score_explanation: explanation, // Module 13.7
          },
          updated_at: new Date().toISOString()
        })
        .eq('id', lead.id)
        .eq('tenant_id', tenant.id);

      if (updateErr) throw updateErr;

      if (strictMicroBusiness) {
        try {
          const { recordGrowthEvent } = require('../../core/growth/events');
          await recordGrowthEvent(db, {
            tenantId: tenant.id,
            leadId: lead.id,
            eventType: scoring.outreach_ready ? 'prospect_qualified' : 'prospect_scored',
            stage: scoring.outreach_ready ? 'qualified' : 'contact_verified',
            sourceSystem: 'scoring_agent',
            sourceId: `${lead.id}:${SCORE_VERSION}`,
            actor: 'scoring',
            evidence: {
              score: scoring.total_score,
              tier: scoring.tier,
              outreach_ready: scoring.outreach_ready,
              employee_decision: scoring.employee_fit?.decision || null,
              outreach_block_reason: scoring.outreach_block_reason,
              score_version_upgrade: scoreVersionUpgrade,
            },
            messageVersion: SCORE_VERSION,
            correlationId: lead.id,
          });
        } catch (eventError) {
          log.warn(`Growth scoring evidence deferred for ${lead.id}: ${eventError.message}`);
        }
        // Scoring owns the qualified -> drafting handoff for FGA. Restrict it
        // to never-contacted prospects that actually passed the score/size
        // contract. The handoff creates an internal email-only draft job and
        // deliberately does not invoke a provider dispatcher.
        if (shouldHandoffToOutreach(tenant.id, lead, scoring, {
          skipOutreachHandoff: payload.skip_outreach_handoff === true,
        })) {
          readyForOutreach.push(lead.id);
        }
      }

      scored++;
      if (scoreVersionUpgrade) scoreVersionUpgraded++;
      if (scoring.tier === 'A') tierA++;
      else if (scoring.tier === 'B') tierB++;
      else tierC++;

      processed.push({
        lead_id: lead.id,
        company: lead.company_name,
        total_score: scoring.total_score,
        tier: scoring.tier,
        recommendation: scoring.recommendation,
        outreach_ready: scoring.outreach_ready,
        contact_count: scoring.contact_count,
        score_version_upgraded: scoreVersionUpgrade,
      });

      log.info('Scored lead', { company: lead.company_name, score: scoring.total_score, tier: scoring.tier });
    } catch (err) {
      log.error(`Scoring failed for lead ${lead.id}`, err);
      errors.push({ lead_id: lead.id, company: lead.company_name, error: err.message });
    }
  }

  let outreachHandoff = { queued: 0, skipped: 0 };
  if (strictMicroBusiness && readyForOutreach.length) {
    try {
      outreachHandoff = await enqueueFgaOutreachHandoffs(
        db,
        tenant.id,
        readyForOutreach,
        { source: 'scoring_handoff', priority: 7 },
      );
    } catch (handoffError) {
      errors.push({ stage: 'outreach_handoff', error: handoffError.message });
      outreachHandoff = { queued: 0, skipped: 0, error: handoffError.message };
      log.error('Qualified FGA prospects could not be handed to outreach', handoffError);
    }
  }

  const result = {
    success: errors.length === 0,
    ...(errors.length ? {
      error: strictMicroBusiness
        ? `${errors.length} FGA scoring or handoff failure(s)`
        : `${errors.length} lead(s) failed scoring`,
    } : {}),
    scored,
    tier_a: tierA,
    tier_b: tierB,
    tier_c: tierC,
    ...(strictMicroBusiness ? {
      outreach_handoff_queued: outreachHandoff.queued || 0,
      outreach_handoff_skipped: outreachHandoff.skipped || 0,
      score_version_upgraded: scoreVersionUpgraded,
      score_version: SCORE_VERSION,
      ...(outreachHandoff.error ? { outreach_handoff_error: outreachHandoff.error } : {}),
    } : {}),
    processed,
    errors
  };

  log.success('Scoring run completed', result);
  return result;
}

module.exports = run;
module.exports._test = {
  computeScore,
  resolveScoringThresholds,
  fgaScoringBlockReason,
  deterministicScoreExplanation,
  parseEmployeeRange,
  shouldHandoffToOutreach,
  storedScoreVersion,
  needsScoreVersionUpgrade,
  scoreUpgradePriority,
  selectFgaScoreVersionUpgrades,
  fetchFgaScoreVersionUpgrades,
  fgaLifecycleAfterResearch,
  SCORE_VERSION,
};
