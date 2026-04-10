/**
 * WellMor Chief of Staff Agent
 * Provides operational summaries, pending action tracking,
 * and priority coordination for Morgan and Patrick.
 */

require('dotenv').config();
const express = require('express');
const { createLogger } = require('./shared/logger');
const { supabase } = require('./shared/supabase');

const logger = createLogger('ChiefOfStaffAgent');
const router = express.Router();

/**
 * Get pending content approvals from the queue
 */
async function getPendingApprovals() {
  const { data, error } = await supabase
    .from('content_queue')
    .select('id, platform, headline, status, created_at')
    .eq('status', 'draft')
    .order('created_at', { ascending: false });

  if (error) {
    logger.error('Failed to fetch pending approvals', error);
    return [];
  }
  return data || [];
}

/**
 * Get recently posted content
 */
async function getRecentPosts() {
  const { data, error } = await supabase
    .from('content_queue')
    .select('id, platform, headline, status, updated_at')
    .eq('status', 'posted')
    .order('updated_at', { ascending: false })
    .limit(10);

  if (error) {
    logger.error('Failed to fetch recent posts', error);
    return [];
  }
  return data || [];
}

/**
 * Get approved items waiting to be published
 */
async function getApprovedPending() {
  const { data, error } = await supabase
    .from('content_queue')
    .select('id, platform, headline, status, updated_at')
    .eq('status', 'approved')
    .order('updated_at', { ascending: false });

  if (error) {
    logger.error('Failed to fetch approved items', error);
    return [];
  }
  return data || [];
}

/**
 * Get pipeline summary stats
 */
async function getPipelineStats() {
  const stats = {};

  // Content queue summary
  const { data: queueData } = await supabase
    .from('content_queue')
    .select('status');

  const queue = queueData || [];
  stats.content_queue = {
    drafts: queue.filter(r => r.status === 'draft').length,
    approved: queue.filter(r => r.status === 'approved').length,
    posted: queue.filter(r => r.status === 'posted').length,
    rejected: queue.filter(r => r.status === 'rejected').length,
    total: queue.length
  };

  // Leads summary
  const { data: leadsData } = await supabase
    .from('leads')
    .select('status, priority_tier');

  const leads = leadsData || [];
  stats.leads = {
    total: leads.length,
    tier_a: leads.filter(r => r.priority_tier === 'A').length,
    tier_b: leads.filter(r => r.priority_tier === 'B').length,
    in_sequence: leads.filter(r => r.status === 'in_sequence').length,
    interested: leads.filter(r => r.status === 'interested').length
  };

  // Clients summary
  const { data: clientsData } = await supabase
    .from('clients')
    .select('lifecycle_stage');

  const clients = clientsData || [];
  stats.clients = {
    total: clients.length,
    prospects: clients.filter(r => r.lifecycle_stage === 'prospect').length,
    enriched: clients.filter(r => r.lifecycle_stage === 'enriched').length,
    sequenced: clients.filter(r => r.lifecycle_stage === 'sequenced').length
  };

  // Upcoming meetings
  const { data: meetingsData } = await supabase
    .from('meetings')
    .select('id, scheduled_at, status')
    .gte('scheduled_at', new Date().toISOString())
    .order('scheduled_at', { ascending: true })
    .limit(5);

  stats.upcoming_meetings = meetingsData || [];

  return stats;
}

/**
 * Get recent agent activity
 */
async function getRecentActivity() {
  const { data, error } = await supabase
    .from('agent_activity_log')
    .select('agent_name, action, status, created_at')
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) {
    logger.error('Failed to fetch recent activity', error);
    return [];
  }
  return data || [];
}

/**
 * Build the full briefing
 */
async function buildBriefing() {
  const [
    pendingApprovals,
    approvedPending,
    recentPosts,
    stats,
    recentActivity
  ] = await Promise.all([
    getPendingApprovals(),
    getApprovedPending(),
    getRecentPosts(),
    getPipelineStats(),
    getRecentActivity()
  ]);

  const actionItems = [];

  if (pendingApprovals.length > 0) {
    actionItems.push({
      priority: 'high',
      type: 'approval',
      message: `${pendingApprovals.length} post(s) waiting for approval`,
      count: pendingApprovals.length
    });
  }

  if (approvedPending.length > 0) {
    actionItems.push({
      priority: 'medium',
      type: 'publish',
      message: `${approvedPending.length} approved post(s) ready to publish`,
      count: approvedPending.length
    });
  }

  if (stats.leads.interested > 0) {
    actionItems.push({
      priority: 'high',
      type: 'follow_up',
      message: `${stats.leads.interested} interested lead(s) need follow-up`,
      count: stats.leads.interested
    });
  }

  if (stats.upcoming_meetings.length > 0) {
    actionItems.push({
      priority: 'medium',
      type: 'meeting',
      message: `${stats.upcoming_meetings.length} upcoming meeting(s)`,
      count: stats.upcoming_meetings.length
    });
  }

  return {
    timestamp: new Date().toISOString(),
    action_items: actionItems,
    pending_approvals: pendingApprovals,
    approved_pending: approvedPending,
    recent_posts: recentPosts,
    stats,
    recent_activity: recentActivity
  };
}

// ============================================================================
// ROUTES
// ============================================================================

/**
 * GET /agents/chief-of-staff/briefing
 * Full operational briefing
 */
router.get('/briefing', async (req, res) => {
  try {
    const briefing = await buildBriefing();

    logger.success('Briefing generated', {
      actions: briefing.action_items.length
    });

    res.json({
      success: true,
      briefing
    });
  } catch (err) {
    logger.error('Briefing failed', err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * GET /agents/chief-of-staff/actions
 * Just the action items (for dashboard cards)
 */
router.get('/actions', async (req, res) => {
  try {
    const briefing = await buildBriefing();

    res.json({
      success: true,
      action_items: briefing.action_items,
      stats: briefing.stats
    });
  } catch (err) {
    logger.error('Actions fetch failed', err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * GET /agents/chief-of-staff/dashboard
 * Lightweight dashboard data for mobile app
 */
router.get('/dashboard', async (req, res) => {
  try {
    const [pendingApprovals, recentPosts, stats] = await Promise.all([
      getPendingApprovals(),
      getRecentPosts(),
      getPipelineStats()
    ]);

    res.json({
      success: true,
      dashboard: {
        pending_count: pendingApprovals.length,
        approved_count: stats.content_queue.approved,
        posted_count: stats.content_queue.posted,
        total_clients: stats.clients.total,
        prospects: stats.clients.prospects,
        enriched: stats.clients.enriched,
        sequenced: stats.clients.sequenced,
        total_leads: stats.leads.total,
        tier_a_leads: stats.leads.tier_a,
        upcoming_meetings: stats.upcoming_meetings.length,
        pending_approvals: pendingApprovals.slice(0, 5),
        recent_posts: recentPosts.slice(0, 5)
      }
    });
  } catch (err) {
    logger.error('Dashboard fetch failed', err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * GET /agents/chief-of-staff/digest
 * Daily digest — formatted summary suitable for email or Slack
 */
router.get('/digest', async (req, res) => {
  try {
    const briefing = await buildBriefing();
    const s = briefing.stats;
    const now = new Date();

    const lines = [
      `WellMor Daily Digest — ${now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}`,
      '',
    ];

    // Action items
    if (briefing.action_items.length > 0) {
      lines.push('ACTION ITEMS:');
      for (const item of briefing.action_items) {
        const icon = item.priority === 'high' ? '[!]' : '[-]';
        lines.push(`  ${icon} ${item.message}`);
      }
      lines.push('');
    } else {
      lines.push('No urgent action items today.');
      lines.push('');
    }

    // Content queue
    lines.push('CONTENT QUEUE:');
    lines.push(`  Drafts pending: ${s.content_queue.drafts}`);
    lines.push(`  Approved (ready): ${s.content_queue.approved}`);
    lines.push(`  Posted: ${s.content_queue.posted}`);
    lines.push(`  Rejected: ${s.content_queue.rejected}`);
    lines.push('');

    // Pipeline
    lines.push('SALES PIPELINE:');
    lines.push(`  Total clients: ${s.clients.total}`);
    lines.push(`  Prospects: ${s.clients.prospects}`);
    lines.push(`  Enriched: ${s.clients.enriched}`);
    lines.push(`  In sequence: ${s.clients.sequenced}`);
    lines.push('');

    // Leads
    if (s.leads.total > 0) {
      lines.push('LEADS:');
      lines.push(`  Total: ${s.leads.total} | Tier A: ${s.leads.tier_a} | Tier B: ${s.leads.tier_b}`);
      lines.push(`  In sequence: ${s.leads.in_sequence} | Interested: ${s.leads.interested}`);
      lines.push('');
    }

    // Meetings
    if (s.upcoming_meetings.length > 0) {
      lines.push('UPCOMING MEETINGS:');
      for (const m of s.upcoming_meetings) {
        const dt = new Date(m.scheduled_at).toLocaleString('en-US', {
          weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
        });
        lines.push(`  ${dt} — ${m.status}`);
      }
      lines.push('');
    }

    // Recent activity
    if (briefing.recent_activity.length > 0) {
      lines.push('RECENT AGENT ACTIVITY (last 5):');
      for (const a of briefing.recent_activity.slice(0, 5)) {
        const time = new Date(a.created_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        lines.push(`  ${time} — ${a.agent_name}: ${a.action} (${a.status})`);
      }
    }

    const digest = lines.join('\n');

    logger.success('Daily digest generated');

    res.json({
      success: true,
      digest,
      briefing
    });
  } catch (err) {
    logger.error('Digest failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
module.exports.buildBriefing = buildBriefing;
