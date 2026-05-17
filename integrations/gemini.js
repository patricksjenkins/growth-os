/**
 * Growth OS — Gemini Image Generation Integration
 * Ported from WellMor agents/image-agent.js (API call portion)
 */

require('dotenv').config();
const axios = require('axios');
const { createLogger } = require('../core/logger');

const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-3-pro-image-preview';

/**
 * Generate an image using Gemini API
 * @param {string} prompt - Image generation prompt
 * @param {Object} options
 * @returns {Buffer} Image buffer (PNG/JPEG)
 */
async function generateImage(prompt, options = {}) {
  const log = createLogger('gemini', options.tenant?.slug || options.tenantSlug);
  const model = options.model || GEMINI_IMAGE_MODEL;

  // Per-tenant monthly cap. Pass options.tenant to enforce.
  if (options.tenant && options.tenant.id) {
    const {
      checkUsageOrThrow, incrementUsage, notifyOwnerCapReached, UsageCapExceededError,
    } = require('../core/usage-caps');
    try {
      await checkUsageOrThrow(options.tenant, 'image_gen_count', 1);
    } catch (capErr) {
      if (capErr instanceof UsageCapExceededError) {
        log.warn(`Image-gen cap hit for tenant ${options.tenant.id} (${capErr.used}/${capErr.cap}) — skipping generation`);
        notifyOwnerCapReached(options.tenant.id, 'image_gen_count', capErr.used, capErr.cap);
      }
      throw capErr;
    }
  }

  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GOOGLE_API_KEY}`;

  log.info(`Generating image with ${model}...`);

  const response = await axios.post(geminiUrl, {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ['IMAGE', 'TEXT'] }
  }, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 120000
  });

  const parts = response.data?.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find(p => p.inlineData?.mimeType?.startsWith('image/'));
  const imageBase64 = imagePart?.inlineData?.data;

  if (!imageBase64) {
    const textPart = parts.find(p => p.text);
    const errorDetail = textPart?.text || 'No image in response';
    throw new Error(`No image returned from Gemini API: ${errorDetail}`);
  }

  log.success('Image generated');

  // Increment counter after successful generation (fire-and-forget)
  if (options.tenant && options.tenant.id) {
    try {
      const { incrementUsage } = require('../core/usage-caps');
      incrementUsage(options.tenant.id, 'image_gen_count', 1).catch(() => {});
    } catch (_) { /* never let usage tracking break a generation */ }
  }

  return Buffer.from(imageBase64, 'base64');
}

module.exports = { generateImage };
