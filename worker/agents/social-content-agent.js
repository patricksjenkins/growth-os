/**
 * Social Content Agent
 * Generates LinkedIn content for WellMor Benefits
 * Creates 4 posts per week with mixed content types
 */

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { createLogger } = require('./shared/logger');
const { askClaudeJSON } = require('./shared/claude');
const {
  supabase,
  getSystemConfig,
  createActivityLog
} = require('./shared/supabase');

const logger = createLogger('SocialContentAgent');
const router = express.Router();

/**
 * Get current week and month info
 * @returns {Object} Temporal context
 */
function getTemporalContext() {
  const now = new Date();
  const month = now.toLocaleString('default', { month: 'long' });
  const weekNum = Math.ceil((now.getDate() - now.getDay()) / 7);

  return {
    month,
    week: weekNum,
    year: now.getFullYear(),
    day: now.toLocaleString('default', { weekday: 'long' })
  };
}

/**
 * Fetch recent posts and their performance
 * @returns {Promise<Array>} Recent posts with engagement metrics
 */
async function getRecentPostsPerformance() {
  try {
    const { data: posts, error } = await supabase
      .from('social_posts')
      .select('*')
      .order('published_at', { ascending: false })
      .limit(10);

    if (error) {
      logger.warn('Could not fetch recent posts', error.message);
      return [];
    }

    return posts || [];
  } catch (error) {
    logger.error('Error fetching recent posts', error);
    return [];
  }
}

/**
 * Fetch content calendar configuration
 * @returns {Promise<Object>} Content calendar config
 */
async function getContentCalendarConfig() {
  try {
    const config = await getSystemConfig('content_calendar');

    return config || {
      posts_per_week: 4,
      content_mix: {
        educational: 2,
        insight: 1,
        engagement: 1
      },
      posting_times: [
        { day: 'Monday', time: '9:00 AM' },
        { day: 'Wednesday', time: '10:00 AM' },
        { day: 'Thursday', time: '2:00 PM' },
        { day: 'Friday', time: '9:00 AM' }
      ]
    };
  } catch (error) {
    logger.error('Error fetching content calendar config', error);
    return {
      posts_per_week: 4,
      content_mix: { educational: 2, insight: 1, engagement: 1 }
    };
  }
}

/**
 * Generate LinkedIn posts using Claude
 * @returns {Promise<Array>} Array of 4 posts
 */
async function generatePosts() {
  try {
    logger.info('Generating LinkedIn posts');

    // Get context
    const recentPosts = await getRecentPostsPerformance();
    const config = await getContentCalendarConfig();
    const temporal = getTemporalContext();

    // Build performance summary
    let performanceSummary = '';
    if (recentPosts.length > 0) {
      const topPost = recentPosts.reduce((prev, current) =>
        (prev.likes || 0) + (prev.comments || 0) > (current.likes || 0) + (current.comments || 0) ? prev : current
      );

      performanceSummary = `
Recent top performing post type: ${topPost.post_type}
Likes: ${topPost.likes || 0}, Comments: ${topPost.comments || 0}
Topic: ${topPost.content.substring(0, 100)}...`;
    }

    const userMessage = `Generate 4 LinkedIn posts for WellMor Benefits this week (${temporal.month} ${temporal.year}).

CONTEXT:
${performanceSummary}

Current posting schedule:
${config.posting_times.map(p => `- ${p.day}: ${p.time}`).join('\n')}

REQUIREMENTS:
- 2 educational posts (benefits tips, data, how-to)
- 1 insight/opinion post (industry trend, data point)
- 1 engagement post (question, poll, reaction request)

Return as JSON array of 4 posts:
[
  {
    "content": string (150-300 words, starts with hook, ends with takeaway/question),
    "hashtags": [string] (3-5 hashtags),
    "post_type": string (educational|insight|engagement),
    "suggested_time": string (e.g., "Monday 9:00 AM")
  },
  ...
]

Make content valuable, not promotional. Topics to draw from:
- ACA compliance complexity for growing companies
- Benefits benchmarking for SMBs (anonymized data)
- Open enrollment best practices
- Benefits as a retention tool
- PEO vs. broker comparison
- Employee benefits trends 2026
- Mental health benefits adoption
- HSA/FSA strategies
- Dependent care benefits
- Seasonal benefits changes`;

    const systemPrompt = `You are a social media content strategist for WellMor Benefits & Co., an employee benefits consulting firm focused on Southeast US companies with 10-300 employees.

Morgan is the primary voice - warm, knowledgeable, approachable. Posts should feel like they come from an expert who genuinely cares about helping HR teams and business owners navigate benefits.

Post guidelines:
- Start with a hook (surprising stat, bold claim, relatable problem)
- 3-5 short paragraphs or lines
- End with a clear takeaway or question
- LinkedIn optimal length: 150-300 words
- No promotional language, no "DM me", no hard sells
- Do NOT mention specific client names or proprietary data
- Speak to: Founders, CFOs, HR Directors at growing SE companies
- Mix perspectives from business and HR angles`;

    const posts = await askClaudeJSON(systemPrompt, userMessage, {
      maxTokens: 2000
    });

    if (!Array.isArray(posts)) {
      throw new Error('Claude did not return an array of posts');
    }

    logger.success(`Generated ${posts.length} LinkedIn posts`);
    return posts;
  } catch (error) {
    logger.error('Error generating posts', error);
    throw error;
  }
}

/**
 * Save posts to Supabase
 * @param {Array} posts - Array of post objects
 * @returns {Promise<Array>} Created posts
 */
async function savePosts(posts) {
  try {
    const postRecords = posts.map(post => ({
      id: uuidv4(),
      content: post.content,
      platform: 'linkedin',
      post_type: post.post_type,
      hashtags: post.hashtags,
      suggested_time: post.suggested_time,
      status: 'needs_review',
      created_at: new Date().toISOString()
    }));

    const { data, error } = await supabase
      .from('social_posts')
      .insert(postRecords)
      .select();

    if (error) {
      throw error;
    }

    logger.success(`Saved ${postRecords.length} posts to database`);
    return data;
  } catch (error) {
    logger.error('Error saving posts', error);
    throw error;
  }
}

/**
 * Send Slack notification about new posts
 * @param {Array} posts - Posts to notify about
 * @returns {Promise<void>}
 */
async function sendSlackNotification(posts) {
  try {
    const slackWebhook = process.env.SLACK_WEBHOOK_URL;
    if (!slackWebhook) {
      logger.warn('SLACK_WEBHOOK_URL not configured');
      return;
    }

    // Build post preview
    const postPreviews = posts
      .slice(0, 3)
      .map((p, i) => {
        const preview = p.content.substring(0, 80).replace(/\n/g, ' ');
        return `${i + 1}. *${p.post_type}* (${p.suggested_time})\n_${preview}..._`;
      })
      .join('\n\n');

    const payload = {
      text: '4 new LinkedIn posts ready for review',
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: '4 new LinkedIn posts ready for your review',
            emoji: true
          }
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Post Preview:*\n\n${postPreviews}`
          }
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `Visit BenefitsIQ to review and approve posts for publishing.`
          }
        }
      ]
    };

    await axios.post(slackWebhook, payload);
    logger.info('Sent Slack notification about new posts');
  } catch (error) {
    logger.warn('Could not send Slack notification', error.message);
  }
}

/**
 * Run social content generation
 * @returns {Promise<Object>} Summary of content generation
 */
async function run() {
  const startTime = Date.now();

  try {
    logger.info('Starting social content generation');

    // Generate posts
    const posts = await generatePosts();

    // Save to database
    const savedPosts = await savePosts(posts);

    // Send Slack notification
    await sendSlackNotification(savedPosts);

    // Log activity
    await createActivityLog('SocialContentAgent', 'generated_posts', 'system', 'social', {
      post_count: savedPosts.length,
      types: savedPosts.map(p => p.post_type)
    });

    const duration = Date.now() - startTime;
    const summary = {
      posts_generated: savedPosts.length,
      post_types: {
        educational: savedPosts.filter(p => p.post_type === 'educational').length,
        insight: savedPosts.filter(p => p.post_type === 'insight').length,
        engagement: savedPosts.filter(p => p.post_type === 'engagement').length
      },
      duration_ms: duration,
      timestamp: new Date().toISOString()
    };

    logger.success('Social content generation completed', summary);
    return summary;
  } catch (error) {
    logger.error('Social content generation failed', error);
    throw error;
  }
}

/**
 * Express route handler
 */
router.post('/run', async (req, res) => {
  try {
    const result = await run();
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    logger.error('Route handler error', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = {
  run,
  router,
  generatePosts,
  savePosts
};
