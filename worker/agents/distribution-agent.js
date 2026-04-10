require('dotenv').config();
const express = require('express');
const { askClaudeJSON } = require('./shared/claude');
const { createLogger } = require('./shared/logger');

const logger = createLogger('DistributionAgent');
const router = express.Router();

/**
 * UPDATED: Distribution agent now handles carousel content.
 *
 * Key changes:
 * - Instagram gets a carousel-optimized caption (with swipe CTA)
 * - LinkedIn gets a thought-leadership adaptation of the carousel theme
 * - X gets a punchy one-liner from the hook slide
 * - Threads gets a conversational thread based on the carousel narrative
 * - Slides data is passed through so platforms understand the full story arc
 */

async function transformPostForPlatforms({
  post,
  hook,
  cta,
  headline,
  subtext,
  visual_style,
  type,
  post_theme,
  slides
}) {
  // Build a slide summary for the AI to understand the full carousel narrative
  let slideSummary = '';
  if (slides && slides.length > 0) {
    slideSummary = slides
      .map(s => `  Slide ${s.slide_number} (${s.role}): "${s.headline}"${s.body ? `\n    Body: ${s.body}` : ''}${s.subtext ? ` — ${s.subtext}` : ''}`)
      .join('\n');
  }

  const systemPrompt = `
You are a premium social media strategist for WellMor Benefits & Co.

Your job is to adapt a 5-slide Instagram carousel concept into platform-specific social copy.

BRAND CONTEXT:
- WellMor is a modern, elevated benefits consulting brand
- The brand feels premium, insightful, human, and visually sophisticated
- Audience: founders, executives, and HR leaders at growth-stage businesses (20-150 employees)
- Voice: bold, modern, concise, emotionally intelligent
- Industries: law firms, engineering, construction, manufacturing, professional services

PLATFORM RULES:

INSTAGRAM:
- This is the PRIMARY platform — the carousel lives here
- Caption should complement the carousel, not repeat it
- Start with a hook line that makes people want to swipe
- Keep caption under 150 words
- End with a soft, reflective CTA — NOT salesy
- Include 3-5 relevant hashtags
- Include "Swipe →" or similar carousel prompt early in the caption

LINKEDIN:
- Transform the carousel narrative into a thoughtful text post
- Professional but not stiff — modern executive voice
- Strong opening hook (the first line people see before "...see more")
- Use line breaks for readability
- 120-180 words
- End with a question or reflection, not a hard sell

X (TWITTER):
- One punchy statement pulled from the carousel's strongest slide
- Maximum 240 characters
- Sharp, contrarian, or thought-provoking
- No hashtags unless they add real value

THREADS:
- Conversational, human version of the carousel story
- Like explaining the insight to a smart friend over coffee
- 60-100 words
- Casual but insightful

Return only valid JSON.
`;

  const userPrompt = `
Transform this carousel content into platform-specific versions.

CAROUSEL THEME: ${post_theme || type || 'benefits strategy'}

SLIDE NARRATIVE:
${slideSummary || `Hook: ${hook}\nHeadline: ${headline}\nSubtext: ${subtext}\nCTA: ${cta}`}

FULL CAPTION/POST:
${post || ''}

Return JSON in exactly this shape:
{
  "linkedin": {
    "caption": "string",
    "best_time": "string",
    "goal": "string"
  },
  "instagram": {
    "caption": "string",
    "best_time": "string",
    "goal": "string"
  },
  "x": {
    "caption": "string",
    "best_time": "string",
    "goal": "string"
  },
  "threads": {
    "caption": "string",
    "best_time": "string",
    "goal": "string"
  }
}

Rules:
- Instagram caption should include "Swipe →" and 3-5 hashtags
- LinkedIn should be the longest and most thoughtful
- X should be the shortest and punchiest
- Threads should feel like a casual conversation
- All should maintain premium brand voice
- Never use "We help companies..." phrasing
`;

  const result = await askClaudeJSON(systemPrompt, userPrompt, {
    maxTokens: 2500
  });

  return result;
}

router.post('/generate', async (req, res) => {
  try {
    const {
      post,
      hook,
      cta,
      headline,
      subtext,
      visual_style,
      type,
      post_theme,
      slides
    } = req.body || {};

    if (!post && !headline && !slides) {
      return res.status(400).json({
        success: false,
        error: 'post, headline, or slides is required'
      });
    }

    const distribution = await transformPostForPlatforms({
      post,
      hook,
      cta,
      headline,
      subtext,
      visual_style,
      type,
      post_theme,
      slides
    });

    logger.success('Generated platform-specific distribution copy');

    res.json({
      success: true,
      distribution
    });
  } catch (err) {
    logger.error('Distribution generation failed', err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

module.exports = router;
module.exports.transformPostForPlatforms = transformPostForPlatforms;
