/**
 * Enrichment Agent (Serper + OpenAI Hybrid) - v2
 *
 * What this does:
 * - Reads prospect-stage clients from Supabase
 * - Uses Serper to gather public web context
 * - Uses OpenAI to extract company details + likely contacts
 * - Ranks contacts and keeps the best 2
 * - Updates clients and inserts contacts
 */

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { createLogger } = require('./shared/logger');
const { supabase } = require('./shared/supabase');

const logger = createLogger('EnrichmentAgent');
const router = express.Router();

const OPENAI_MODEL = process.env.OPENAI_RESEARCH_MODEL || 'gpt-4.1-mini';

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
  if (parts.length === 1) {
    return { first_name: parts[0], last_name: null };
  }
  return {
    first_name: parts[0],
    last_name: parts.slice(1).join(' ')
  };
}

function safeArray(val) {
  return Array.isArray(val) ? val : [];
}

function assignRole(title = '') {
  const t = String(title).toLowerCase();

  if (
    t.includes('hr') ||
    t.includes('people') ||
    t.includes('human resources') ||
    t.includes('benefits')
  ) {
    return 'decision_maker';
  }

  if (
    t.includes('finance') ||
    t.includes('operations') ||
    t.includes('ops') ||
    t.includes('coo')
  ) {
    return 'influencer';
  }

  if (
    t.includes('ceo') ||
    t.includes('founder') ||
    t.includes('owner') ||
    t.includes('president')
  ) {
    return 'decision_maker';
  }

  return 'influencer';
}

function rankContacts(contacts = []) {
  return contacts
    .map(contact => {
      const title = String(contact.title || '').toLowerCase();

      let score = 0;

      if (title.includes('hr')) score += 4;
      if (title.includes('people')) score += 4;
      if (title.includes('benefits')) score += 4;
      if (title.includes('human resources')) score += 4;

      if (title.includes('finance')) score += 3;
      if (title.includes('operations')) score += 3;
      if (title.includes('ops')) score += 2;
      if (title.includes('coo')) score += 3;

      if (title.includes('ceo')) score += 3;
      if (title.includes('founder')) score += 3;
      if (title.includes('owner')) score += 3;
      if (title.includes('president')) score += 3;

      if (contact.email) score += 1;
      if (contact.linkedin_url) score += 1;

      return {
        ...contact,
        _ranking_score: score
      };
    })
    .sort((a, b) => b._ranking_score - a._ranking_score);
}

async function searchSerper(query, num = 6) {
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

async function fetchClientsToEnrich(limit = 10) {
  const { data, error } = await supabase
    .from('clients')
    .select('id, company, industry, size, lifecycle_stage, morgan_notes, updated_at')
    .eq('lifecycle_stage', 'prospect')
    .order('updated_at', { ascending: true, nullsFirst: true })
    .limit(limit);

  if (error) throw error;
  return data || [];
}

async function gatherPublicContext(client) {
  const queries = [
    `"${client.company}" company website`,
    `"${client.company}" about leadership`,
    `"${client.company}" linkedin company`,
    `"${client.company}" careers hiring`
  ];

  const results = [];

  for (const query of queries) {
    try {
      const data = await searchSerper(query, 6);
      results.push({
        query,
        organic: data.organic || [],
        knowledgeGraph: data.knowledgeGraph || null,
        answerBox: data.answerBox || null
      });
    } catch (err) {
      logger.warn(`Serper enrichment query failed for ${client.company}`, {
        query,
        error: err.message
      });
    }
  }

  return { company: client.company, results };
}

async function analyzeWithOpenAI(client, context) {
  const prompt = `
You are an enrichment analyst for WellMor Benefits & Co.

Your task:
Given public search results for a company, extract a clean company profile and identify likely buyer contacts for employee benefits consulting.

Target buyer titles:
- Founder
- CEO
- CFO
- COO
- Head of People
- VP People
- HR Director
- HR Manager
- Operations Director
- VP Finance

Return JSON only in this exact shape:
{
  "company_profile": {
    "website": "string or null",
    "description": "string or null",
    "industry": "string or null",
    "state": "2-letter abbreviation or null",
    "employee_count_estimate": 75,
    "growth_signals": ["string"],
    "benefits_signals": ["string"],
    "recommended_angle": "string or null",
    "confidence": 0.0
  },
  "contacts": [
    {
      "full_name": "string",
      "title": "string",
      "email": null,
      "linkedin_url": "string or null",
      "notes": "why this person matters"
    }
  ]
}

Rules:
- You MUST return at least 2 contacts if any plausible contacts can be inferred.
- Prefer returning 3-4 contacts when possible.
- If exact names are not available, infer likely titles (e.g. "Head of People", "HR Director", "VP Finance").
- Prefer senior decision-makers responsible for HR, benefits, finance, or operations.
- Use null for unknown fields, but still return the contact.
- JSON only. No markdown.
`;

  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: OPENAI_MODEL,
      temperature: 0.3,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'You extract structured company enrichment and buyer contacts from public search results.'
        },
        {
          role: 'user',
          content: `${prompt}\n\nClient record:\n${JSON.stringify(client, null, 2)}\n\nPublic search context:\n${JSON.stringify(context, null, 2)}`
        }
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
    logger.error('OpenAI enrichment JSON parse failed', { raw: cleaned });
    throw new Error('Failed to parse OpenAI enrichment output');
  }

  return {
    company_profile: parsed.company_profile || {},
    contacts: safeArray(parsed.contacts)
  };
}

async function updateClient(clientId, profile, selectedContacts) {
  const notes = [
    'WHY NOW:',
    `This company appears to be a potential fit for WellMor based on public signals and company profile.`,
    '',
    'TRIGGER:',
    `- Estimated employee count: ${profile.employee_count_estimate || 'unknown'}`,
    `- Industry: ${profile.industry || 'unknown'}`,
    `- State: ${profile.state || 'unknown'}`,
    `- Contacts found: ${selectedContacts.length}`,
    safeArray(profile.growth_signals).length
      ? `- Growth signals: ${profile.growth_signals.join('; ')}`
      : '- Growth signals: none identified',
    safeArray(profile.benefits_signals).length
      ? `- Benefits signals: ${profile.benefits_signals.join('; ')}`
      : '- Benefits signals: none identified',
    '',
    'ANGLE:',
    profile.recommended_angle ||
      'Helping growing companies simplify benefits while staying competitive and compliant.',
    '',
    'PERSONAS:',
    selectedContacts.length
      ? selectedContacts.map(c => `- ${c.full_name || 'Unknown'} | ${c.title || 'Unknown title'}`).join('\n')
      : '- No strong buyer contacts identified yet',
    '',
    'DESCRIPTION:',
    profile.description || 'No description identified',
    '',
    `ENRICHMENT CONFIDENCE: ${profile.confidence ?? 'unknown'}`,
    profile.website ? `WEBSITE: ${profile.website}` : null
  ]
    .filter(Boolean)
    .join('\n');

  const update = {
    lifecycle_stage: 'enriched',
    morgan_notes: notes
  };

  if (profile.industry) update.industry = profile.industry;

  const { data, error } = await supabase
    .from('clients')
    .update(update)
    .eq('id', clientId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function upsertContact(clientId, contact, index) {
  if (!contact || !contact.full_name) return null;

  const { first_name, last_name } = splitName(contact.full_name);

  const { data: existing, error: existingError } = await supabase
    .from('contacts')
    .select('id, first_name, last_name')
    .eq('client_id', clientId)
    .eq('first_name', first_name)
    .eq('last_name', last_name)
    .maybeSingle();

  if (existingError) throw existingError;
  if (existing) return existing;

  const payload = {
    client_id: clientId,
    first_name,
    last_name,
    title: contact.title || null,
    email: contact.email || null,
    linkedin_url: contact.linkedin_url || null,
    role_in_buying: assignRole(contact.title || ''),
    is_primary_contact: index === 0,
    contact_status: 'active',
    source: 'serper_openai_enrichment',
    notes: contact.notes || null
  };

  const { data, error } = await supabase
    .from('contacts')
    .insert([payload])
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function run(options = {}) {
  if (!process.env.SERPER_API_KEY) {
    throw new Error('SERPER_API_KEY is required for enrichment');
  }
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required for enrichment');
  }

  const limit = Number(options.limit || 10);
  const clients = await fetchClientsToEnrich(limit);

  if (!clients.length) {
    return {
      success: true,
      enriched: 0,
      contacts_added: 0,
      message: 'No prospect-stage clients available for enrichment'
    };
  }

  let enriched = 0;
  let contactsAdded = 0;
  const processed = [];
  const errors = [];

  for (const client of clients) {
    try {
      logger.info('Enriching client', { company: client.company, client_id: client.id });

      const context = await gatherPublicContext(client);
      const analysis = await analyzeWithOpenAI(client, context);

      const rankedContacts = rankContacts(analysis.contacts);
      const selectedContacts = rankedContacts.slice(0, 2);

      await updateClient(client.id, analysis.company_profile, selectedContacts);
      enriched++;

      for (let i = 0; i < selectedContacts.length; i++) {
        const inserted = await upsertContact(client.id, selectedContacts[i], i);
        if (inserted) contactsAdded++;
      }

      processed.push({
        client_id: client.id,
        company: client.company,
        contacts_found: selectedContacts.length,
        website: analysis.company_profile.website || null,
        confidence: analysis.company_profile.confidence || null
      });
    } catch (err) {
      logger.error('Client enrichment failed', err);
      errors.push({
        client_id: client.id,
        company: client.company,
        error: err.message
      });
    }
  }

  const result = {
    success: true,
    enriched,
    contacts_added: contactsAdded,
    processed,
    errors
  };

  logger.info('Enrichment run completed', result);
  return result;
}

router.post('/', async (req, res) => {
  try {
    const result = await run(req.body || {});
    res.json(result);
  } catch (error) {
    logger.error('Enrichment route failed', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
module.exports.run = run;
