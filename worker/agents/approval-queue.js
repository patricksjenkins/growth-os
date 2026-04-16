/**
 * Growth OS — Approval Queue Agent (Tenant-Aware)
 *
 * Scans content drafts that need approval and sends a push notification to
 * the business owner's device(s). Falls back to email if the tenant has
 * digest_email configured and no active push devices. Also handles
 * auto-approval for tenants that have it enabled.
 */

const { createLogger } = require('../../core/logger');
const { getConfig } = require('../../core/config');
const { db } = require('../../db/client');
const { sendEmail } = require('../../integrations/email');
const { sendPushToTenant } = require('../../integrations/push');

/**
 * @param {Object} tenant - Resolved tenant
 * @param {Object} payload - {}
 */
async function run(tenant, payload = {}) {
  const log = createLogger('approval-queue', tenant.slug);

  const businessName = getConfig(tenant, 'business_name', tenant.name || 'Our Company');
  const ownerEmail = getConfig(tenant, 'digest_email', tenant.owner_email);
  const autoApprove = getConfig(tenant, 'auto_approve_content', false);

  // Fetch pending drafts
  const { data: drafts, error: fetchErr } = await db
    .from('content_drafts')
    .select('id, platform, headline, body, content_type, topic, created_at')
    .eq('tenant_id', tenant.id)
    .eq('status', 'draft')
    .order('created_at', { ascending: true })
    .limit(50);

  if (fetchErr) throw fetchErr;

  if (!drafts || !drafts.length) {
    log.info('No drafts pending approval');
    return { success: true, pending: 0, message: 'Queue empty' };
  }

  log.info(`${drafts.length} drafts pending approval`);

  // Auto-approve if enabled
  if (autoApprove) {
    const ids = drafts.map(d => d.id);
    await db
      .from('content_drafts')
      .update({ status: 'approved' })
      .in('id', ids);

    log.success(`Auto-approved ${ids.length} drafts`);
    return { success: true, auto_approved: ids.length };
  }

  const platformCounts = {};
  for (const d of drafts) {
    platformCounts[d.platform] = (platformCounts[d.platform] || 0) + 1;
  }
  const platformSummary = Object.entries(platformCounts)
    .map(([p, c]) => `${p}: ${c}`)
    .join(', ');

  // Primary channel: push notification
  let pushResult = { sent: 0 };
  try {
    const pushTitle = drafts.length === 1
      ? `1 post needs your approval`
      : `${drafts.length} posts need your approval`;
    const pushBody = drafts.length === 1
      ? (drafts[0].headline || drafts[0].topic || 'Open the app to review.')
      : `${platformSummary}. Open the app to review.`;

    pushResult = await sendPushToTenant(tenant.id, {
      title: pushTitle,
      body: pushBody,
      data: {
        type: 'approval_queue',
        count: drafts.length,
        screen: 'PendingPosts',
      },
    });
    if (pushResult.sent > 0) {
      log.info(`Push sent to ${pushResult.sent} device(s)`);
    }
  } catch (err) {
    log.warn('Push notification failed', err.message);
  }

  // Email fallback (if no devices got the push and we have an email on file)
  let emailSent = false;
  if (pushResult.sent === 0 && ownerEmail) {
    const previewHtml = drafts.slice(0, 5).map(d =>
      `<li><strong>${d.platform}</strong> — ${d.headline || d.topic || 'Untitled'}</li>`
    ).join('');

    try {
      await sendEmail(
        ownerEmail,
        `${businessName}: ${drafts.length} posts need your approval`,
        `
          <h2>${drafts.length} Posts Ready for Review</h2>
          <p>Platforms: ${platformSummary}</p>
          <ul>${previewHtml}</ul>
          ${drafts.length > 5 ? `<p>...and ${drafts.length - 5} more</p>` : ''}
          <p>Open the app to approve or reject.</p>
        `
      );
      emailSent = true;
      log.info(`Approval digest email sent to ${ownerEmail}`);
    } catch (err) {
      log.warn('Failed to send approval email', err.message);
    }
  }

  // Log activity
  try {
    await db.from('activity_log').insert({
      tenant_id: tenant.id,
      agent: 'approval-queue',
      action: 'approval_digest_sent',
      entity_type: 'system',
      metadata: {
        pending_count: drafts.length,
        push_sent: pushResult.sent,
        email_sent: emailSent,
      },
    });
  } catch (err) {
    // activity_log is optional; don't fail the agent
  }

  return {
    success: true,
    pending: drafts.length,
    push_sent: pushResult.sent,
    email_sent: emailSent,
  };
}

module.exports = run;
