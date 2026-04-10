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

function extractConfidence(metadata) {
  if (!metadata) return null;
  const conf = metadata.enrichment_confidence;
  return conf != null ? Number(conf) : null;
}

// ============================================================================
// SCORING ENGINE
// ============================================================================

function computeScore(lead, contacts, config) {
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

  const total = sizeScore + industryScore + geographyScore + growthScore + benefitsScore + contactQualityScore;

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
    total_score: total,
    tier,
    recommendation,
    outreach_ready: outreachReady,
    contact_count: contactCount,
    confidence
  };
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

  // Fetch enriched leads for this tenant
  const { data: leads, error: fetchErr } = await db
    .from('leads')
    .select('*')
    .eq('tenant_id', tenant.id)
    .eq('lifecycle_stage', 'enriched')
    .order('updated_at', { ascending: true, nullsFirst: true })
    .limit(limit);

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
      // Fetch contacts for this lead
      const { data: contacts, error: contactErr } = await db
        .from('contacts')
        .select('id, first_name, last_name, title, email, linkedin_url, role_in_buying, is_primary_contact')
        .eq('lead_id', lead.id);

      if (contactErr) throw contactErr;

      const scoring = computeScore(lead, contacts || [], config);

      // Build score breakdown for metadata
      const scoreBreakdown = {
        size: scoring.size_score,
        industry: scoring.industry_score,
        geography: scoring.geography_score,
        growth: scoring.growth_signals_score,
        benefits: scoring.benefits_signals_score,
        contacts: scoring.contact_quality_score,
        scored_at: new Date().toISOString()
      };

      // Update lead with score, tier, and recommendation
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
            score_breakdown: scoreBreakdown
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
