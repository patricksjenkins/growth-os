/**
 * Growth OS — Support Workflow
 * Automated support triage, FAQ matching, and escalation.
 */

const { createLogger } = require('./logger');
const log = createLogger('support');

// ---------------------------------------------------------------------------
// FAQ patterns — matched against ticket subject/body
// ---------------------------------------------------------------------------

const FAQ_PATTERNS = [
  {
    patterns: ['upload photo', 'how do i upload', 'add photo', 'send photo', 'upload picture'],
    subject: 'How to Upload Photos',
    response: `Here's how to upload photos from your app:\n\n1. Open your app on your phone.\n2. Tap the "+" button at the bottom of the screen.\n3. Select "Upload Photos" from the menu.\n4. Choose photos from your camera roll, or take new ones.\n5. Add a short description of the job (optional, we'll generate the caption).\n6. Tap "Upload."\n\nYour photos will be turned into social media posts within 24 hours. You'll get a notification to approve them before they go live.\n\nIf you have any trouble, reply to this email and we'll help you out.`,
  },
  {
    patterns: ['approve content', 'how do i approve', 'review post', 'approve post', 'pending content'],
    subject: 'How to Approve Content',
    response: `Here's how to approve content in your app:\n\n1. Open your app on your phone.\n2. You'll see a notification badge if content is waiting for approval.\n3. Tap "Content" in the bottom navigation.\n4. Review the pending post. You'll see the image and caption.\n5. Tap "Approve" to schedule it for publishing, or "Edit" to request changes.\n\nApproved content goes out according to your publishing schedule (typically 3-4 posts per week).\n\nIf you don't approve within 48 hours, we'll send you a reminder.`,
  },
  {
    patterns: ['when will my post', 'posting schedule', 'when do posts go', 'post schedule', 'when are posts'],
    subject: 'Your Posting Schedule',
    response: `Your social media posts are scheduled to go out on a consistent schedule, typically 3-4 times per week at times when your audience is most active.\n\nHere's how it works:\n- You upload photos (or we use the ones from your intake form).\n- The system generates a caption and image for each post.\n- You approve the content from your app.\n- The system posts it at the next scheduled slot.\n\nYou can see your upcoming schedule in the app under "Content" then "Scheduled."\n\nWant to adjust your posting frequency or times? Reply to this email and we'll update it for you.`,
  },
  {
    patterns: ['change billing', 'update payment', 'credit card', 'billing info', 'payment method', 'update card'],
    subject: 'Updating Your Billing Information',
    response: `You can update your billing information anytime through the Stripe customer portal:\n\n1. Visit your billing portal (link included in your monthly invoice email).\n2. Click "Update payment method."\n3. Enter your new card details.\n4. Save.\n\nIf you can't find the link, reply to this email and we'll send you a fresh portal link.\n\nYour subscription renews on the same date each month. All invoices and receipts are available in the billing portal.`,
  },
  {
    patterns: ['cancel', 'want to cancel', 'end subscription', 'stop service', 'cancel my account', 'discontinue'],
    subject: 'Cancellation Request',
    response: `We're sorry to hear you're thinking about canceling. Before we process anything, we'd love to understand what's not working.\n\nA member of our team will reach out within 24 hours to see if there's anything we can do to help. Sometimes a small adjustment makes all the difference.\n\nIf you've already made up your mind, we'll make the cancellation process smooth and straightforward. No hassle, no guilt.`,
    escalate: true,
    escalateReason: 'churn_risk',
  },
];

// ---------------------------------------------------------------------------
// handleSupportRequest — log ticket, auto-respond, classify priority
// ---------------------------------------------------------------------------

async function handleSupportRequest(supabase, tenantId, subject, body, channel = 'email') {
  log.info(`Support request from tenant ${tenantId}: ${subject}`);

  // Classify priority
  const priority = _classifyPriority(subject, body);

  // Create ticket
  const { data: ticket, error } = await supabase
    .from('support_tickets')
    .insert({
      tenant_id: tenantId,
      subject,
      body,
      channel,
      priority,
      status: 'open',
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to create support ticket: ${error.message}`);

  // Attempt auto-response
  const autoResult = await autoRespond(supabase, tenantId, subject, body, ticket.id);

  // Check if escalation is needed
  if (autoResult.escalate) {
    await escalateToFounder(supabase, tenantId, ticket.id, autoResult.escalateReason);
  }

  return {
    ticketId: ticket.id,
    priority,
    autoResponded: autoResult.matched,
    escalated: autoResult.escalate || false,
  };
}

// ---------------------------------------------------------------------------
// autoRespond — match against FAQ patterns, send canned response if matched
// ---------------------------------------------------------------------------

async function autoRespond(supabase, tenantId, subject, body, ticketId) {
  const searchText = `${subject} ${body}`.toLowerCase();

  for (const faq of FAQ_PATTERNS) {
    const matched = faq.patterns.some((pattern) => searchText.includes(pattern));
    if (matched) {
      log.info(`Auto-responding to ticket ${ticketId} with FAQ: ${faq.subject}`);

      // Mark ticket as auto-responded
      await supabase
        .from('support_tickets')
        .update({ auto_responded: true })
        .eq('id', ticketId);

      // In production: send the response via email using the email integration
      // await email.send(tenantId, 'support-response', { subject: faq.subject, body: faq.response })

      return {
        matched: true,
        faqSubject: faq.subject,
        response: faq.response,
        escalate: faq.escalate || false,
        escalateReason: faq.escalateReason || null,
      };
    }
  }

  // No match — will need manual response
  log.info(`No FAQ match for ticket ${ticketId} — awaiting manual response`);
  return { matched: false, escalate: false };
}

// ---------------------------------------------------------------------------
// escalateToFounder — alert founder for critical tickets
// ---------------------------------------------------------------------------

async function escalateToFounder(supabase, tenantId, ticketId, reason) {
  log.warn(`Escalating ticket ${ticketId} to founder — reason: ${reason}`);

  await supabase
    .from('support_tickets')
    .update({ escalated: true, priority: 'high' })
    .eq('id', ticketId);

  // In production: send push notification / SMS / email to founder
  // Reasons that trigger escalation:
  //   - 'platform_bug'   — something is broken
  //   - 'billing_dispute' — payment/billing complaint
  //   - 'churn_risk'     — customer wants to cancel or is unhappy
  log.info(`Founder notified about escalated ticket ${ticketId} (${reason})`);

  return { escalated: true, reason };
}

// ---------------------------------------------------------------------------
// getSupportMetrics — aggregate metrics for a tenant
// ---------------------------------------------------------------------------

async function getSupportMetrics(supabase, tenantId) {
  const { data: tickets, error } = await supabase
    .from('support_tickets')
    .select('*')
    .eq('tenant_id', tenantId);

  if (error) throw new Error(`Failed to fetch support metrics: ${error.message}`);

  const all = tickets || [];
  const resolved = all.filter((t) => t.status === 'resolved');
  const open = all.filter((t) => t.status === 'open');

  // Calculate average resolution time (for resolved tickets with timestamps)
  let avgResolutionMs = null;
  const resolvedWithTime = resolved.filter((t) => t.resolved_at && t.created_at);
  if (resolvedWithTime.length > 0) {
    const totalMs = resolvedWithTime.reduce((sum, t) => {
      return sum + (new Date(t.resolved_at) - new Date(t.created_at));
    }, 0);
    avgResolutionMs = totalMs / resolvedWithTime.length;
  }

  const avgResolutionHours = avgResolutionMs
    ? Math.round(avgResolutionMs / (1000 * 60 * 60) * 10) / 10
    : null;

  return {
    tenantId,
    totalTickets: all.length,
    openTickets: open.length,
    resolvedTickets: resolved.length,
    resolutionRate: all.length > 0 ? Math.round((resolved.length / all.length) * 100) : 0,
    avgResponseTimeHours: avgResolutionHours,
    autoRespondedCount: all.filter((t) => t.auto_responded).length,
    escalatedCount: all.filter((t) => t.escalated).length,
    byPriority: {
      low: all.filter((t) => t.priority === 'low').length,
      normal: all.filter((t) => t.priority === 'normal').length,
      high: all.filter((t) => t.priority === 'high').length,
      urgent: all.filter((t) => t.priority === 'urgent').length,
    },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _classifyPriority(subject, body) {
  const text = `${subject} ${body}`.toLowerCase();

  // Urgent: system down, can't login, data loss
  if (/system.*(down|broken|crash)|can'?t (log ?in|access)|data (loss|missing|gone)/i.test(text)) {
    return 'urgent';
  }

  // High: billing, cancel, not working
  if (/cancel|billing|charge|refund|not working|broken|bug/i.test(text)) {
    return 'high';
  }

  // Low: feature request, general question
  if (/feature|suggest|idea|wondering|curious|question/i.test(text)) {
    return 'low';
  }

  return 'normal';
}

module.exports = {
  handleSupportRequest,
  autoRespond,
  escalateToFounder,
  getSupportMetrics,
  FAQ_PATTERNS,
};
