/**
 * Prospecting Agent (Serper + OpenAI Hybrid)
 *
 * - Uses Serper to find real companies on the public web
 * - Uses OpenAI to extract/filter prospects against WellMor ICP
 * - Excludes likely competitors / HR firms using system_config
 * - Writes qualified prospects into clients + contacts
 */

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { createLogger } = require('./shared/logger');
const { getSystemConfig, supabase } = require('./shared/supabase');

const logger = createLogger('ProspectingAgent');
const router = express.Router();

const OPENAI_MODEL = process.env.OPENAI_RESEARCH_MODEL || 'gpt-4.1-mini';
const SCORE_THRESHOLD = 40;

function normalizeState(value) {
  if (!value) return null;
  return String(value).trim().toUpperCase();
}

function normalizeIndustry(value) {
  if (!value) return null;
  return String(value).trim();
}

function stateName(abbr) {
  const map = {
    GA: 'Georgia',
    FL: 'Florida',
    NC: 'North Carolina',
    SC: 'South Carolina',
    TN: 'Tennessee',
    AL: 'Alabama',
    TX: 'Texas',
    VA: 'Virginia',
    CO: 'Colorado',
    IL: 'Illinois',
  };
  return map[abbr] || abbr;
}

function stripCodeFences(text) {
  if (!text) return text;
  return text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function splitName(fullName) {
  if (!fullName) return { first_name: null, last_name: null };
  const parts = String(fullName).trim().split(/\s+/);
  if (parts.length === 1) return { first_name: parts[0], last_name: null };
  return {
    first_name: parts[0],
    last_name: parts.slice(1).join(' ')
  };
}

function normalizeSize(employeeCount, existingSize = null) {
  if (existingSize) return String(existingSize);

  const n = Number(employeeCount);
  if (!Number.isFinite(n)) return null;

  if (n >= 20 && n < 50) return '20-50';
  if (n >= 50 && n < 100) return '50-100';
  if (n >= 100 && n < 150) return '100-150';
  if (n >= 150 && n < 250) return '150-250';
  if (n >= 250 && n < 500) return '250-500';
  return '<20';
}

function safeArray(val) {
  return Array.isArray(val) ? val : [];
}

function uniqueBy(arr, keyFn) {
  const seen = new Set();
  return arr.filter((item) => {
    const key = keyFn(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function textContainsExcludedKeyword(candidate, excludedKeywords) {
  const haystack = [
    candidate.company,
    candidate.industry,
    candidate.reason,
    candidate.website
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return excludedKeywords.some(keyword => haystack.includes(String(keyword).toLowerCase()));
}

function isExcludedCandidate(candidate, config) {
  const industry = normalizeIndustry(candidate.industry);
  if (industry && config.excludedIndustries.includes(industry)) {
    return true;
  }

  if (textContainsExcludedKeyword(candidate, config.excludedKeywords)) {
    return true;
  }

  return false;
}

function scoreCandidate(candidate, config) {
  let score = 0;

  const employees = Number(candidate.employee_count || 0);
  const industry = normalizeIndustry(candidate.industry);
  const state = normalizeState(candidate.state);

  if (Number.isFinite(employees) && employees >= config.minEmployees && employees <= config.maxEmployees) {
    score += 30;
  } else if (!candidate.employee_count) {
    score += 10;
  }

  if (industry && config.targetIndustries.includes(industry)) score += 20;
  if (state && config.targetStates.includes(state)) score += 15;
  if (candidate.growth_signal) score += 15;
  if (candidate.contact_title) score += 10;
  if (candidate.website) score += 5;

  if (isExcludedCandidate(candidate, config)) {
    score -= 100;
  }

  return score;
}

function buildQueries(targetStates, targetIndustries, dailyLimit) {
  const queries = [];
  const maxQueries = Math.min(12, Math.max(4, Math.ceil(dailyLimit / 2)));

  // Existing queries
  for (const st of targetStates) {
    for (const industry of targetIndustries) {
      queries.push(
        `"${industry}" company in ${stateName(st)} employees HR benefits`,
        `${industry} business ${stateName(st)} founder CEO operations team`
      );
    }
  }

  // 🔥 LAW FIRM TARGETING BOOST (CORRECT LOCATION)
  for (const st of targetStates) {
    queries.push(
      `law firm in ${stateName(st)} 20-200 employees`,
      `personal injury law firm ${stateName(st)} team attorneys staff size`,
      `mid size law firm ${stateName(st)} hiring attorneys benefits`,
      `litigation firm ${stateName(st)} office expansion team`
    );
  }

  return queries.slice(0, maxQueries);
}

async function searchSerper(query, num = 8) {
  const response = await axios.post(
    'https://google.serper.dev/search',
    {
      q: query,
      num,
      gl: 'us',
      hl: 'en'
    },
    {
      headers: {
        'X-API-KEY': process.env.SERPER_API_KEY,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    }
  );

  return response.data || {};
}

async function extractCandidatesWithOpenAI(searchPayload, config) {
  const prompt = `
You are a Benefits Modernization Scout for WellMor Benefits & Co.

Your job:
Identify Southeast U.S. companies that may be strong employee-benefits consulting prospects.

Target ICP:
- 20 to 150 employees is ideal
- Southeast states: ${config.targetStates.join(', ')}
- Target industries: ${config.targetIndustries.join(', ')}
- Focus on regional or privately held firms when possible
- Avoid Fortune 1000 or obviously huge enterprises
- Prefer companies showing growth, hiring, multi-location, or operational complexity
- Try to identify likely decision-maker roles such as Founder, CEO, CFO, HR Director, VP People, Operations Leader

IMPORTANT EXCLUSIONS:
Do NOT include companies that are likely:
- HR consulting firms
- benefits brokers
- insurance brokers
- PEOs
- staffing firms
- recruiting firms
- payroll services firms
- direct competitors to WellMor

Excluded industries:
${config.excludedIndustries.join(', ')}

Excluded keywords:
${config.excludedKeywords.join(', ')}

From the search results provided, extract only plausible company prospects.

Return JSON only in this shape:
{
  "candidates": [
    {
      "company": "string",
      "website": "string or null",
      "industry": "string or null",
      "state": "2-letter abbreviation if possible, else null",
      "employee_count": 50,
      "size": "20-50",
      "growth_signal": true,
      "contact_name": "string or null",
      "contact_title": "string or null",
      "contact_email": null,
      "contact_linkedin_url": null,
      "reason": "short explanation",
      "confidence": 0.0,
      "source_urls": ["https://..."]
    }
  ]
}

Rules:
- Exclude HR/benefits/payroll/recruiting/staffing competitors.
- Only include candidates with reasonable evidence from titles/snippets/links.
- If employee count is unknown, set employee_count to null.
- If website is unclear, infer from domain only when highly likely.
- Confidence should be between 0 and 1.
- JSON only. No markdown.
`;

  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: OPENAI_MODEL,
      temperature: 0.3,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'You extract structured prospecting candidates from web search results.' },
        { role: 'user', content: `${prompt}\n\nSearch results JSON:\n${JSON.stringify(searchPayload)}` }
      ]
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 60000
    }
  );

  const raw = response.data?.choices?.[0]?.message?.content || '{}';
  const cleaned = stripCodeFences(raw);

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    logger.error('OpenAI JSON parse failed', { raw: cleaned });
    throw new Error('Failed to parse OpenAI candidate extraction output');
  }

  return safeArray(parsed.candidates);
}

async function insertClient(candidate, score) {
  const payload = {
    company: candidate.company,
    industry: candidate.industry || null,
    size: normalizeSize(candidate.employee_count, candidate.size),
    status: 'Pending',
    lifecycle_stage: 'prospect',
    morgan_notes: [
      candidate.reason ? `Reason: ${candidate.reason}` : null,
      candidate.website ? `Website: ${candidate.website}` : null,
      candidate.state ? `State: ${candidate.state}` : null,
      candidate.employee_count ? `Employees: ${candidate.employee_count}` : null,
      `Score: ${score}`,
      candidate.source_urls?.length ? `Sources: ${candidate.source_urls.join(', ')}` : null
    ].filter(Boolean).join(' | ')
  };

  const { data, error } = await supabase
    .from('clients')
    .insert([payload])
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function insertContact(clientId, candidate) {
  if (!candidate.contact_email && !candidate.contact_name && !candidate.contact_title) {
    return null;
  }

  const { first_name, last_name } = splitName(candidate.contact_name);

  const payload = {
    client_id: clientId,
    first_name,
    last_name,
    title: candidate.contact_title || null,
    email: candidate.contact_email || null,
    linkedin_url: candidate.contact_linkedin_url || null,
    role_in_buying: 'decision_maker',
    is_primary_contact: true,
    contact_status: 'active',
    source: 'serper_openai',
    notes: candidate.reason || null
  };

  const { data, error } = await supabase
    .from('contacts')
    .insert([payload])
    .select()
    .single();

  if (error) {
    logger.warn('Contact insert failed', error);
    return null;
  }

  return data;
}

async function candidateAlreadyExists(candidate) {
  const website = candidate.website ? candidate.website.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '') : null;

  const { data: existingByCompany, error: companyErr } = await supabase
    .from('clients')
    .select('id, company, morgan_notes')
    .eq('company', candidate.company)
    .maybeSingle();

  if (companyErr) throw companyErr;
  if (existingByCompany) return existingByCompany;

  if (website) {
    const { data: possibleMatches, error: websiteErr } = await supabase
      .from('clients')
      .select('id, company, morgan_notes')
      .ilike('morgan_notes', `%${website}%`);

    if (websiteErr) throw websiteErr;
    if (possibleMatches && possibleMatches.length > 0) return possibleMatches[0];
  }

  return null;
}

async function run(options = {}) {
  if (!process.env.SERPER_API_KEY) {
    throw new Error('SERPER_API_KEY is required for Serper-based prospecting');
  }
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required for OpenAI-based prospecting');
  }

  const targetStates = await getSystemConfig('target_states');
  const minEmployees = await getSystemConfig('min_employees');
  const maxEmployees = await getSystemConfig('max_employees');
  const targetIndustries = await getSystemConfig('target_industries');
  const excludedIndustries = await getSystemConfig('excluded_industries');
  const excludedKeywords = await getSystemConfig('excluded_keywords');
  const dailyLimit = Number(options.limit || await getSystemConfig('daily_limit') || 25);

  if (!targetStates || !minEmployees || !maxEmployees || !targetIndustries) {
    throw new Error('Missing required ICP configuration in system_config');
  }

  const config = {
    targetStates: safeArray(targetStates).map(normalizeState),
    targetIndustries: safeArray(targetIndustries).map(normalizeIndustry),
    excludedIndustries: safeArray(excludedIndustries).map(normalizeIndustry),
    excludedKeywords: safeArray(excludedKeywords),
    minEmployees: Number(minEmployees),
    maxEmployees: Number(maxEmployees),
    dailyLimit
  };

  logger.info('Starting Serper + OpenAI hybrid prospecting run', config);

  const queries = buildQueries(config.targetStates, config.targetIndustries, dailyLimit);
  const allSearchResults = [];

  for (const query of queries) {
    try {
      const searchData = await searchSerper(query, 8);
      allSearchResults.push({
        query,
        organic: searchData.organic || [],
        knowledgeGraph: searchData.knowledgeGraph || null,
        answerBox: searchData.answerBox || null
      });
    } catch (err) {
      logger.warn(`Serper query failed: ${query}`, { error: err.message });
    }
  }

  if (!allSearchResults.length) {
    return {
      success: true,
      inserted: 0,
      skipped: 0,
      processed: [],
      errors: ['No search results returned from Serper'],
      duration_ms: 0
    };
  }

  const extracted = await extractCandidatesWithOpenAI({ results: allSearchResults }, config);
  const filtered = extracted.filter(candidate => !isExcludedCandidate(candidate, config));

  const deduped = uniqueBy(
    filtered.filter(c => c && c.company),
    c => (c.website || c.company).toLowerCase()
  );

  let inserted = 0;
  let skipped = 0;
  const processed = [];
  const errors = [];

  for (const candidate of deduped) {
    try {
      const score = scoreCandidate(candidate, config);

      if (score < SCORE_THRESHOLD) {
        skipped++;
        processed.push({
          company: candidate.company,
          action: 'skipped_low_score_or_excluded',
          score
        });
        continue;
      }

      const existing = await candidateAlreadyExists(candidate);
      if (existing) {
        skipped++;
        processed.push({
          company: candidate.company,
          action: 'duplicate',
          score,
          existing_client_id: existing.id
        });
        continue;
      }

      const client = await insertClient(candidate, score);
      const contact = await insertContact(client.id, candidate);

      inserted++;
      processed.push({
        company: candidate.company,
        action: 'inserted',
        score,
        client_id: client.id,
        contact_id: contact ? contact.id : null,
        website: candidate.website || null
      });

      logger.info('Inserted prospect', {
        company: candidate.company,
        score,
        client_id: client.id
      });
    } catch (err) {
      logger.error('Candidate processing failed', err);
      errors.push({
        company: candidate.company || null,
        error: err.message
      });
    }
  }

  return {
    success: true,
    inserted,
    skipped,
    processed,
    errors,
    query_count: queries.length,
    raw_candidate_count: extracted.length,
    filtered_candidate_count: filtered.length,
    deduped_candidate_count: deduped.length
  };
}

router.post('/', async (req, res) => {
  try {
    const result = await run(req.body || {});
    res.json(result);
  } catch (error) {
    logger.error('Prospecting route failed', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
module.exports.run = run;
