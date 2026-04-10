require('dotenv').config();
const express = require('express');
const { askClaudeJSON } = require('./shared/claude');
const { createLogger } = require('./shared/logger');

const logger = createLogger('ScheduleAgent');
const router = express.Router();

async function buildWeeklySchedule() {
  const systemPrompt = `
You are a social media strategist for WellMor Benefits & Co.

Your job is to create a weekly posting schedule for:
- LinkedIn: 3 posts per week
- Instagram: 3 posts per week

Business context:
- WellMor is a modern benefits consulting brand
- Audience includes growth-stage businesses, law firms, engineering firms, construction firms, manufacturing companies, and professional services firms
- Brand voice mix:
  - 50% authority
  - 30% story
  - 20% educational

Platform guidance:
- LinkedIn should prioritize lead generation, authority, and trust
- Instagram should prioritize visual engagement, brand perception, and reach

Posting recommendations:
- LinkedIn best days: Tuesday, Wednesday, Thursday
- Instagram best days: Monday, Wednesday, Saturday

Return only valid JSON.
`;

  const userPrompt = `
Create a practical weekly posting schedule.

Return JSON in exactly this shape:
{
  "weekly_schedule": [
    {
      "day": "Monday",
      "platform": "Instagram",
      "content_type": "Relatable / visual",
      "goal": "Brand reach and engagement",
      "recommended_time": "11:00 AM"
    },
    {
      "day": "Tuesday",
      "platform": "LinkedIn",
      "content_type": "Authority / contrarian",
      "goal": "Lead generation and authority",
      "recommended_time": "8:30 AM"
    }
  ],
  "notes": "short explanation of the strategy"
}

Rules:
- Exactly 6 total posts
- Exactly 3 LinkedIn posts
- Exactly 3 Instagram posts
- Wednesday can include one post on each platform
- Keep it realistic and strategically strong
`;

  return await askClaudeJSON(systemPrompt, userPrompt, {
    maxTokens: 2000
  });
}

router.post('/generate', async (req, res) => {
  try {
    const schedule = await buildWeeklySchedule();

    logger.success('Generated weekly posting schedule');

    res.json({
      success: true,
      schedule
    });
  } catch (err) {
    logger.error('Schedule generation failed', err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

module.exports = router;
module.exports.buildWeeklySchedule = buildWeeklySchedule;
