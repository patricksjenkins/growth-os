/**
 * WellMor Notification Service
 * Sends email notifications for approval requests and system events.
 *
 * Uses Supabase Edge Functions or a simple SMTP approach.
 * For MVP, this generates notification records that n8n can pick up
 * and route to email/Slack.
 *
 * Required env vars (optional - notifications degrade gracefully):
 *   NOTIFICATION_EMAIL - Email address for approval notifications
 *   NOTIFICATION_WEBHOOK_URL - Webhook URL for push notifications (e.g., Slack incoming webhook)
 *   APP_URL - Public URL of the mobile app or web dashboard
 */

require('dotenv').config();
const axios = require('axios');
const { createLogger } = require('./shared/logger');
const { supabase } = require('./shared/supabase');

const logger = createLogger('NotificationService');

const NOTIFICATION_EMAIL = process.env.NOTIFICATION_EMAIL;
const NOTIFICATION_WEBHOOK_URL = process.env.NOTIFICATION_WEBHOOK_URL;
const APP_URL = process.env.APP_URL || 'http://localhost:3001';

/**
 * Record a notification in the database
 * n8n can poll this table and route notifications to email/Slack
 */
async function createNotification({ type, title, message, data = {}, channel = 'all' }) {
  try {
    const { error } = await supabase
      .from('notifications')
      .insert([{
        type,
        title,
        message,
        data,
        channel,
        status: 'pending',
        created_at: new Date().toISOString()
      }]);

    if (error) {
      // Table may not exist — log but don't crash
      logger.warn('Could not save notification (table may not exist)', { type, title });
      return false;
    }

    logger.info(`Notification created: ${type} - ${title}`);
    return true;
  } catch (err) {
    logger.warn('Notification save failed', err);
    return false;
  }
}

/**
 * Send a Slack webhook notification (if configured)
 */
async function sendSlackNotification({ text, blocks }) {
  if (!NOTIFICATION_WEBHOOK_URL) return false;

  try {
    await axios.post(NOTIFICATION_WEBHOOK_URL, {
      text,
      blocks,
    }, { timeout: 10000 });

    logger.success('Slack notification sent');
    return true;
  } catch (err) {
    logger.error('Slack notification failed', err);
    return false;
  }
}

/**
 * Notify that new posts are ready for approval
 */
async function notifyNewDrafts(posts) {
  const count = posts.length;
  const platforms = [...new Set(posts.map(p => p.platform))].join(', ');
  const headlines = posts.map(p => p.headline || 'Untitled').slice(0, 3);

  const title = `${count} new post${count > 1 ? 's' : ''} ready for approval`;
  const message = [
    title,
    '',
    `Platforms: ${platforms}`,
    '',
    ...headlines.map((h, i) => `${i + 1}. ${h}`),
    count > 3 ? `...and ${count - 3} more` : '',
    '',
    `Review in the WellMor app or at ${APP_URL}`,
  ].join('\n');

  // Save to DB
  await createNotification({
    type: 'approval_request',
    title,
    message,
    data: { count, platforms, post_ids: posts.map(p => p.id) },
    channel: 'all',
  });

  // Send Slack
  await sendSlackNotification({
    text: `📋 ${title}\n${platforms}\n\n${headlines.map((h, i) => `${i + 1}. ${h}`).join('\n')}`,
  });

  return true;
}

/**
 * Notify that a post was approved
 */
async function notifyPostApproved(post) {
  const title = `Post approved: ${post.headline || 'Untitled'}`;
  const message = `${post.platform} post "${post.headline}" was approved by ${post.approved_by || 'system'}`;

  await createNotification({
    type: 'post_approved',
    title,
    message,
    data: { post_id: post.id, platform: post.platform },
  });

  await sendSlackNotification({ text: `✅ ${message}` });
}

/**
 * Notify that a post was published
 */
async function notifyPostPublished(post) {
  const title = `Post published: ${post.headline || 'Untitled'}`;
  const message = `${post.platform} post "${post.headline}" is now live`;

  await createNotification({
    type: 'post_published',
    title,
    message,
    data: { post_id: post.id, platform: post.platform },
  });

  await sendSlackNotification({ text: `🚀 ${message}` });
}

/**
 * Notify about an interested lead (high priority)
 */
async function notifyInterestedLead({ leadId, companyName, contactEmail }) {
  const title = `Interested lead: ${companyName}`;
  const message = `${contactEmail} from ${companyName} has expressed interest. Follow up ASAP.`;

  await createNotification({
    type: 'interested_lead',
    title,
    message,
    data: { lead_id: leadId, company: companyName, email: contactEmail },
    channel: 'all',
  });

  await sendSlackNotification({
    text: `🔥 INTERESTED LEAD: ${companyName}\n${contactEmail} responded positively. Follow up now!`,
  });
}

module.exports = {
  createNotification,
  sendSlackNotification,
  notifyNewDrafts,
  notifyPostApproved,
  notifyPostPublished,
  notifyInterestedLead,
};
