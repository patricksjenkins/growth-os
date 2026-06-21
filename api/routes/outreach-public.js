/**
 * Public Outreach endpoints (no auth) — email unsubscribe / opt-out.
 * Mounted at /api/outreach. CAN-SPAM compliance for referral/commercial emails.
 */
const express = require('express');
const router = express.Router();
const { db } = require('../../db/client');
const { verifyUnsubToken } = require('../../core/outreach');
const { createLogger } = require('../../core/logger');
const log = createLogger('outreach-public');

async function doUnsubscribe(token) {
  const enrollmentId = verifyUnsubToken(token);
  if (!enrollmentId) return { ok: false };
  const { data: enr } = await db.from('outreach_enrollments').select('*').eq('id', enrollmentId).maybeSingle();
  if (!enr) return { ok: false };
  // stop the enrollment + flag the underlying contact as unsubscribed
  await db.from('outreach_enrollments').update({ status: 'stopped', stopped_reason: 'unsubscribed', next_send_at: null, updated_at: new Date().toISOString() }).eq('id', enrollmentId);
  if (enr.customer_id) await db.from('customers').update({ unsubscribed: true, updated_at: new Date().toISOString() }).eq('id', enr.customer_id);
  if (enr.referral_partner_id) await db.from('referral_partners').update({ unsubscribed: true, outreach_status: 'stopped', updated_at: new Date().toISOString() }).eq('id', enr.referral_partner_id);
  if (enr.commercial_prospect_id) await db.from('commercial_prospects').update({ unsubscribed: true, outreach_status: 'stopped', updated_at: new Date().toISOString() }).eq('id', enr.commercial_prospect_id);
  log.info(`unsubscribed enrollment ${enrollmentId}`);
  return { ok: true };
}

function page(msg) {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribe</title></head>
<body style="font-family:Arial,Helvetica,sans-serif;background:#F7F6F1;color:#22312b;display:flex;align-items:center;justify-content:center;min-height:90vh;margin:0;">
<div style="max-width:420px;text-align:center;padding:28px;background:#fff;border-radius:14px;box-shadow:0 2px 12px rgba(0,0,0,.06);">
<h2 style="color:#1F5130;margin:0 0 10px;">A Kut Above Tree Services</h2><p style="font-size:16px;line-height:1.5;">${msg}</p></div></body></html>`;
}

router.get('/unsubscribe', async (req, res) => {
  try {
    const r = await doUnsubscribe(req.query.token);
    res.status(200).send(page(r.ok ? 'You have been unsubscribed. You will not receive further emails from us. Thank you.' : 'This unsubscribe link is invalid or has expired.'));
  } catch (err) {
    res.status(200).send(page('Something went wrong, but we will honor your request — please reply to the email to be removed.'));
  }
});

// RFC 8058 one-click
router.post('/unsubscribe', async (req, res) => {
  try { await doUnsubscribe(req.query.token); res.json({ success: true }); }
  catch (err) { res.json({ success: true }); }
});

module.exports = router;
