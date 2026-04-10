/**
 * Meeting Prep Agent
 * Generates comprehensive meeting briefings via Calendly webhook
 * Creates detailed research documents for discovery calls
 */

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { createLogger } = require('./shared/logger');
const { askClaudeJSON } = require('./shared/claude');
const {
  supabase,
  getLeadWithDetails,
  createActivityLog
} = require('./shared/supabase');

const logger = createLogger('MeetingPrepAgent');
const router = express.Router();

/**
 * Convert briefing JSON to Markdown
 * @param {Object} briefing - Briefing object
 * @returns {string} Markdown formatted briefing
 */
function briefingToMarkdown(briefing) {
  let md = `# Meeting Briefing: ${briefing.at_a_glance.company_name}\n\n`;

  // At a Glance
  md += `## At a Glance\n`;
  md += `**Company:** ${briefing.at_a_glance.company_name}\n`;
  md += `**Contact:** ${briefing.at_a_glance.contact_name} (${briefing.at_a_glance.contact_title})\n`;
  md += `**Industry:** ${briefing.at_a_glance.industry}\n`;
  md += `**Size:** ${briefing.at_a_glance.employee_count} employees\n`;
  md += `**Location:** ${briefing.at_a_glance.location}\n`;
  md += `**ICP Match:** ${briefing.at_a_glance.icp_match_score}/10\n\n`;

  // Why We Targeted This Company
  md += `## Why We Targeted This Company\n`;
  md += briefing.why_targeted + '\n\n';

  // Company Overview
  md += `## Company Overview\n`;
  md += briefing.company_overview + '\n\n';

  // Contact Profile
  md += `## Contact Profile\n`;
  md += briefing.contact_profile + '\n\n';

  // Conversation History
  md += `## Conversation History\n`;
  if (briefing.conversation_history && briefing.conversation_history.length > 0) {
    for (const message of briefing.conversation_history) {
      md += `**${message.sender}** (${message.date}):\n`;
      md += `> ${message.text}\n\n`;
    }
  } else {
    md += `No previous communication.\n\n`;
  }

  // Pain Points
  md += `## Likely Pain Points\n`;
  if (briefing.pain_points && Array.isArray(briefing.pain_points)) {
    for (const pain of briefing.pain_points) {
      md += `- ${pain}\n`;
    }
  } else {
    md += briefing.pain_points + '\n';
  }
  md += '\n';

  // Discovery Questions
  md += `## Discovery Questions\n`;
  if (briefing.discovery_questions && Array.isArray(briefing.discovery_questions)) {
    briefing.discovery_questions.forEach((q, i) => {
      md += `${i + 1}. ${q}\n`;
    });
  }
  md += '\n';

  // Competitive & Context Notes
  md += `## Competitive & Context Notes\n`;
  md += briefing.competitive_notes + '\n';

  return md;
}

/**
 * Generate comprehensive meeting briefing using Claude
 * @param {Object} leadDetails - Full lead details with company and contact
 * @returns {Promise<Object>} Briefing object
 */
async function generateBriefing(leadDetails) {
  try {
    const lead = leadDetails;
    const company = lead.company;
    const contact = lead.contacts?.[0];
    const emails = lead.emails || [];

    // Build context message
    const emailHistory = emails
      .map(
        e => `Date: ${e.created_at}
From: ${e.direction === 'sent' ? 'Morgan' : contact.name}
Subject: ${e.subject}
Body: ${e.body}`
      )
      .join('\n---\n');

    const userMessage = `Generate a comprehensive meeting briefing for a discovery call with this prospect:

COMPANY DATA:
Name: ${company.name}
Industry: ${company.industry}
Size: ${company.employees} employees
Location: ${company.hq_city}, ${company.hq_state}
Website: ${company.website || 'Not provided'}
Description: ${company.description || 'Not provided'}
Benefits Signals: ${company.benefits_signals || 'None'}
Growth Signals: ${company.growth_signals || 'None'}

CONTACT DATA:
Name: ${contact.name}
Title: ${contact.title}
Email: ${contact.email}

CONVERSATION HISTORY:
${emailHistory || 'No previous emails'}

Please generate a comprehensive briefing with all 8 sections. Return as JSON with these exact keys:
{
  "at_a_glance": {
    "company_name": string,
    "contact_name": string,
    "contact_title": string,
    "industry": string,
    "employee_count": number,
    "location": string,
    "icp_match_score": number (0-10),
    "engagement_stage": string
  },
  "why_targeted": string (2-3 sentences),
  "company_overview": string (3-4 sentences),
  "contact_profile": string (2-3 sentences),
  "conversation_history": [
    {
      "sender": string,
      "date": string,
      "text": string
    }
  ],
  "pain_points": [string],
  "discovery_questions": [string] (5-8 questions),
  "competitive_notes": string (2-3 sentences)
}`;

    const systemPrompt = `You are a research analyst for WellMor Benefits & Co., preparing a briefing document for consultant Morgan before a discovery call. Your job is to create a thorough, insightful briefing that helps Morgan walk into this meeting more prepared than the prospect expects.

Write in a direct, confident style. Make assertions based on evidence ("This company is likely dealing with X because Y") not hedge everything ("might possibly perhaps").

WellMor helps companies with: benefits plan design, benchmarking, cost reduction, employee experience, and benefits strategy for growing companies.

Focus on what Morgan should know before the call, what pain points the prospect likely has, and what questions will help qualify them for WellMor's services.`;

    const briefing = await askClaudeJSON(systemPrompt, userMessage, {
      maxTokens: 3000
    });

    return briefing;
  } catch (error) {
    logger.error('Error generating briefing', error);
    throw error;
  }
}

/**
 * Send Slack notification about meeting
 * @param {Object} briefing - Briefing object
 * @param {string} meetingTime - Meeting time
 * @returns {Promise<void>}
 */
async function sendSlackNotification(briefing, meetingTime) {
  try {
    const slackWebhook = process.env.SLACK_WEBHOOK_URL;
    if (!slackWebhook) {
      logger.warn('SLACK_WEBHOOK_URL not configured');
      return;
    }

    const questions = briefing.discovery_questions
      .slice(0, 3)
      .map((q, i) => `${i + 1}. ${q}`)
      .join('\n');

    const payload = {
      text: `Meeting Booked: ${briefing.at_a_glance.company_name}`,
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: `Meeting Booked: ${briefing.at_a_glance.company_name}`
          }
        },
        {
          type: 'section',
          fields: [
            {
              type: 'mrkdwn',
              text: `*Contact:*\n${briefing.at_a_glance.contact_name}\n${briefing.at_a_glance.contact_title}`
            },
            {
              type: 'mrkdwn',
              text: `*Time:*\n${meetingTime}`
            },
            {
              type: 'mrkdwn',
              text: `*Company:*\n${briefing.at_a_glance.company_name}`
            },
            {
              type: 'mrkdwn',
              text: `*ICP Match:*\n${briefing.at_a_glance.icp_match_score}/10`
            }
          ]
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Key Discovery Questions:*\n${questions}`
          }
        }
      ]
    };

    await axios.post(slackWebhook, payload);
    logger.info('Sent Slack notification about meeting');
  } catch (error) {
    logger.warn('Could not send Slack notification', error.message);
  }
}

/**
 * Send email briefing via Resend
 * @param {string} recipientEmail - Recipient email
 * @param {string} briefingMarkdown - Briefing in Markdown
 * @param {Object} briefing - Briefing object
 * @returns {Promise<void>}
 */
async function sendEmailBriefing(recipientEmail, briefingMarkdown, briefing) {
  try {
    // Convert Markdown to basic HTML for email
    const emailHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            h1 { color: #0066cc; border-bottom: 2px solid #0066cc; padding-bottom: 10px; }
            h2 { color: #0066cc; margin-top: 20px; }
            .section { margin-bottom: 20px; }
            .highlight { background-color: #f0f0f0; padding: 10px; border-left: 3px solid #0066cc; }
            ul { margin: 10px 0; padding-left: 20px; }
            li { margin: 5px 0; }
          </style>
        </head>
        <body>
          <h1>${briefing.at_a_glance.company_name} - Discovery Call Briefing</h1>

          <div class="section">
            <h2>At a Glance</h2>
            <p><strong>Contact:</strong> ${briefing.at_a_glance.contact_name} (${briefing.at_a_glance.contact_title})</p>
            <p><strong>Company:</strong> ${briefing.at_a_glance.company_name}</p>
            <p><strong>Industry:</strong> ${briefing.at_a_glance.industry}</p>
            <p><strong>Size:</strong> ${briefing.at_a_glance.employee_count} employees</p>
            <p><strong>Location:</strong> ${briefing.at_a_glance.location}</p>
            <p><strong>ICP Match:</strong> ${briefing.at_a_glance.icp_match_score}/10</p>
          </div>

          <div class="section">
            <h2>Why We Targeted This Company</h2>
            <p>${briefing.why_targeted}</p>
          </div>

          <div class="section">
            <h2>Company Overview</h2>
            <p>${briefing.company_overview}</p>
          </div>

          <div class="section">
            <h2>Likely Pain Points</h2>
            <ul>
              ${briefing.pain_points.map(p => `<li>${p}</li>`).join('')}
            </ul>
          </div>

          <div class="section highlight">
            <h2>Discovery Questions</h2>
            <ol>
              ${briefing.discovery_questions.map(q => `<li>${q}</li>`).join('')}
            </ol>
          </div>

          <div class="section">
            <h2>Competitive & Context Notes</h2>
            <p>${briefing.competitive_notes}</p>
          </div>

          <hr />
          <p><em>Briefing generated by WellMor AI at ${new Date().toISOString()}</em></p>
        </body>
      </html>
    `;

    await axios.post(
      'https://api.resend.com/emails',
      {
        from: 'briefings@wellmorbenefits.com',
        to: recipientEmail,
        subject: `Briefing: ${briefing.at_a_glance.company_name} Discovery Call`,
        html: emailHtml
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    logger.info(`Sent briefing email to ${recipientEmail}`);
  } catch (error) {
    logger.error(`Could not send briefing email to ${recipientEmail}`, error.message);
  }
}

/**
 * Handle Calendly meeting booked webhook
 * @param {Object} webhookData - Webhook data from Calendly
 * @returns {Promise<Object>} Result
 */
async function handleMeetingBooked(webhookData) {
  const {
    calendly_event_id,
    invitee_email,
    invitee_name,
    start_time,
    event_type_name
  } = webhookData;

  try {
    logger.info('Processing meeting booked', {
      event: event_type_name,
      invitee: invitee_email,
      startTime: start_time
    });

    // Find contact by email
    const { data: contact, error: contactError } = await supabase
      .from('contacts')
      .select('id, company_id')
      .eq('email', invitee_email)
      .single();

    if (contactError || !contact) {
      logger.error(`Contact not found: ${invitee_email}`);
      return { success: false, message: 'Contact not found' };
    }

    // Get full lead details
    const { data: lead, error: leadError } = await supabase
      .from('leads')
      .select(`
        *,
        company:company_id(*),
        contacts(id, name, email, title),
        emails:lead_emails(*)
      `)
      .eq('company_id', contact.company_id)
      .single();

    if (leadError || !lead) {
      logger.error(`Lead not found for company ${contact.company_id}`);
      return { success: false, message: 'Lead not found' };
    }

    // Create meeting record
    const meetingId = uuidv4();
    const { data: meeting } = await supabase
      .from('meetings')
      .insert([
        {
          id: meetingId,
          lead_id: lead.id,
          contact_id: contact.id,
          calendly_event_id,
          scheduled_at: start_time,
          status: 'scheduled',
          created_at: new Date().toISOString()
        }
      ])
      .select()
      .single();

    logger.info(`Created meeting record: ${meetingId}`);

    // Generate briefing
    const briefing = await generateBriefing(lead);
    logger.success('Generated meeting briefing');

    // Convert to Markdown
    const briefingMarkdown = briefingToMarkdown(briefing);

    // Store briefing in Supabase
    const { data: storedBriefing } = await supabase
      .from('meeting_briefings')
      .insert([
        {
          id: uuidv4(),
          meeting_id: meetingId,
          briefing_data: briefing,
          briefing_markdown: briefingMarkdown,
          created_at: new Date().toISOString()
        }
      ])
      .select()
      .single();

    logger.info('Stored briefing in database');

    // Send Slack notification
    await sendSlackNotification(briefing, start_time);

    // Send email briefing
    const morganEmail = process.env.MORGAN_EMAIL || 'morgan@wellmorbenefits.com';
    await sendEmailBriefing(morganEmail, briefingMarkdown, briefing);

    // Update meeting record
    await supabase
      .from('meetings')
      .update({
        briefing_generated: true,
        consultant_notified_at: new Date().toISOString()
      })
      .eq('id', meetingId);

    // Log activity
    await createActivityLog('MeetingPrepAgent', 'meeting_booked', 'lead', lead.id, {
      meeting_id: meetingId,
      contact_email: invitee_email,
      scheduled_at: start_time
    });

    logger.success('Meeting prep completed', {
      meetingId,
      company: lead.company.name,
      contact: invitee_email
    });

    return {
      success: true,
      meeting_id: meetingId,
      briefing_id: storedBriefing.id
    };
  } catch (error) {
    logger.error('Error handling meeting booked webhook', error);
    throw error;
  }
}

/**
 * Express route handler for webhook
 */
router.post('/meeting-booked', async (req, res) => {
  try {
    const result = await handleMeetingBooked(req.body);
    res.json({
      success: result.success,
      data: result
    });
  } catch (error) {
    logger.error('Webhook handler error', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = {
  handleMeetingBooked,
  generateBriefing,
  router
};
