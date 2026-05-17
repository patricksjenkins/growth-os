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
const { getConfig } = require('../../core/config');
const { db } = require('../../db/client');
const { claudeHaiku } = require('../../integrations/claude');

// ============================================================================
// HELPERS
// ============================================================================

function safeArray(v) {
  return Array.isArray(v) ? v : [];
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

  // Use employee_count_actual if available, otherwise parse size range
  const estimatedEmployees = lead.employee_count_actual || parseEmployeeRange(lead.size);
  const state = lead.hq_state || null;
  const confidence = extractConfidence(lead.metadata);
  const parsedNotes = parseNotes(lead.notes);

  // Module 13.4 — new signal categories layered on top of rule-based.
  // Each is 0-10 normalized; we add them as bonus points to the total.
  const urgencyScore = signals.urgency != null ? signals.urgency : urgencyWordScore([lead.notes, lead.service_type].filter(Boolean).join(' '));
  const completenessOfInquiry = signals.completeness != null ? signals.completeness : completenessScore(lead);
  const responseSpeed = signals.responseSpeed != null ? signals.responseSpeed : 0;

  // Size Fit (30 points)
  if (estimatedEmployees !== null) {
    if (estimatedEmployees >= config.minEmployees && estimatedEmployees <= config.maxEmployees) {
      sizeScore = 30;
    } else if (estimatedEmployees >= 10 && estimatedEmployees < config.minEmployees) {
      sizeScore = 12;
    } else if (estimatedEmployees > config.maxEmployees && estimatedEmployees <= 300) {
      sizeScore = 15;
    }
  }

  // Industry Fit (20 points)
  const highValueIndustries = [
    'Manufacturing', 'Construction', 'Architecture/Engineering',
    'Legal Services', 'Law Firm', 'Technology', 'SaaS'
  ];
  const lowerValueIndustries = [
    'Marketing Agency', 'Marketing', 'Advertising', 'Creative'
  ];

  if (lead.industry && config.targetIndustries.includes(lead.industry)) {
    if (highValueIndustries.includes(lead.industry)) {
      industryScore = 25;
    } else if (lowerValueIndustries.includes(lead.industry)) {
      industryScore = 10;
    } else {
      industryScore = 20;
    }
  } else if (lead.industry) {
    industryScore = 5;
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

  if (total >= config.tierAThreshold) {
    tier = 'A';
    recommendation = 'Ready for outreach';
    outreachReady = true;
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
    confidence
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

  const fallback = `Tier ${scoring.tier} (${scoring.total_score}/100). Top drivers: ${drivers.map(d => `${d.label} (${d.score}/${d.max})`).join(', ')}.`;

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

// ============================================================================
// MAIN AGENT
// ============================================================================

/**
 * @param {Object} tenant - Resolved tenant (from resolveTenant)
 * @param {Object} payload - { limit }
 */
async function run(tenant, payload = {}) {
  const log = createLogger('scoring', tenant.slug);
  const limit = Number(payload.limit || 25);

  // Load ICP config from tenant_config (via getConfig layered resolution)
  const targetStates = safeArray(getConfig(tenant, 'target_states', []));
  const targetIndustries = safeArray(getConfig(tenant, 'target_industries', []));
  const minEmployees = Number(getConfig(tenant, 'min_employees', 20));
  const maxEmployees = Number(getConfig(tenant, 'max_employees', 150));
  const scoringRules = getConfig(tenant, 'scoring_rules', { tier_a: 70, tier_b: 50 });

  const config = {
    targetStates,
    targetIndustries,
    minEmployees,
    maxEmployees,
    tierAThreshold: scoringRules.tier_a || 70,
    tierBThreshold: scoringRules.tier_b || 50
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
  let leadsQuery;
  if (payload.lead_id) {
    leadsQuery = db
      .from('leads')
      .select('*')
      .eq('tenant_id', tenant.id)
      .eq('id', payload.lead_id);
  } else {
    leadsQuery = db
      .from('leads')
      .select('*')
      .eq('tenant_id', tenant.id)
      .in('lifecycle_stage', ['enriched', 'scored', 'contacted', 'estimate_given'])
      .order('updated_at', { ascending: true, nullsFirst: true })
      .limit(limit);
  }
  const { data: leads, error: fetchErr } = await leadsQuery;

  if (fetchErr) throw fetchErr;

  if (!leads || leads.length === 0) {
    log.info('No enriched leads to score');
    return { success: true, scored: 0, message: 'No enriched leads available for scoring' };
  }

  let scored = 0;
  let tierA = 0, tierB = 0, tierC = 0;
  const processed = [];
  const errors = [];

  for (const lead of leads) {
    try {
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

      // Module 13.7 — generate an AI explanation of WHY this score
      // (used by the mobile lead-detail "Why is this an A?" widget).
      const explanation = await generateScoreExplanation(tenant, lead, scoring);

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
          lifecycle_stage: 'scored',
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

      scored++;
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
        contact_count: scoring.contact_count
      });

      log.info('Scored lead', { company: lead.company_name, score: scoring.total_score, tier: scoring.tier });
    } catch (err) {
      log.error(`Scoring failed for lead ${lead.id}`, err);
      errors.push({ lead_id: lead.id, company: lead.company_name, error: err.message });
    }
  }

  const result = {
    success: true,
    scored,
    tier_a: tierA,
    tier_b: tierB,
    tier_c: tierC,
    processed,
    errors
  };

  log.success('Scoring run completed', result);
  return result;
}

module.exports = run;
