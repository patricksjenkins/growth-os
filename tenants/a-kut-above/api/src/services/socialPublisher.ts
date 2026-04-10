import { env } from '../config/env';

interface ContentDraft {
  id: string;
  body: string;
  image_urls?: string[];
  platform: string;
}

interface PublishResults {
  buffer: boolean;
  errors: string[];
}

interface BufferResponse {
  data?: {
    createPost?: {
      __typename: string;
      post?: { id: string };
      message?: string;
    };
  };
  errors?: { message: string }[];
}

export const socialPublisher = {
  async publish(draft: ContentDraft): Promise<PublishResults> {
    const results: PublishResults = {
      buffer: false,
      errors: [],
    };

    try {
      results.buffer = await this.postToBuffer(draft);
    } catch (e: any) {
      results.errors.push(`Buffer: ${e.message}`);
      console.error('Buffer publish failed:', e.message);
    }

    return results;
  },

  async postToBuffer(draft: ContentDraft): Promise<boolean> {
    const apiKey = env.BUFFER_API_KEY;
    const channelId = env.BUFFER_CHANNEL_ID;

    if (!apiKey || !channelId) {
      console.log('Buffer credentials not configured — skipping publish');
      return false;
    }

    const images = draft.image_urls || [];

    // Build the assets input if we have images
    const assets = images.length > 0
      ? {
          images: images.map(url => ({ url })),
        }
      : undefined;

    const mutation = `
      mutation CreatePost($input: CreatePostInput!) {
        createPost(input: $input) {
          ... on PostActionSuccess {
            post {
              id
            }
          }
          ... on MutationError {
            message
          }
        }
      }
    `;

    const variables = {
      input: {
        channelId,
        text: draft.body,
        schedulingType: 'automatic',
        mode: 'shareNow',
        ...(assets && { assets }),
      },
    };

    const res = await fetch('https://api.buffer.com', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ query: mutation, variables }),
    });

    const data = (await res.json()) as BufferResponse;

    // Check for GraphQL errors
    if (data.errors && data.errors.length > 0) {
      throw new Error(data.errors.map(e => e.message).join(', '));
    }

    const result = data.data?.createPost;

    if (result?.__typename === 'PostActionSuccess' && result.post?.id) {
      console.log('Buffer post published:', result.post.id);
      return true;
    }

    if (result?.__typename === 'MutationError') {
      throw new Error(result.message || 'Buffer mutation error');
    }

    throw new Error('Unexpected Buffer response');
  },

  // Helper to get available channels (useful for setup)
  async getChannels(): Promise<any[]> {
    const apiKey = env.BUFFER_API_KEY;
    if (!apiKey) return [];

    // First get organization ID
    const orgQuery = `
      query GetOrganizations {
        account {
          organizations {
            id
          }
        }
      }
    `;

    const orgRes = await fetch('https://api.buffer.com', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ query: orgQuery }),
    });

    const orgData = (await orgRes.json()) as any;
    const orgId = orgData?.data?.account?.organizations?.[0]?.id;
    if (!orgId) return [];

    // Then get channels for that org
    const channelQuery = `
      query GetChannels($orgId: OrganizationId!) {
        channels(input: { organizationId: $orgId }) {
          id
          name
          service
        }
      }
    `;

    const channelRes = await fetch('https://api.buffer.com', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query: channelQuery,
        variables: { orgId },
      }),
    });

    const channelData = (await channelRes.json()) as any;
    return channelData?.data?.channels || [];
  },
};
