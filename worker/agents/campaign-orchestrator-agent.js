require('dotenv').config();
const express = require('express');
const { createLogger } = require('./shared/logger');
const { getSystemConfig, upsertSystemConfig } = require('./shared/supabase');
const { generatePost } = require('./content-agent');
const { generateImage, generateCarouselImages } = require('./image-agent');
const { transformPostForPlatforms } = require('./distribution-agent');
const { buildWeeklySchedule } = require('./schedule-agent');
const { saveCampaignToQueue } = require('./approval-queue-agent');
const { FORMAT_TEMPLATES } = require('./format-templates');

const logger = createLogger('CampaignOrchestratorAgent');
const router = express.Router();

/**
 * UPDATED: Campaign orchestrator now supports 8-format round-robin rotation.
 *
 * Pipeline flow:
 * 0. Format Selection → read rotation counter, pick format template
 * 1. Content Agent → generates copy based on format structure (Claude)
 * 2. Image Agent → generates images per format template (OpenAI)
 * 3. Distribution Agent → adapts caption for each platform (Claude)
 * 4. Schedule Agent → optimal posting times
 * 5. Approval Queue → saves to Supabase + increments format counter
 *
 * Post 1 = Format 1, Post 2 = Format 2, ... Post 8 = Format 8, Post 9 = Format 1
 */

router.post('/generate', async (req, res) => {
  try {
    // ─── Step 0: Select format template ─────────────────
    logger.info('Step 0/6: Selecting format template...');

    let rotationState = await getSystemConfig('format_rotation_index');
    if (!rotationState) {
      rotationState = { instagram: 0, linkedin: 0, x: 0, threads: 0 };
      logger.info('No rotation state found, initializing at index 0');
    }

    // Allow manual format override via request body
    const requestedFormat = req.body?.format_id;
    const formatIndex = requestedFormat
      ? (requestedFormat - 1) % FORMAT_TEMPLATES.length
      : rotationState.instagram % FORMAT_TEMPLATES.length;
    const formatTemplate = FORMAT_TEMPLATES[formatIndex];

    logger.success(`Selected Format #${formatTemplate.id}: "${formatTemplate.name}" (${formatTemplate.slideCount} slides)`);

    // ─── Step 1: Generate copy ──────────────────────────
    logger.info('Step 1/6: Generating content copy...');
    const content = await generatePost(formatTemplate);
    logger.success(`Content: "${content.post_theme}" — ${content.slides.length} slides`);

    // ─── Step 2: Generate images per format template ────
    logger.info(`Step 2/6: Generating ${content.slides.length} images...`);

    const allImages = [];
    for (let i = 0; i < content.slides.length; i++) {
      const slide = content.slides[i];
      const slideTemplate = formatTemplate.slides[i] || formatTemplate.slides[formatTemplate.slides.length - 1];

      logger.info(`  Generating slide ${slide.slide_number} (${slide.role})...`);

      const img = await generateImage({
        headline: slide.headline,
        subtext: slide.subtext || '',
        body: slide.body || '',
        slide_role: slide.role,
        slide_number: slide.slide_number,
        post_theme: content.post_theme || '',
        filename_prefix: `f${formatTemplate.id}-s${slide.slide_number}-${slide.role}`,
        formatTemplate,
        slideTemplate,
      });
      allImages.push(img);
    }

    const heroImage = allImages[0];
    logger.success(`All ${allImages.length} images generated`);

    // ─── Step 3: Generate platform distribution ─────────
    logger.info('Step 3/6: Generating platform distribution...');
    const distribution = await transformPostForPlatforms({
      post: content.caption || content.post,
      hook: content.hook,
      cta: content.cta,
      headline: content.headline,
      subtext: content.subtext,
      visual_style: content.visual_style,
      type: content.type,
      post_theme: content.post_theme,
      slides: content.slides
    });
    logger.success('Platform distribution generated');

    // ─── Step 4: Generate weekly schedule ────────────────
    logger.info('Step 4/6: Generating posting schedule...');
    const schedule = await buildWeeklySchedule();
    logger.success('Weekly schedule generated');

    // ─── Step 5: Save to approval queue ─────────────────
    logger.info('Step 5/6: Saving to approval queue...');

    const campaign = {
      content,
      image: heroImage,
      carousel_images: allImages,
      distribution,
      schedule,
      formatTemplate: {
        id: formatTemplate.id,
        name: formatTemplate.name,
        slideCount: formatTemplate.slideCount,
      },
    };

    const queue_saved = await saveCampaignToQueue(campaign);
    logger.success(`Saved ${queue_saved.length} posts to approval queue`);

    // ─── Step 6: Advance rotation counter ───────────────
    logger.info('Step 6/6: Advancing format rotation...');
    const newState = { ...rotationState };
    for (const platform of ['instagram', 'linkedin', 'x', 'threads']) {
      newState[platform] = ((newState[platform] || 0) + 1) % FORMAT_TEMPLATES.length;
    }
    await upsertSystemConfig('format_rotation_index', newState, 'Round-robin format rotation index per platform');
    logger.success(`Format rotation advanced: next format will be #${(newState.instagram) + 1}`);

    res.json({
      success: true,
      format_used: { id: formatTemplate.id, name: formatTemplate.name },
      campaign,
      queue_saved_count: queue_saved.length,
      queue_saved
    });
  } catch (err) {
    logger.error('Campaign orchestration failed', err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

module.exports = router;
