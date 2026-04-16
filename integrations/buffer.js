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
function buildMetadata(platform, imageCount) {
  if (platform === 'instagram') {
    return {
      instagram: {
        type: imageCount > 1 ? 'carousel' : 'post',
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
  const metadata = buildMetadata(post.platform, imageUrls.length);

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

  const variables = {
    input: {
      channelId,
      text: post.text || '',
      mode: options.addToQueue ? 'addToQueue' : 'shareNow',
      schedulingType: 'automatic',
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

module.exports = { publishToBuffer, isBufferConfigured };
