import { env } from './env';

/**
 * Telnyx SMS client.
 *
 * Replaces the previous carrier's SDK (2026-08-02). Telnyx is the platform's
 * carrier; nothing in FGA uses the old one any more.
 *
 * Deliberately a plain fetch against the REST API rather than another SDK
 * dependency — this is one endpoint, and it mirrors how the platform itself
 * talks to Telnyx (growth-os integrations/telnyx.js).
 */

const TELNYX_API = 'https://api.telnyx.com/v2';

export interface SendSmsResult {
  /** Telnyx message id. Named `sid` so callers did not have to change. */
  sid: string;
}

export const telnyxClient = {
  messages: {
    async create(params: { body: string; from: string; to: string }): Promise<SendSmsResult> {
      if (!env.TELNYX_API_KEY) {
        throw new Error('TELNYX_API_KEY is not set');
      }

      const res = await fetch(`${TELNYX_API}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.TELNYX_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: params.from,
          to: params.to,
          text: params.body,
          ...(env.TELNYX_MESSAGING_PROFILE_ID
            ? { messaging_profile_id: env.TELNYX_MESSAGING_PROFILE_ID }
            : {}),
        }),
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Telnyx send failed (${res.status}): ${detail.slice(0, 300)}`);
      }

      const json: any = await res.json();
      const id = json?.data?.id;
      if (!id) throw new Error('Telnyx returned no message id');
      return { sid: id };
    },
  },
};
