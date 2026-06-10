/**
 * First Gen Automate — Drip campaign PUBLIC routes (no auth).
 *
 * GET  /unsubscribe?token=...   visible unsubscribe link in every drip email
 * POST /unsubscribe?token=...   RFC 8058 one-click (List-Unsubscribe-Post)
 *
 * Token is an HMAC-signed (leadId, email) pair minted at send time by
 * core/drip-campaign.js — no PII in the URL beyond the opaque token, and a
 * tampered token simply renders the error page. Unsubscribing:
 *   1. adds the address to drip_suppressions (never emailed again)
 *   2. stops any live enrollment immediately
 *   3. writes an audit entry (actor: prospect via unsubscribe link)
 */

const express = require('express');
const router = express.Router();

const { getServiceClient } = require('../../db/client');
const { createLogger } = require('../../core/logger');
const { FGA_TENANT_ID } = require('../../core/config');
const {
  verifyUnsubscribeToken, suppress, stopEnrollment,
} = require('../../core/drip-campaign');

const log = createLogger('drip-public');

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0B1120;color:#e5e7eb;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{max-width:420px;padding:40px;text-align:center}.card h1{font-size:20px;color:#fff}.card p{color:#9ca3af;line-height:1.6}</style>
</head><body><div class="card"><h1>${title}</h1><p>${body}</p></div></body></html>`;
}

async function handleUnsubscribe(req, res) {
  const token = req.query.token || req.body?.token;
  const parsed = token ? verifyUnsubscribeToken(token) : null;
  if (!parsed || !parsed.email) {
    return res.status(400).send(page('Link not valid', 'This unsubscribe link is invalid or has expired. You can reply to any of our emails with "unsubscribe" instead.'));
  }

  try {
    const db = getServiceClient();
    await suppress(db, {
      email: parsed.email,
      reason: 'unsubscribe_link',
      source: req.method === 'POST' ? 'list_unsubscribe_post' : 'unsubscribe_page',
      leadId: parsed.leadId || null,
    });

    if (parsed.leadId) {
      const { data: enrollment } = await db
        .from('drip_enrollments')
        .select('id')
        .eq('lead_id', parsed.leadId)
        .in('status', ['active', 'paused', 'review'])
        .maybeSingle();
      if (enrollment) {
        await stopEnrollment(db, enrollment.id, {
          status: 'unsubscribed',
          reason: 'unsubscribe_link',
          by: 'prospect',
        });
      }
      await db.from('activity_log').insert({
        tenant_id: FGA_TENANT_ID,
        agent: 'prospect',
        action: 'drip_unsubscribed',
        entity_type: 'lead',
        entity_id: parsed.leadId,
        level: 'info',
        metadata: { email: parsed.email, via: req.method === 'POST' ? 'one_click' : 'link' },
      });
    }

    log.info(`Unsubscribed ${parsed.email} (lead ${parsed.leadId || 'unknown'})`);
    if (req.method === 'POST') return res.status(200).json({ success: true });
    return res.send(page("You're unsubscribed", `${parsed.email} will not receive any more emails from First Gen Automate. No further action needed.`));
  } catch (err) {
    log.error(`Unsubscribe failed: ${err.message}`);
    if (req.method === 'POST') return res.status(500).json({ success: false });
    return res.status(500).send(page('Something went wrong', 'We could not process your unsubscribe automatically. Reply to any of our emails with "unsubscribe" and we will remove you manually.'));
  }
}

router.get('/unsubscribe', handleUnsubscribe);
router.post('/unsubscribe', express.urlencoded({ extended: false }), handleUnsubscribe);

// ---------------------------------------------------------------------------
// GET /gmail/callback — OAuth redirect target for connecting the FGA Gmail
// inbox (reply monitoring). State is HMAC-signed with a 10-min TTL and only
// ever minted by the admin-authenticated connect route, so this public
// endpoint can't be used to bind an attacker's inbox.
// ---------------------------------------------------------------------------
router.get('/gmail/callback', async (req, res) => {
  const adminUrl = 'https://www.firstgenautomate.com/admin/drip-campaign';
  try {
    const { code, state, error: oauthError } = req.query;
    if (oauthError) return res.redirect(`${adminUrl}?gmail=error&message=${encodeURIComponent(oauthError)}`);
    if (!code || !state) return res.redirect(`${adminUrl}?gmail=error&message=missing_code_or_state`);

    const { verifyOauthState, completeGmailConnect } = require('../../core/drip-gmail');
    const parsed = verifyOauthState(state);
    if (!parsed || parsed.purpose !== 'drip') {
      return res.redirect(`${adminUrl}?gmail=error&message=invalid_state`);
    }

    const db = getServiceClient();
    const conn = await completeGmailConnect(db, code);
    return res.redirect(`${adminUrl}?gmail=connected&address=${encodeURIComponent(conn.email_address || '')}`);
  } catch (err) {
    log.error(`Gmail OAuth callback failed: ${err.message}`);
    return res.redirect(`${adminUrl}?gmail=error&message=${encodeURIComponent(err.message)}`);
  }
});

module.exports = router;
