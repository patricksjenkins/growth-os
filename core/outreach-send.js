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

const { resolveRecipientEmail } = require('./recipient');
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
  const { data: claimed, error: claimError } = await db
    .from('outreach_sequences')
    .update({ sequence_status: 'sending', updated_at: new Date().toISOString() })
    .eq('id', sequenceId)
    .eq('tenant_id', FGA_TENANT_ID)
    .eq('sequence_status', 'draft')
    .select('id');
  if (claimError) {
    return { ok: false, code: 'claim_failed', error: 'Could not safely claim this draft' };
  }
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

  // Recipient — resolved through the SHARED resolver so the gate that approved
  // this send and the send itself cannot disagree about where it goes. This
  // read the sequence's contact and nothing else, so a lead whose address sat
  // on the lead record died here as 'no_email' AFTER passing every gate.
  // The address comes from the shared resolver, which applies tenant + lead
  // scoping. A failed identity read is uncertainty, never permission to send.
  const { data: leadRow, error: leadError } = await db.from('leads')
    .select('id, email').eq('id', sequence.lead_id).eq('tenant_id', FGA_TENANT_ID).maybeSingle();
  if (leadError || !leadRow) {
    await revertClaim();
    return { ok: false, code: 'lead_not_in_tenant', error: leadError ? 'Lead identity could not be verified' : 'Sequence lead does not belong to this tenant' };
  }
  let resolved;
  try {
    resolved = await resolveRecipientEmail(db, FGA_TENANT_ID, leadRow, sequence);
  } catch (recipientError) {
    await revertClaim();
    return { ok: false, code: 'recipient_unverified', error: `Recipient identity could not be verified: ${recipientError.message}` };
  }
  const toEmail = resolved.email;
  if (!toEmail) {
    await revertClaim();
    return { ok: false, code: 'no_email', error: 'No email address on the sequence contact or the lead' };
  }

  // Tenant configuration supplies identity and CAN-SPAM requirements. Failure
  // is blocking because a generic fallback is not safe for cold outreach.
  let tenant;
  try {
    tenant = await resolveTenant(db, FGA_TENANT_ID);
  } catch (tenantError) {
    await revertClaim();
    return { ok: false, code: 'tenant_config_unavailable', error: `FGA sending identity is unavailable: ${tenantError.message}` };
  }

  // HTML body: prefer the conversation's stored body_html, fall back to a
  // plain-text conversion. Then send-time signature refresh (guarantees the
  // live phone number ships).
  const { data: conv, error: conversationError } = await db
    .from('conversations')
    .select('metadata, message_body')
    .eq('sequence_id', sequence.id)
    .order('created_at', { ascending: false })
    .limit(1);
  if (conversationError) {
    await revertClaim();
    return { ok: false, code: 'approved_copy_unverified', error: 'Approved email copy could not be verified' };
  }
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
  let unsubUrl;
  try {
    const { unsubscribeUrl } = require('./drip-campaign');
    unsubUrl = unsubscribeUrl(leadId, toEmail);
  } catch (unsubErr) {
    await revertClaim();
    return { ok: false, code: 'unsubscribe_unavailable', error: `Unsubscribe link unavailable: ${unsubErr.message}` };
  }
  const postalAddress = cfg(tenant, 'postal_address', null);
  if (!postalAddress) {
    await revertClaim();
    return { ok: false, code: 'postal_address_missing', error: 'FGA postal address is required before cold outreach can send' };
  }

  // Designed-hybrid shell (core/email-shell.js): wordmark header, the personal
  // prose (drafts stay editable plain paragraphs in the Pipeline UI), ONE
  // button that opens the site with UTM tracking, tagline footer. Applied at
  // send time only, so nothing about drafting/editing changes.
  try {
    const { renderOutreachEmail } = require('./email-shell');
    htmlBody = renderOutreachEmail({
      bodyHtml: htmlBody,
      // Reply-first cold touch: no prominent marketing button before trust.
      cta: null,
      unsubscribeUrl: unsubUrl,
      postalAddress,
    });
  } catch (shellErr) {
    await revertClaim();
    return { ok: false, code: 'email_assembly_failed', error: `Compliant email assembly failed: ${shellErr.message}` };
  }

  // Optional dedicated sending identity (deliverability isolation). Set
  // autosend_from_email only after the Resend domain is verified — replies
  // still go to patrick@ so the Gmail reply sync keeps working.
  const fromOverride = cfg(tenant, 'autosend_from_email', null);

  let sendResult = null;
  try {
    const { sendEmail } = require('../integrations/email');
    sendResult = await sendEmail(toEmail, sequence.message_subject, htmlBody, {
      tenant,
      replyTo: 'patrick@firstgenautomate.com',
      idempotencyKey: `fga-outreach-${sequence.id}`,
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

  // Non-throwing development/skipped responses are not deliveries. A first
  // touch advances the funnel only when the provider accepted it and returned
  // an immutable provider id.
  if (sendResult?.status !== 'sent' || !sendResult?.id) {
    await revertClaim();
    return {
      ok: false,
      code: 'provider_not_accepted',
      error: `Email provider did not accept the message (${sendResult?.status || 'unknown'})`,
    };
  }

  // Mark sent. sent_at lives in metadata (no sent_at column — PostgREST
  // rejects unknown columns).
  const sentAt = new Date().toISOString();
  const { error: seqUpdErr } = await db.from('outreach_sequences')
    .update({
      sequence_status: 'sent',
      updated_at: sentAt,
      /*
       * IMMUTABLE SNAPSHOT OF WHAT THE PROVIDER ACTUALLY RECEIVED.
       *
       * message_body holds the copy BEFORE assembly. The delivered email is
       * built here at send time: the body (possibly the conversation's
       * body_html), a refreshed signature, the branded shell, the CTA, the
       * unsubscribe link and the postal footer. So reading message_body back
       * and calling it "exactly as sent" was wrong — it is the draft copy, and
       * every audit-facing surface that showed it was overstating its
       * evidence. (Codex 2026-07-27.)
       *
       * Recorded once, at the moment of sending, and never rewritten.
       */
      metadata: {
        ...(sequence.metadata || {}),
        sent_at: sentAt,
        sent_via: via,
        ...(batchId ? { batch_id: batchId } : {}),
        delivered: {
          subject: sequence.message_subject || null,
          html: htmlBody || null,
          recipient: toEmail,
          provider_id: sendResult?.id || null,
          at: sentAt,
          // What the assembled body actually included, so a reader can say so
          // rather than implying more fidelity than it has.
          includes: {
            signature: true,
            shell: Boolean(htmlBody && htmlBody.includes('firstgenautomate')),
            unsubscribe: Boolean(unsubUrl),
            postal_address: Boolean(postalAddress),
          },
        },
      },
    })
    .eq('id', sequenceId)
    .eq('tenant_id', FGA_TENANT_ID);
  if (seqUpdErr) {
    log.error(`Sequence ${sequenceId} sent but status update failed: ${seqUpdErr.message}`);
    return {
      ok: false,
      code: 'accepted_state_unpersisted',
      error: 'Provider accepted the message but the local delivery state could not be persisted',
      send_result: sendResult,
    };
  }

  const restartBatchId = sequence.metadata?.restart_batch_id || null;
  if (restartBatchId) {
    const { error: consumeError } = await db
      .from('growth_restart_candidates')
      .update({ first_touch_sent_at: sentAt })
      .eq('tenant_id', FGA_TENANT_ID)
      .eq('batch_id', restartBatchId)
      .eq('lead_id', leadId)
      .eq('first_touch_sequence_id', sequenceId)
      .is('first_touch_sent_at', null);
    if (consumeError) {
      // The provider and local sequence state are already durable. Do not
      // resend; surface the incomplete restart receipt for reconciliation.
      log.error(`Restart authorization receipt failed for ${sequenceId}: ${consumeError.message}`);
    }
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

  try {
    const { recordGrowthEvent } = require('./growth/events');
    await recordGrowthEvent(db, {
      tenantId: FGA_TENANT_ID,
      leadId,
      eventType: 'first_touch_provider_accepted',
      stage: 'provider_accepted',
      sourceSystem: 'resend',
      sourceId: sendResult.id,
      actor: via,
      evidence: { provider_status: sendResult.status, sequence_id: sequenceId, touch_number: 1 },
      messageVersion: sequence.metadata?.message_version || null,
      correlationId: sequenceId,
    });
  } catch (eventErr) {
    // Deployment-safe while migration 106 rolls out. The provider snapshot on
    // outreach_sequences remains durable and can be backfilled idempotently.
    log.warn(`Growth event write deferred for ${sequenceId}: ${eventErr.message}`);
  }

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
      if (restartBatchId && enrollResult.enrollment?.id) {
        await db.from('growth_restart_candidates')
          .update({ applied_enrollment_id: enrollResult.enrollment.id })
          .eq('tenant_id', FGA_TENANT_ID)
          .eq('batch_id', restartBatchId)
          .eq('lead_id', leadId)
          .eq('first_touch_sequence_id', sequenceId);
      }
    }
  } catch (dripErr) {
    log.warn(`Drip enrollment skipped for lead ${leadId}: ${dripErr.message}`);
  }

  return { ok: true, send_result: sendResult, recipient: toEmail };
}

module.exports = { sendEmailOutreachSequence };
