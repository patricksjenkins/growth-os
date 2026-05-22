/**
 * Growth OS — Buffer Publishing Integration
 * Uses Buffer's GraphQL API (api.buffer.com/graphql)
 */

const axios = require('axios');
const { createLogger } = require('../core/logger');

const BUFFER_GRAPHQL = 'https://api.buffer.com/graphql';

/**
 * Build platform-specific metadata for Buffer
 */
function buildMetadata(platform) {
  if (platform === 'instagram') {
    return {
      instagram: {
        type: 'post',
        shouldShareToFeed: true,
      }
    };
  }
  // Other platforms don't require special metadata
  return undefined;
}

/**
 * Publish content to Buffer via GraphQL createPost mutation
 * @param {Object} tenantIntegrations - tenant.integrations (contains .buffer)
 * @param {Object} post - { platform, text, imageUrls }
 * @param {Object} options
 */
async function publishToBuffer(tenantIntegrations, post, options = {}) {
  const log = createLogger('buffer', options.tenantSlug);

  // Demo-mode guard — never publish a real social post for a demo tenant.
  if (options.tenant) {
    const { isDemoTenant, demoMockResponse } = require('./demo-guard');
    if (isDemoTenant(options.tenant)) {
      log.info(`[demo] Buffer publish mocked — would have posted to ${post.platform}: "${String(post.body || '').slice(0, 60)}"`);
      return demoMockResponse('buffer_post', {
        platform: post.platform,
        post_id: `demo_buffer_${Date.now()}`,
      });
    }
  }

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

  // Build assets (images)
  const imageUrls = post.imageUrls || [];
  const assets = imageUrls.length > 0
    ? { images: imageUrls.map(url => ({ url })) }
    : undefined;

  // Build platform metadata (Instagram requires type + shouldShareToFeed)
  const metadata = buildMetadata(post.platform);

  const mutation = `
    mutation CreatePost($input: CreatePostInput!) {
      createPost(input: $input) {
        ... on PostActionSuccess {
          post {
            id
            status
            channel {
              id
              name
              service
            }
          }
        }
        ... on NotFoundError { message }
        ... on UnauthorizedError { message }
        ... on UnexpectedError { message }
        ... on RestProxyError { message }
        ... on LimitReachedError { message }
        ... on InvalidInputError { message }
      }
    }
  `;

  // Module 6.5 — Override timing per post. If options.scheduledAt is
  // provided (ISO 8601 string in the future), publish at that exact
  // time via Buffer's 'scheduledAt' mode instead of dropping into the
  // automatic queue. Without an override, falls back to addToQueue
  // (Buffer picks the next open slot) or shareNow.
  const overrideTime = options.scheduledAt && new Date(options.scheduledAt) > new Date()
    ? new Date(options.scheduledAt).toISOString()
    : null;

  const variables = {
    input: {
      channelId,
      text: post.text || '',
      mode: overrideTime
        ? 'scheduledAt'
        : (options.addToQueue ? 'addToQueue' : 'shareNow'),
      schedulingType: 'automatic',
      ...(overrideTime ? { scheduledAt: overrideTime } : {}),
      assets,
      metadata,
      source: 'growth-os',
      aiAssisted: true,
    }
  };

  const res = await axios.post(
    BUFFER_GRAPHQL,
    { query: mutation, variables },
    {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    }
  );

  if (res.data?.errors) {
    const errMsg = res.data.errors.map(e => e.message).join('; ');
    throw new Error(`Buffer publish failed: ${errMsg}`);
  }

  const result = res.data?.data?.createPost;

  // Check for error union types
  if (result?.message) {
    throw new Error(`Buffer publish failed: ${result.message}`);
  }

  const createdPost = result?.post;
  if (!createdPost) {
    throw new Error('Buffer publish failed: no post returned');
  }

  log.success(`Published to ${post.platform} (post: ${createdPost.id}, status: ${createdPost.status})`);

  return {
    id: createdPost.id,
    status: createdPost.status,
    channel: createdPost.channel,
  };
}

/**
 * Check if Buffer is configured for a tenant
 */
function isBufferConfigured(tenantIntegrations) {
  return !!(tenantIntegrations?.buffer?.credentials?.api_key);
}

// ============================================================================
// FGA Corporate Buffer
//
// Used ONLY by the platform-owner Module Promo Generator. Strict
// isolation is preserved by resolving the FGA tenant_id explicitly
// (via env or hard-coded fallback) and reading its tenant_integrations
// row — never the caller's tenant. Same row the regular FGA publisher
// already uses, so adding channels is the normal Buffer-add flow.
//
// Optional env override (for rotation without touching the DB):
//   FGA_BUFFER_API_KEY        — replaces tenant_integrations.buffer.credentials.api_key
//   FGA_BUFFER_CHANNELS_JSON  — replaces tenant_integrations.buffer.config.channels
// ============================================================================

const FGA_TENANT_ID = process.env.FGA_TENANT_ID || '30566ed6-026a-45e1-9502-029e6219df31';

async function getFgaBufferConfig() {
  // 1. Env override wins so credentials can be rotated without writing
  //    to Supabase. Both vars must be present for the override to apply.
  const envKey = process.env.FGA_BUFFER_API_KEY;
  const envChannels = process.env.FGA_BUFFER_CHANNELS_JSON;
  if (envKey && envChannels) {
    let channels = {};
    try { channels = JSON.parse(envChannels); } catch { channels = {}; }
    return { apiKey: envKey, channels, source: 'env' };
  }

  // 2. Otherwise read the FGA tenant_integrations row — same place the
  //    existing tenant publisher reads from. This is the path that
  //    "just works" with no new setup.
  try {
    const { getServiceClient } = require('../db/client');
    const db = getServiceClient();
    const { data } = await db
      .from('tenant_integrations')
      .select('credentials, config, status')
      .eq('tenant_id', FGA_TENANT_ID)
      .eq('service', 'buffer')
      .maybeSingle();
    const apiKey = data?.credentials?.api_key;
    const channels = data?.config?.channels || {};
    if (apiKey && data?.status === 'active') {
      return { apiKey, channels, source: 'tenant_integrations' };
    }
  } catch (_) { /* fall through to null */ }

  return null;
}

async function isFgaBufferConfigured() {
  const cfg = await getFgaBufferConfig();
  return !!cfg?.apiKey && Object.keys(cfg.channels || {}).length > 0;
}

/**
 * Publish a post to the FGA corporate Buffer queue. Strictly isolated
 * from tenant publish path — does not read tenant integrations, does
 * not write to any tenant table, and the credentials are env-only so
 * a misconfigured tenant can never push to FGA's own brand channels.
 *
 * @param {Object} post
 * @param {string} post.platform    — 'instagram' | 'linkedin' | 'facebook' | 'twitter'
 * @param {string} post.text
 * @param {string[]} [post.mediaUrls] — public URLs (images or video)
 * @param {Object} [options]
 * @param {string} [options.scheduledAt]  ISO timestamp; falls back to queue
 * @param {boolean} [options.addToQueue]  true → next open slot; false → shareNow
 * @returns {Promise<{ id, status, channel }>}
 */
async function publishToFgaBuffer(post, options = {}) {
  const log = createLogger('buffer-fga');
  const cfg = await getFgaBufferConfig();
  if (!cfg) {
    throw new Error('FGA corporate Buffer not configured. Add a tenant_integrations row for FGA service=buffer, or set FGA_BUFFER_API_KEY + FGA_BUFFER_CHANNELS_JSON.');
  }
  const platform = post.platform || 'instagram';
  const channelId = cfg.channels[platform];
  if (!channelId) {
    throw new Error(`No FGA Buffer channel configured for platform "${platform}". Add it to the FGA tenant_integrations.buffer.config.channels (or FGA_BUFFER_CHANNELS_JSON).`);
  }

  const mediaUrls = post.mediaUrls || [];
  // Buffer treats video uploads via the same assets.images URL pattern
  // for the GraphQL mutation; the media type is inferred server-side.
  // (Buffer's docs allow video URLs in the same assets payload.)
  const assets = mediaUrls.length > 0
    ? { images: mediaUrls.map(url => ({ url })) }
    : undefined;

  const metadata = buildMetadata(platform);

  const mutation = `
    mutation CreatePost($input: CreatePostInput!) {
      createPost(input: $input) {
        ... on PostActionSuccess {
          post { id status channel { id name service } }
        }
        ... on NotFoundError { message }
        ... on UnauthorizedError { message }
        ... on UnexpectedError { message }
        ... on RestProxyError { message }
        ... on LimitReachedError { message }
        ... on InvalidInputError { message }
      }
    }
  `;

  const overrideTime = options.scheduledAt && new Date(options.scheduledAt) > new Date()
    ? new Date(options.scheduledAt).toISOString()
    : null;

  const variables = {
    input: {
      channelId,
      text: post.text || '',
      mode: overrideTime
        ? 'scheduledAt'
        : (options.addToQueue === false ? 'shareNow' : 'addToQueue'),
      schedulingType: 'automatic',
      ...(overrideTime ? { scheduledAt: overrideTime } : {}),
      assets,
      metadata,
      source: 'growth-os-fga-marketing',
      aiAssisted: true,
    }
  };

  const res = await axios.post(
    BUFFER_GRAPHQL,
    { query: mutation, variables },
    {
      headers: {
        'Authorization': `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    }
  );

  if (res.data?.errors) {
    const errMsg = res.data.errors.map(e => e.message).join('; ');
    throw new Error(`FGA Buffer publish failed: ${errMsg}`);
  }
  const result = res.data?.data?.createPost;
  if (result?.message) throw new Error(`FGA Buffer publish failed: ${result.message}`);
  const createdPost = result?.post;
  if (!createdPost) throw new Error('FGA Buffer publish failed: no post returned');

  log.success(`Published to FGA ${platform} (post: ${createdPost.id}, status: ${createdPost.status})`);
  return { id: createdPost.id, status: createdPost.status, channel: createdPost.channel };
}

module.exports = {
  publishToBuffer,
  isBufferConfigured,
  publishToFgaBuffer,
  isFgaBufferConfigured,
};
