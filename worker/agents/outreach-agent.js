/**
 * Outreach Agent (Schema-Aligned)
 *
 * - Reads enriched + outreach_ready clients
 * - Pulls top contacts
 * - Uses OpenAI to generate:
 *   1. cold email
 *   2. LinkedIn message
 *   3. call opener
 * - Inserts drafts into outreach_sequences + conversations
 * - Moves client lifecycle_stage to sequenced
 */

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { createLogger } = require('./shared/logger');
const { supabase } = require('./shared/supabase');

const logger = createLogger('OutreachAgent');
const router = express.Router();

const OPENAI_MODEL = process.env.OPENAI_RESEARCH_MODEL || 'gpt-4.1-mini';

function safeArray(v) {
  return Array.isArray(v) ? v : [];
}

function stripCodeFences(text) {
  if (!text) return text;
  return text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function contactDisplayName(contact) {
  return [contact.first_name, contact.last_name].filter(Boolean).join(' ').trim() || 'there';
}

async function fetchClientsForOutreach(limit = 10) {
  const { data, error } = await supabase
    .from('clients')
    .select('id, company, industry, size, lifecycle_stage, morgan_notes, lead_score, lead_tier, outreach_ready, outreach_recommendation, updated_at')
    .eq('lifecycle_stage', 'enriched')
    .eq('outreach_ready', true)
    .order('lead_score', { ascending: false, nullsFirst: false })
    .limit(limit);

  if (error) throw error;
  return data || [];
}

async function fetchContactsForClient(clientId) {
  const { data, error } = await supabase
    .from('contacts')
    .select('id, first_name, last_name, title, email, linkedin_url, role_in_buying, is_primary_contact')
    .eq('client_id', clientId)
    .order('is_primary_contact', { ascending: false });

  if (error) throw error;
  return data || [];
}

async function generateOutreach(client, contacts) {
  const prompt = `
You are writing outbound messaging for WellMor Benefits & Co.

Company:
- Company: ${client.company}
- Industry: ${client.industry || 'unknown'}
- Size: ${client.size || 'unknown'}
- Lead Score: ${client.lead_score || 'unknown'}
- Tier: ${client.lead_tier || 'unknown'}

Morgan Notes:
${client.morgan_notes || 'none'}

Contacts:
${JSON.stringify(contacts, null, 2)}

Write concise, professional outbound drafts.

Return JSON only in this exact shape:
{
  "email_subject": "string",
  "email_body": "string",
  "linkedin_message": "string",
  "call_opener": "string"
}

Rules:
- Email should be short, warm, and personalized.
- LinkedIn message should be shorter than the email.
- Call opener should sound natural for a first conversation.
- Do not sound spammy.
- Emphasize benefits modernization, competitiveness, growth, and employee experience when relevant.
- JSON only. No markdown.
`;

  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: OPENAI_MODEL,
      temperature: 0.4,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'You create outbound sales drafts for employee benefits consulting.'
        },
        {
          role: 'user',
          content: prompt
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
    logger.error('OpenAI outreach JSON parse failed', { raw: cleaned });
    throw new Error('Failed to parse OpenAI outreach output');
  }

  return parsed;
}

async function insertOutreachSequence(client, contact, drafts) {
  const { data, error } = await supabase
    .from('outreach_sequences')
    .insert([
      {
        client_id: client.id,
        contact_id: contact.id,
        sequence_name: 'WellMor Initial Outreach',
        sequence_type: 'multi_channel',
        sequence_status: 'draft',
        step_number: 1,
        message_subject: drafts.email_subject || null,
        message_body: drafts.email_body || null,
        reply_detected: false,
        meeting_booked: false
      }
    ])
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function insertConversation(client, contact, sequence, drafts) {
  const rows = [
    {
      client_id: client.id,
      contact_id: contact.id,
      sequence_id: sequence.id,
      channel: 'email',
      direction: 'outbound',
      message_subject: drafts.email_subject || null,
      message_body: drafts.email_body || null,
      sentiment: null,
      ai_classification: null,
      replied: false,
      meeting_requested: false
    },
    {
      client_id: client.id,
      contact_id: contact.id,
      sequence_id: sequence.id,
      channel: 'linkedin',
      direction: 'outbound',
      message_subject: null,
      message_body: drafts.linkedin_message || null,
      sentiment: null,
      ai_classification: null,
      replied: false,
      meeting_requested: false
    }
  ];

  const { error } = await supabase
    .from('conversations')
    .insert(rows);

  if (error) throw error;
}

async function updateClientSequenced(client, drafts) {
  const existingNotes = client.morgan_notes ? `${client.morgan_notes}\n\n` : '';

  const newNotes = [
    'OUTREACH DRAFTED:',
    `Email Subject: ${drafts.email_subject || ''}`,
    `LinkedIn Message: ${drafts.linkedin_message || ''}`,
    `Call Opener: ${drafts.call_opener || ''}`
  ].join('\n');

  const { data, error } = await supabase
    .from('clients')
    .update({
      lifecycle_stage: 'sequenced',
      morgan_notes: `${existingNotes}${newNotes}`
    })
    .eq('id', client.id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function run(options = {}) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required for outreach');
  }

  const limit = Number(options.limit || 10);
  const clients = await fetchClientsForOutreach(limit);

  if (!clients.length) {
    return {
      success: true,
      drafted: 0,
      message: 'No outreach-ready enriched clients available'
    };
  }

  let drafted = 0;
  const processed = [];
  const errors = [];

  for (const client of clients) {
    try {
      const contacts = await fetchContactsForClient(client.id);

      if (!contacts.length) {
        errors.push({
          client_id: client.id,
          company: client.company,
          error: 'No contacts available for outreach'
        });
        continue;
      }

      const targetContacts = safeArray(contacts).slice(0, 2);
      const primaryContact = targetContacts[0];

      const drafts = await generateOutreach(client, targetContacts);
      const sequence = await insertOutreachSequence(client, primaryContact, drafts);
      await insertConversation(client, primaryContact, sequence, drafts);
      await updateClientSequenced(client, drafts);

      drafted++;
      processed.push({
        client_id: client.id,
        company: client.company,
        contact_name: contactDisplayName(primaryContact),
        contact_title: primaryContact.title || null,
        lead_score: client.lead_score || null,
        tier: client.lead_tier || null,
        sequence_id: sequence.id
      });

      logger.info('Drafted outreach for client', {
        company: client.company,
        sequence_id: sequence.id
      });
    } catch (err) {
      logger.error('Outreach generation failed', err);
      errors.push({
        client_id: client.id,
        company: client.company,
        error: err.message
      });
    }
  }

  const result = {
    success: true,
    drafted,
    processed,
    errors
  };

  logger.info('Outreach run completed', result);
  return result;
}

router.post('/', async (req, res) => {
  try {
    const result = await run(req.body || {});
    res.json(result);
  } catch (error) {
    logger.error('Outreach route failed', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
module.exports.run = run;
