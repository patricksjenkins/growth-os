/**
 * Scoring Agent (Schema-Aligned v2)
 *
 * - Reads enriched clients from Supabase
 * - Scores them against WellMor ICP
 * - Looks at associated contacts
 * - Writes score/tier/recommendation into clients
 * - Keeps lifecycle_stage as enriched
 * - Marks outreach_ready=true for Tier A
 */

require('dotenv').config();
const express = require('express');
const { createLogger } = require('./shared/logger');
const { supabase, getSystemConfig } = require('./shared/supabase');

const logger = createLogger('ScoringAgent');
const router = express.Router();

function safeArray(v) {
  return Array.isArray(v) ? v : [];
}

function parseNotes(notes) {
  const text = notes || '';
  const lower = text.toLowerCase();

  const growthSignals = [];
  const benefitsSignals = [];

  if (lower.includes('growth signals:')) growthSignals.push('growth_signals_present');
  if (lower.includes('benefits signals:')) benefitsSignals.push('benefits_signals_present');
  if (lower.includes('employees:')) growthSignals.push('employee_signal_present');
  if (lower.includes('outreach angle:')) benefitsSignals.push('outreach_angle_present');

  return { growthSignals, benefitsSignals, raw: text };
}

function parseEmployeeRange(sizeText) {
  if (!sizeText) return null;
  const s = String(sizeText).trim();

  if (s === '20-50') return 35;
  if (s === '50-100') return 75;
  if (s === '100-150') return 125;
  if (s === '150-250') return 200;
  if (s === '100-250') return 175;
  if (s === '250-500') return 375;
  if (s === '500-1000') return 750;
  if (s === '1000-5000') return 2500;

  const match = s.match(/(\d+)\s*-\s*(\d+)/);
  if (match) return Math.round((Number(match[1]) + Number(match[2])) / 2);

  return null;
}

function extractStateFromNotes(notes) {
  const text = notes || '';
  const match = text.match(/State:\s*([A-Z]{2})/);
  return match ? match[1] : null;
}

function extractConfidenceFromNotes(notes) {
  const text = notes || '';
  const match = text.match(/ENRICHMENT CONFIDENCE:\s*([0-9.]+)/i);
  return match ? Number(match[1]) : null;
}

function computeScore(client, contacts, config) {
  let sizeScore = 0;
  let industryScore = 0;
  let geographyScore = 0;
  let growthScore = 0;
  let benefitsScore = 0;
  let contactQualityScore = 0;

  const estimatedEmployees = parseEmployeeRange(client.size);
  const state = extractStateFromNotes(client.morgan_notes);
  const confidence = extractConfidenceFromNotes(client.morgan_notes);
  const parsedNotes = parseNotes(client.morgan_notes);

  // Size Fit (30)
  if (estimatedEmployees !== null) {
    if (estimatedEmployees >= config.minEmployees && estimatedEmployees <= config.maxEmployees) {
      sizeScore = 30;
    } else if (estimatedEmployees >= 10 && estimatedEmployees < config.minEmployees) {
      sizeScore = 12;
    } else if (estimatedEmployees > config.maxEmployees && estimatedEmployees <= 300) {
      sizeScore = 15;
    }
  }

  // Industry Fit (20)
if (client.industry && config.targetIndustries.includes(client.industry)) {
  const lowerValueIndustries = ['Marketing Agency', 'Marketing', 'Advertising', 'Creative'];
  const highValueIndustries = [
    'Manufacturing',
    'Construction',
    'Architecture/Engineering',
    'Legal Services',
    'Law Firm',
    'Technology',
    'SaaS'
  ];

  if (highValueIndustries.includes(client.industry)) {
    industryScore = 25;
  } else if (lowerValueIndustries.includes(client.industry)) {
    industryScore = 10;
  } else {
    industryScore = 20;
  }
} else if (client.industry) {
  industryScore = 5;
}
  // Geography Fit (15)
  if (state && config.targetStates.includes(state)) {
    geographyScore = 15;
  } else if (state) {
    geographyScore = 5;
  }

  // Growth Signals (15)
  growthScore = Math.min(15, parsedNotes.growthSignals.length * 5);
  if (confidence !== null && confidence >= 0.85) {
    growthScore = Math.min(15, growthScore + 5);
  }

  // Benefits Signals (10)
  benefitsScore = Math.min(10, parsedNotes.benefitsSignals.length * 5);

  // Contact Quality (10)
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

  let tier = 'C';
  let recommendation = 'Deprioritize';
  let outreachReady = false;

  if (total >= 70) {
    tier = 'A';
    recommendation = 'Ready for outreach';
    outreachReady = true;
  } else if (total >= 50) {
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
    confidence: confidence
  };
}

async function fetchClientsToScore(limit = 25) {
  const { data, error } = await supabase
    .from('clients')
    .select('id, company, industry, size, lifecycle_stage, morgan_notes, updated_at')
    .eq('lifecycle_stage', 'enriched')
    .order('updated_at', { ascending: true, nullsFirst: true })
    .limit(limit);

  if (error) throw error;
  return data || [];
}

async function fetchContactsForClient(clientId) {
  const { data, error } = await supabase
    .from('contacts')
    .select('id, first_name, last_name, title, email, linkedin_url, role_in_buying, is_primary_contact')
    .eq('client_id', clientId);

  if (error) throw error;
  return data || [];
}

async function updateClientScore(client, scoring) {
  const existingNotes = client.morgan_notes ? `${client.morgan_notes}\n\n` : '';

  const scoreNote = [
    'SCORING:',
    `Lead Score: ${scoring.total_score}`,
    `Tier: ${scoring.tier}`,
    `Recommendation: ${scoring.recommendation}`,
    `Outreach Ready: ${scoring.outreach_ready ? 'yes' : 'no'}`,
    `Contact Count: ${scoring.contact_count}`,
    scoring.confidence !== null && scoring.confidence !== undefined
      ? `Scoring Confidence Input: ${scoring.confidence}`
      : null,
    `Breakdown: size=${scoring.size_score}, industry=${scoring.industry_score}, geography=${scoring.geography_score}, growth=${scoring.growth_signals_score}, benefits=${scoring.benefits_signals_score}, contacts=${scoring.contact_quality_score}`
  ].filter(Boolean).join('\n');

  const update = {
    morgan_notes: `${existingNotes}${scoreNote}`,
    lead_score: scoring.total_score,
    lead_tier: scoring.tier,
    outreach_ready: scoring.outreach_ready,
    outreach_recommendation: scoring.recommendation
  };

  const { data, error } = await supabase
    .from('clients')
    .update(update)
    .eq('id', client.id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function run(options = {}) {
  const limit = Number(options.limit || 25);

  const targetStates = await getSystemConfig('target_states');
  const minEmployees = await getSystemConfig('min_employees');
  const maxEmployees = await getSystemConfig('max_employees');
  const targetIndustries = await getSystemConfig('target_industries');

  if (!targetStates || !minEmployees || !maxEmployees || !targetIndustries) {
    throw new Error('Missing required ICP configuration in system_config');
  }

  const config = {
    targetStates: safeArray(targetStates),
    minEmployees: Number(minEmployees),
    maxEmployees: Number(maxEmployees),
    targetIndustries: safeArray(targetIndustries)
  };

  logger.info('Starting scoring run', { limit, ...config });

  const clients = await fetchClientsToScore(limit);

  if (!clients.length) {
    return {
      success: true,
      scored: 0,
      message: 'No enriched clients available for scoring'
    };
  }

  let scored = 0;
  let tierA = 0;
  let tierB = 0;
  let tierC = 0;
  const processed = [];
  const errors = [];

  for (const client of clients) {
    try {
      const contacts = await fetchContactsForClient(client.id);
      const scoring = computeScore(client, contacts, config);
      await updateClientScore(client, scoring);

      scored++;
      if (scoring.tier === 'A') tierA++;
      else if (scoring.tier === 'B') tierB++;
      else tierC++;

      processed.push({
        client_id: client.id,
        company: client.company,
        total_score: scoring.total_score,
        tier: scoring.tier,
        recommendation: scoring.recommendation,
        outreach_ready: scoring.outreach_ready,
        contact_count: scoring.contact_count
      });

      logger.info('Scored client', {
        company: client.company,
        score: scoring.total_score,
        tier: scoring.tier
      });
    } catch (err) {
      logger.error('Scoring failed for client', err);
      errors.push({
        client_id: client.id,
        company: client.company,
        error: err.message
      });
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

  logger.info('Scoring run completed', result);
  return result;
}

router.post('/', async (req, res) => {
  try {
    const result = await run(req.body || {});
    res.json(result);
  } catch (error) {
    logger.error('Scoring route failed', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
module.exports.run = run;
