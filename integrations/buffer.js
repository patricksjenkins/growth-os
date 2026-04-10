/**
 * Growth OS — Buffer Publishing Integration
 * Ported from WellMor agents/buffer-publisher.js
 */

const axios = require('axios');
const FormData = require('form-data');
const { createLogger } = require('../core/logger');

/**
 * Publish content to Buffer
 * @param {Object} tenantIntegrations - tenant.integrations.buffer
 * @param {Object} post - { platform, text, imageBuffer, imageName }
 * @param {Object} options
 */
async function publishToBuffer(tenantIntegrations, post, options = {}) {
  const log = createLogger('buffer', options.tenantSlug);
  const bufferCreds = tenantIntegrations?.buffer;

  if (!bufferCreds || !bufferCreds.credentials?.api_key) {
    throw new Error('Buffer integration not configured for this tenant');
  }

  const apiKey = bufferCreds.credentials.api_key;
  const channels = bufferCreds.config?.channels || {};
  const channelId = channels[post.platform];

  if (!channelId) {
    throw new Error(`No Buffer channel configured for platform: ${post.platform}`);
  }

  // Step 1: Upload image if provided
  let mediaId = null;
  if (post.imageBuffer) {
    const form = new FormData();
    form.append('file', post.imageBuffer, { filename: post.imageName || 'image.png', contentType: 'image/png' });

    const uploadRes = await axios.post(
      `https://api.bufferapp.com/1/media/upload.json`,
      form,
      {
        headers: {
          ...form.getHeaders(),
          'Authorization': `Bearer ${apiKey}`
        }
      }
    );
    mediaId = uploadRes.data?.id;
    log.info('Image uploaded to Buffer');
  }

  // Step 2: Create post
  const postData = {
    text: post.text,
    profile_ids: [channelId],
    now: true
  };
  if (mediaId) {
    postData.media = { photo: mediaId };
  }

  const createRes = await axios.post(
    'https://api.bufferapp.com/1/updates/create.json',
    postData,
    {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    }
  );

  log.success(`Published to ${post.platform}`);
  return createRes.data;
}

/**
 * Check if Buffer is configured for a tenant
 */
function isBufferConfigured(tenantIntegrations) {
  return !!(tenantIntegrations?.buffer?.credentials?.api_key);
}

module.exports = { publishToBuffer, isBufferConfigured };
