/**
 * Reply Classification Agent
 * Handles inbound reply classification via Instantly.ai webhook
 * Routes replies to appropriate actions based on sentiment and intent
 */

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { createLogger } = require('./shared/logger');
const { askGPTJSON } = require('./shared/openai');
const { askClaude } = require('./shared/claude');
const {
  supabase,
  updateLeadStatus,
  createActivityLog
} = require('./shared/supabase');

const logger = createLogger('ReplyClassificationAgent');
const router = express.Router();

/**
 * Classify reply using GPT-4o
 * @param {string} replyText - Reply text to classify
 * @returns {Promise<Object>} Classification result
 */
async function classifyReply(replyText) {
  try {
    const systemPrompt = `Classify this email reply from a prospect of WellMor Benefits consulting into exactly one of these categories:
- interested: prospect wants to learn more, asks about services, agrees to meet, says call me, let's chat, etc.
- positive_objection: currently has a broker/plan, recently renewed, not the right time but open in future
- firm_no: definitively not interested, please stop emailing, remove me (but did NOT use unsubscribe link)
- unsubscribe: explicitly asks to be removed, opt out, stop all emails
- out_of_office: automatic OOO reply, vacation, parental leave
- wrong_person: not the right person, please contact someone else, or clearly misaddressed
- needs_more_info: asks a question, wants to know more before deciding

Return JSON: {classification, confidence (0-1), key_phrases (array), return_date (if OOO, ISO date or null), forwarding_contact (if wrong_person, name/email or null), notes}`;

    const userMessage = `Classify this reply:\n\n${replyText}`;

    const classification = await askGPTJSON(systemPrompt, userMessage, {
      maxTokens: 1024
    });

    return classification;
  } catch (error) {
    logger.error('Error classifying reply', error);
    throw error;
  }
}

/**
 * Stop campaign in Instantly.ai
 * @param {string} campaignId - Campaign ID
 * @returns {Promise<void>}
 */
async function stopInstantlyAiCampaign(campaignId) {
  try {
    await axios.post(
      `https://api.instantly.ai/api/v1/campaign/${campaignId}/stop`,
      {},
      {
        headers: {
          'Authorization': `Bearer ${process.env.INSTANTLY_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    logger.info(`Stopped Instantly.ai campaign: ${campaignId}`);
  } catch (error) {
    logger.warn(`Could not stop campaign ${campaignId}`, error.message);
  }
}

/**
 * Pause campaign in Instantly.ai (without stopping)
 * @param {string} campaignId - Campaign ID
 * @returns {Promise<void>}
 */
async function pauseInstantlyAiCampaign(campaignId) {
  try {
    await axios.post(
      `https://api.instantly.ai/api/v1/campaign/${campaignId}/pause`,
      {},
      {
        headers: {
          'Authorization': `Bearer ${process.env.INSTANTLY_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    logger.info(`Paused Instantly.ai campaign: ${campaignId}`);
  } catch (error) {
    logger.warn(`Could not pause campaign ${campaignId}`, error.message);
  }
}

/**
 * Send Calendly link email via Resend
 * @param {Object} contact - Contact object
 * @param {string} contactEmail - Contact email
 * @returns {Promise<void>}
 */
async function sendCalendlyEmail(contact, contactEmail) {
  try {
    const calendlyLink = process.env.CALENDLY_LINK || 'https://calendly.com/morgan-wellmor';

    const emailHtml = `
      <h2>Great! Let's chat</h2>
      <p>Thanks for your interest in WellMor Benefits. I'd love to learn more about your benefits strategy.</p>
      <p><a href="${calendlyLink}" style="display: inline-block; padding: 12px 24px; background-color: #0066cc; color: white; text-decoration: none; border-radius: 4px;">Pick a time that works for you</a></p>
      <p>Looking forward to it!</p>
      <p>Morgan<br/>WellMor Benefits & Co.</p>
    `;

    await axios.post(
      'https://api.resend.com/emails',
      {
        from: 'morgan@wellmorbenefits.com',
        to: contactEmail,
        subject: 'Let\'s schedule a call - WellMor Benefits',
        html: emailHtml
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    logger.info(`Sent Calendly link to ${contactEmail}`);
  } catch (error) {
    logger.error(`Could not send Calendly email to ${contactEmail}`, error.message);
  }
}

/**
 * Send acknowledgment email for positive objection
 * @param {string} contactEmail - Contact email
 * @param {string} contactName - Contact name
 * @returns {Promise<void>}
 */
async function sendAcknowledgmentEmail(contactEmail, contactName) {
  try {
    const emailHtml = `
      <p>Thanks for getting back to me, ${contactName}. I appreciate you letting me know your timeline.</p>
      <p>I'll keep an eye on your situation and circle back when the time is right. In the meantime, feel free to reach out if you have any questions about benefits.</p>
      <p>Best,<br/>Morgan<br/>WellMor Benefits & Co.</p>
    `;

    await axios.post(
      'https://api.resend.com/emails',
      {
        from: 'morgan@wellmorbenefits.com',
        to: contactEmail,
        subject: 'Thanks for the update',
        html: emailHtml
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    logger.info(`Sent acknowledgment email to ${contactEmail}`);
  } catch (error) {
    logger.error(`Could not send acknowledgment email to ${contactEmail}`, error.message);
  }
}

/**
 * Generate draft response for needs_more_info classification
 * @param {Object} lead - Lead object
 * @param {string} replyText - Original reply text
 * @returns {Promise<string>} Draft response
 */
async function generateDraftResponse(lead, replyText) {
  try {
    const systemPrompt = `You are a sales consultant for WellMor Benefits & Co. Generate a concise, helpful response to a prospect's question about benefits consulting.

Be warm, professional, and specific to their question. Keep it under 100 words. Sign as Morgan.`;

    const userMessage = `Company: ${lead.company.name}
Contact: ${lead.contacts[0]?.name}

Prospect's question: "${replyText}"

Generate a helpful response that addresses their question and gently moves toward a call.`;

    const draftResponse = await askClaude(systemPrompt, userMessage, {
      maxTokens: 512,
      temperature: 0.7
    });

    return draftResponse;
  } catch (error) {
    logger.error('Error generating draft response', error);
    throw error;
  }
}

/**
 * Send Slack notification
 * @param {string} message - Message to send
 * @param {string} additionalContext - Optional additional context
 * @returns {Promise<void>}
 */
async function sendSlackNotification(message, additionalContext = '') {
  try {
    const slackWebhook = process.env.SLACK_WEBHOOK_URL;
    if (!slackWebhook) {
      logger.warn('SLACK_WEBHOOK_URL not configured');
      return;
    }

    const payload = {
      text: message,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: message
          }
        }
      ]
    };

    if (additionalContext) {
      payload.blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: additionalContext
        }
      });
    }

    await axios.post(slackWebhook, payload);
    logger.info('Sent Slack notification');
  } catch (error) {
    logger.warn('Could not send Slack notification', error.message);
  }
}

/**
 * Create pending task for future action
 * @param {string} taskType - Type of task
 * @param {string} leadId - Lead ID
 * @param {Object} metadata - Task metadata
 * @returns {Promise<Object>} Created task
 */
async function createPendingTask(taskType, leadId, metadata = {}) {
  try {
    const { data, error } = await supabase
      .from('pending_tasks')
      .insert([
        {
          task_type: taskType,
          lead_id: leadId,
          status: 'pending',
          metadata,
          created_at: new Date().toISOString()
        }
      ])
      .select()
      .single();

    if (error) {
      throw error;
    }

    return data;
  } catch (error) {
    logger.error('Error creating pending task', error);
    throw error;
  }
}

/**
 * Handle reply webhook
 * @param {Object} webhookData - Webhook data from Instantly.ai
 * @returns {Promise<Object>} Action taken
 */
async function handleReply(webhookData) {
  const { email_id, contact_email, reply_text, thread_id, campaign_id } = webhookData;

  try {
    logger.info('Processing reply', {
      email: contact_email,
      campaignId: campaign_id
    });

    // Find contact and lead
    const { data: contact, error: contactError } = await supabase
      .from('contacts')
      .select('id, name, company_id')
      .eq('email', contact_email)
      .single();

    if (contactError || !contact) {
      logger.error(`Contact not found: ${contact_email}`);
      return { action: 'error', message: 'Contact not found' };
    }

    const { data: lead, error: leadError } = await supabase
      .from('leads')
      .select('*, company:company_id(*)')
      .eq('company_id', contact.company_id)
      .single();

    if (leadError || !lead) {
      logger.error(`Lead not found for company ${contact.company_id}`);
      return { action: 'error', message: 'Lead not found' };
    }

    // Classify reply
    const classification = await classifyReply(reply_text);
    logger.info(`Reply classified as: ${classification.classification}`, {
      confidence: classification.confidence,
      keyPhrases: classification.key_phrases
    });

    // Get outreach campaign
    const { data: campaign } = await supabase
      .from('outreach_campaigns')
      .select('*')
      .eq('campaign_id', campaign_id)
      .single();

    // Update email record with reply info
    await supabase
      .from('lead_emails')
      .update({
        reply_text,
        reply_classification: classification.classification,
        replied_at: new Date().toISOString()
      })
      .eq('id', email_id);

    // Route based on classification
    let action = {};

    if (classification.classification === 'interested') {
      // Stop campaign and send Calendly link
      if (campaign_id) {
        await stopInstantlyAiCampaign(campaign_id);
      }

      await updateLeadStatus(lead.id, 'interested');
      await sendCalendlyEmail(contact, contact_email);

      await createActivityLog('ReplyClassificationAgent', 'reply_classified_interested', 'lead', lead.id, {
        contact_email,
        classification: classification.classification
      });

      action = {
        action: 'interested',
        message: 'Campaign stopped, Calendly link sent'
      };
    } else if (classification.classification === 'positive_objection') {
      // Stop campaign and create 90-day re-engagement task
      if (campaign_id) {
        await stopInstantlyAiCampaign(campaign_id);
      }

      await updateLeadStatus(lead.id, 'not_now');
      await sendAcknowledgmentEmail(contact_email, contact.name);

      const reengageDate = new Date();
      reengageDate.setDate(reengageDate.getDate() + 90);

      await createPendingTask('reengage', lead.id, {
        original_status: 'not_now',
        reengage_date: reengageDate.toISOString()
      });

      await createActivityLog('ReplyClassificationAgent', 'reply_classified_positive_objection', 'lead', lead.id, {
        contact_email,
        reengage_date: reengageDate.toISOString()
      });

      action = {
        action: 'positive_objection',
        message: 'Campaign stopped, re-engagement task created for 90 days'
      };
    } else if (classification.classification === 'firm_no') {
      // Stop campaign
      if (campaign_id) {
        await stopInstantlyAiCampaign(campaign_id);
      }

      await updateLeadStatus(lead.id, 'disqualified');

      await createActivityLog('ReplyClassificationAgent', 'reply_classified_firm_no', 'lead', lead.id, {
        contact_email
      });

      action = {
        action: 'firm_no',
        message: 'Campaign stopped, lead marked as disqualified'
      };
    } else if (classification.classification === 'unsubscribe') {
      // Stop campaign and mark contact as unsubscribed
      if (campaign_id) {
        await stopInstantlyAiCampaign(campaign_id);
      }

      await supabase
        .from('contacts')
        .update({
          unsubscribed: true,
          unsubscribed_at: new Date().toISOString()
        })
        .eq('id', contact.id);

      await updateLeadStatus(lead.id, 'disqualified');

      await createActivityLog('ReplyClassificationAgent', 'reply_classified_unsubscribe', 'lead', lead.id, {
        contact_email
      });

      action = {
        action: 'unsubscribe',
        message: 'Campaign stopped, contact marked as unsubscribed'
      };
    } else if (classification.classification === 'out_of_office') {
      // Pause campaign
      if (campaign_id) {
        await pauseInstantlyAiCampaign(campaign_id);
      }

      let resumeDate = null;
      if (classification.return_date) {
        const returnDate = new Date(classification.return_date);
        resumeDate = new Date(returnDate);
        resumeDate.setDate(resumeDate.getDate() + 2);

        await createPendingTask('resume_campaign', lead.id, {
          campaign_id,
          resume_date: resumeDate.toISOString()
        });
      }

      await createActivityLog('ReplyClassificationAgent', 'reply_classified_ooo', 'lead', lead.id, {
        contact_email,
        return_date: classification.return_date,
        resume_date: resumeDate?.toISOString()
      });

      action = {
        action: 'out_of_office',
        message: `Campaign paused. Will resume ${resumeDate ? 'on ' + resumeDate.toISOString().split('T')[0] : 'manually'}`
      };
    } else if (classification.classification === 'wrong_person') {
      // Stop campaign for this contact
      if (campaign_id) {
        await stopInstantlyAiCampaign(campaign_id);
      }

      await createActivityLog('ReplyClassificationAgent', 'reply_classified_wrong_person', 'lead', lead.id, {
        contact_email,
        forwarding_contact: classification.forwarding_contact
      });

      action = {
        action: 'wrong_person',
        message: `Contact requested to reach ${classification.forwarding_contact || 'someone else'}`
      };
    } else if (classification.classification === 'needs_more_info') {
      // Pause campaign and generate draft response
      if (campaign_id) {
        await pauseInstantlyAiCampaign(campaign_id);
      }

      const draftResponse = await generateDraftResponse(lead, reply_text);

      const { data: draft } = await supabase
        .from('draft_responses')
        .insert([
          {
            lead_id: lead.id,
            contact_id: contact.id,
            incoming_message: reply_text,
            draft_response: draftResponse,
            status: 'pending_review',
            created_at: new Date().toISOString()
          }
        ])
        .select()
        .single();

      await sendSlackNotification(
        `New question from ${lead.company.name} - ${contact.name}`,
        `*Incoming:* "${reply_text.substring(0, 100)}..."\n\n*Draft response ready for review*`
      );

      await createActivityLog('ReplyClassificationAgent', 'reply_classified_needs_info', 'lead', lead.id, {
        contact_email,
        question: reply_text.substring(0, 100)
      });

      action = {
        action: 'needs_more_info',
        message: 'Campaign paused, draft response created and Slack notification sent'
      };
    }

    logger.success(`Reply processed successfully`, action);
    return action;
  } catch (error) {
    logger.error('Error handling reply', error);
    throw error;
  }
}

/**
 * Express route handler for webhook
 */
router.post('/reply', async (req, res) => {
  try {
    const action = await handleReply(req.body);
    res.json({
      success: true,
      action
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
  handleReply,
  classifyReply,
  router
};
