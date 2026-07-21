/**
 * First Gen Automate — shared prospect-outreach email send (THE choke point)
 *
 * Extracted from api/routes/admin.js (2026-07-03) so the autonomous outreach
 * agent, the admin individual-approve route, and the pipeline bulk-send all go
 * through ONE proven path. Everything that made the manual path safe is here:
 *
 *  - atomic draft -> sending claim (duplicate-send proof under concurrency)
 *  - send-time signature refresh
 *  - designed-hybrid email shell (core/email-shell.js)
 *  - CAN-SPAM: visible unsubscribe link + List-Unsubscribe headers + postal
 *    address (required for autonomous bulk sends; see core/auto-outreach.js)
 *  - status transitions (sequence -> sent, lead -> contacted/sequenced)
 *  - activity log + drip-campaign Day-1 auto-enrollment
 *
 * DO NOT add a second send path. Extend this one.
 */

const { createLogger } = require('./logger');
const { FGA_TENANT_ID, getConfig } = require('./config');
const { resolveTenant } = require('./tenant');
const { applyHtmlSignature } = require('./email-signature');

const log = createLogger('outreach-send');

async function logLeadActivity(db, action, leadId, metadata = {}) {
  try {
    // Fixed 2026-07-21: this wrote `type`/`details` — not activity_log
    // columns, and `action` is NOT NULL — so EVERY send logged through this
    // choke point failed silently. Downstream, admin-drip's Day-1 derivation
    // reads action='outreach_sent' + entity_id + metadata.sent_at, so those
    // fields (and sent_at) are now first-class here.
    await db.from('activity_log').insert({
      tenant_id: FGA_TENANT_ID,
      agent: 'outreach-send',
      action,
      entity_type: 'lead',
      entity_id: leadId,
      level: 'info',
      metadata: { sent_at: new Date().toISOString(), ...metadata },
    });
  } catch (err) {
    log.warn(`activity_log insert failed (${action}): ${err.message}`);
  }
}

/** Read one tenant_config value via the canonical accessor (null-safe). */
function cfg(tenant, key, fallback = null) {
  if (!tenant) return fallback;
  const v = getConfig(tenant, key, fallback);
  return v === undefined || v === null || v === '' ? fallback : v;
}

/**
 * Shared individual email send. Returns { ok, code?, error?, send_result? }.
 * Codes: not_found | mismatch | wrong_channel | already_processed | no_email
 * | send_failed.
 *
 * @param {object} opts
 * @param {string|null} opts.batchId  pipeline bulk-send batch id
 * @param {string}      opts.sentVia  'individual' | 'bulk_send' | 'auto_send'
 */
async function sendEmailOutreachSequence(db, leadId, sequenceId, { batchId = null, sentVia = null } = {}) {
  const via = sentVia || (batchId ? 'bulk_send' : 'individual');
  const { data: sequence, error: seqErr } = await db
    .from('outreach_sequences')
    .select('*')
    .eq('id', sequenceId)
    .eq('tenant_id', FGA_TENANT_ID)
    .single();
  if (seqErr || !sequence) return { ok: false, code: 'not_found', error: 'Sequence not found' };
  if (sequence.lead_id !== leadId) return { ok: false, code: 'mismatch', error: 'Sequence does not belong to lead' };
  if (sequence.sequence_type !== 'email') return { ok: false, code: 'wrong_channel', error: 'Only email drafts can be auto-sent' };
  if (sequence.sequence_status !== 'draft') {
    return { ok: false, code: 'already_processed', error: `Sequence is already ${sequence.sequence_status}` };
  }

  // ATOMIC CLAIM — draft → sending. The conditional UPDATE means exactly
  // one caller wins; everyone else sees already_processed. This is the
  // duplicate-send guard for the manual, bulk AND autonomous paths.
  const { data: claimed } = await db
    .from('outreach_sequences')
    .update({ sequence_status: 'sending', updated_at: new Date().toISOString() })
    .eq('id', sequenceId)
    .eq('tenant_id', FGA_TENANT_ID)
    .eq('sequence_status', 'draft')
    .select('id');
  if (!claimed || claimed.length === 0) {
    return { ok: false, code: 'already_processed', error: 'Draft was already sent or is being sent' };
  }
  const revertClaim = async () => {
    await db.from('outreach_sequences')
      .update({ sequence_status: 'draft', updated_at: new Date().toISOString() })
      .eq('id', sequenceId)
      .eq('tenant_id', FGA_TENANT_ID)
      .eq('sequence_status', 'sending');
  };

  // Recipient — same rule as the individual approve route.
  const { data: contact } = await db
    .from('contacts')
    .select('email, first_name, last_name')
    .eq('id', sequence.contact_id)
    .single();
  const toEmail = contact?.email;
  if (!toEmail) {
    await revertClaim();
    return { ok: false, code: 'no_email', error: 'Contact has no email address' };
  }

  // Tenant (signature + config-driven send options). Non-fatal on failure.
  let tenant = null;
  try {
    tenant = await resolveTenant(db, FGA_TENANT_ID);
  } catch (_) { /* handled per-feature below */ }

  // HTML body: prefer the conversation's stored body_html, fall back to a
  // plain-text conversion. Then send-time signature refresh (guarantees the
  // live phone number ships).
  const { data: conv } = await db
    .from('conversations')
    .select('metadata, message_body')
    .eq('sequence_id', sequence.id)
    .order('created_at', { ascending: false })
    .limit(1);
  let htmlBody = conv && conv[0]?.metadata?.body_html
    ? conv[0].metadata.body_html
    : `<p>${(sequence.message_body || '').replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>')}</p>`;
  try {
    if (tenant) htmlBody = applyHtmlSignature(htmlBody, tenant);
  } catch (sigErr) {
    log.warn(`Signature refresh skipped (using stored body): ${sigErr.message}`);
  }

  // CAN-SPAM for cold outreach: a working unsubscribe link (reuses the drip
  // unsubscribe endpoint — it writes drip_suppressions, which every future
  // send path checks) + the business postal address in the footer.
  let unsubUrl = null;
  try {
    const { unsubscribeUrl } = require('./drip-campaign');
    unsubUrl = unsubscribeUrl(leadId, toEmail);
  } catch (unsubErr) {
    log.warn(`Unsubscribe link unavailable: ${unsubErr.message}`);
  }
  const postalAddress = cfg(tenant, 'postal_address', null);

  // Designed-hybrid shell (core/email-shell.js): wordmark header, the personal
  // prose (drafts stay editable plain paragraphs in the Pipeline UI), ONE
  // button that opens the site with UTM tracking, tagline footer. Applied at
  // send time only, so nothing about drafting/editing changes.
  try {
    const { renderOutreachEmail, withUtm, SITE } = require('./email-shell');
    htmlBody = renderOutreachEmail({
      bodyHtml: htmlBody,
      cta: {
        label: 'See how First Gen Automate works',
        url: withUtm(`${SITE}/how-it-works`, { campaign: 'outreach', content: via }),
      },
      unsubscribeUrl: unsubUrl,
      postalAddress,
    });
  } catch (shellErr) {
    log.warn(`Email shell skipped (sending unwrapped body): ${shellErr.message}`);
  }

  // Optional dedicated sending identity (deliverability isolation). Set
  // autosend_from_email only after the Resend domain is verified — replies
  // still go to patrick@ so the Gmail reply sync keeps working.
  const fromOverride = cfg(tenant, 'autosend_from_email', null);

  let sendResult = null;
  try {
    const { sendEmail } = require('../integrations/email');
    sendResult = await sendEmail(toEmail, sequence.message_subject, htmlBody, {
      replyTo: 'patrick@firstgenautomate.com',
      ...(fromOverride ? { from: fromOverride } : {}),
      ...(unsubUrl ? {
        headers: {
          'List-Unsubscribe': `<${unsubUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      } : {}),
    });
  } catch (sendErr) {
    log.error(`Outreach send failed (${sequenceId}): ${sendErr.message}`);
    await revertClaim();
    return { ok: false, code: 'send_failed', error: `Send failed: ${sendErr.message}` };
  }

  // Mark sent. sent_at lives in metadata (no sent_at column — PostgREST
  // rejects unknown columns).
  const sentAt = new Date().toISOString();
  const { error: seqUpdErr } = await db.from('outreach_sequences')
    .update({
      sequence_status: 'sent',
      updated_at: sentAt,
      metadata: { ...(sequence.metadata || {}), sent_at: sentAt, sent_via: via, ...(batchId ? { batch_id: batchId } : {}) },
    })
    .eq('id', sequenceId)
    .eq('tenant_id', FGA_TENANT_ID);
  if (seqUpdErr) {
    log.error(`Sequence ${sequenceId} sent but status update failed: ${seqUpdErr.message}`);
  }

  await db.from('conversations')
    .update({
      metadata: {
        draft_status: 'sent',
        sent_at: sentAt,
        send_result: sendResult || null,
        sent_via: via,
        ...(batchId ? { batch_id: batchId } : {}),
      },
    })
    .eq('tenant_id', FGA_TENANT_ID)
    .eq('sequence_id', sequenceId);

  await db.from('leads')
    .update({ lifecycle_stage: 'sequenced', status: 'contacted' })
    .eq('id', leadId)
    .eq('tenant_id', FGA_TENANT_ID);

  await logLeadActivity(db, 'outreach_sent', leadId, {
    sequence_id: sequenceId,
    channel: 'email',
    recipient: toEmail,
    subject: sequence.message_subject || null,
    provider_id: sendResult?.id || null,
    sent_via: via,
    ...(batchId ? { batch_id: batchId } : {}),
  });

  // Drip-campaign enrollment — Campaign Day 1 = this successful send.
  // enrollLead is a no-op (with a skipped_reason) when the feature flag is
  // off, no active campaign exists, the email is suppressed, or the lead is
  // already enrolled. Wrapped so drip bookkeeping can NEVER break the
  // proven send path above.
  try {
    const { enrollLead } = require('./drip-campaign');
    const { data: leadRow } = await db
      .from('leads').select('*').eq('id', leadId).eq('tenant_id', FGA_TENANT_ID).maybeSingle();
    const enrollResult = await enrollLead(db, {
      leadId,
      email: toEmail,
      day1At: sentAt,
      enrolledBy: via,
      tenant,
      lead: leadRow || null,
    });
    if (enrollResult?.enrolled) {
      log.info(`Drip enrollment created for lead ${leadId} (day 1 = ${sentAt})`);
    }
  } catch (dripErr) {
    log.warn(`Drip enrollment skipped for lead ${leadId}: ${dripErr.message}`);
  }

  return { ok: true, send_result: sendResult, recipient: toEmail };
}

module.exports = { sendEmailOutreachSequence };
