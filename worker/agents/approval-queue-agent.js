require('dotenv').config();
const express = require('express');
const { createLogger } = require('./shared/logger');
const { supabase } = require('./shared/supabase');
const { notifyNewDrafts, notifyPostApproved } = require('./notification-service');
const { sendPushNotification } = require('./notification-push');

const logger = createLogger('ApprovalQueueAgent');
const router = express.Router();

/**
 * UPDATED: Saves carousel campaigns to queue.
 * - Instagram gets full carousel_images array in campaign_payload
 * - Other platforms get the hero (slide 1) image
 * - All platforms store the full carousel slides for reference
 */
async function saveCampaignToQueue(campaign) {
  const content = campaign?.content || {};
  const image = campaign?.image || {};
  const carouselImages = campaign?.carousel_images || [];
  const distribution = campaign?.distribution || {};

  const rows = [];

  // Shared fields across all platforms
  const sharedFields = {
    content_type: content.type || 'carousel',
    status: 'draft',
    headline: content.headline || null,
    subtext: content.subtext || null,
    hook: content.hook || null,
    cta: content.cta || null,
    image_file_name: image.file_name || null,
    image_file_path: image.file_path || null,
    campaign_payload: campaign
  };

  if (distribution.linkedin) {
    rows.push({
      ...sharedFields,
      platform: 'linkedin',
      post_copy: distribution.linkedin.caption || content.post || null,
      best_time: distribution.linkedin.best_time || null,
      goal: distribution.linkedin.goal || null
    });
  }

  if (distribution.instagram) {
    rows.push({
      ...sharedFields,
      platform: 'instagram',
      post_copy: distribution.instagram.caption || content.post || null,
      best_time: distribution.instagram.best_time || null,
      goal: distribution.instagram.goal || null
    });
  }

  if (distribution.x) {
    rows.push({
      ...sharedFields,
      platform: 'x',
      post_copy: distribution.x.caption || content.post || null,
      best_time: distribution.x.best_time || null,
      goal: distribution.x.goal || null
    });
  }

  if (distribution.threads) {
    rows.push({
      ...sharedFields,
      platform: 'threads',
      post_copy: distribution.threads.caption || content.post || null,
      best_time: distribution.threads.best_time || null,
      goal: distribution.threads.goal || null
    });
  }

  const { data, error } = await supabase
    .from('content_queue')
    .insert(rows)
    .select();

  if (error) throw error;
  return data || [];
}

async function listDraftQueue() {
  const { data, error } = await supabase
    .from('content_queue')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data || [];
}

async function updateQueueStatus(id, status, actor) {
  const now = new Date().toISOString();
  const updates = {
    status,
    updated_at: now
  };

  if (status === 'approved') {
    updates.approved_at = now;
    updates.approved_by = actor || 'system';
  } else if (status === 'rejected') {
    updates.rejected_at = now;
    updates.rejected_by = actor || 'system';
  } else if (status === 'posted') {
    updates.posted_at = now;
  }

  const { data, error } = await supabase
    .from('content_queue')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function listQueueByStatus(status) {
  const { data, error } = await supabase
    .from('content_queue')
    .select('*')
    .eq('status', status)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data || [];
}

async function listQueueByPlatform(platform) {
  const { data, error } = await supabase
    .from('content_queue')
    .select('*')
    .eq('platform', platform)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data || [];
}

async function getQueueSummary() {
  const { data, error } = await supabase
    .from('content_queue')
    .select('platform, status');

  if (error) throw error;

  const rows = data || [];
  const summary = {
    total: rows.length,
    by_status: {},
    by_platform: {}
  };

  for (const row of rows) {
    const status = row.status || 'unknown';
    const platform = row.platform || 'unknown';

    summary.by_status[status] = (summary.by_status[status] || 0) + 1;
    summary.by_platform[platform] = (summary.by_platform[platform] || 0) + 1;
  }

  return summary;
}

router.post('/save', async (req, res) => {
  try {
    const { campaign } = req.body || {};

    if (!campaign) {
      return res.status(400).json({
        success: false,
        error: 'campaign is required'
      });
    }

    const saved = await saveCampaignToQueue(campaign);

    logger.success(`Saved ${saved.length} queued posts`);

    // Notify about new drafts
    if (saved.length > 0) {
      notifyNewDrafts(saved).catch(err => logger.warn('Notification failed', err));
      sendPushNotification({
        title: 'New posts ready for review',
        body: `${saved.length} post${saved.length > 1 ? 's' : ''} waiting for approval`,
        data: { type: 'approval_request', count: saved.length }
      }).catch(err => logger.warn('Push notification failed', err));
    }

    res.json({
      success: true,
      saved
    });
  } catch (err) {
    logger.error('Queue save failed', err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

router.get('/list', async (req, res) => {
  try {
    const queue = await listDraftQueue();

    res.json({
      success: true,
      queue
    });
  } catch (err) {
    logger.error('Queue list failed', err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

router.get('/drafts', async (req, res) => {
  try {
    const queue = await listQueueByStatus('draft');
    res.json({
      success: true,
      queue
    });
  } catch (err) {
    logger.error('Queue drafts failed', err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

router.get('/approved', async (req, res) => {
  try {
    const queue = await listQueueByStatus('approved');
    res.json({
      success: true,
      queue
    });
  } catch (err) {
    logger.error('Queue approved failed', err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

router.get('/posted', async (req, res) => {
  try {
    const queue = await listQueueByStatus('posted');
    res.json({
      success: true,
      queue
    });
  } catch (err) {
    logger.error('Queue posted failed', err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

router.get('/platform/:platform', async (req, res) => {
  try {
    const { platform } = req.params;
    const queue = await listQueueByPlatform(platform);
    res.json({
      success: true,
      queue
    });
  } catch (err) {
    logger.error('Queue platform failed', err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

router.get('/summary', async (req, res) => {
  try {
    const summary = await getQueueSummary();
    res.json({
      success: true,
      summary
    });
  } catch (err) {
    logger.error('Queue summary failed', err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

router.post('/approve', async (req, res) => {
  try {
    const { id, actor } = req.body || {};

    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'id is required'
      });
    }

    // Verify item exists and is in draft status
    const { data: item } = await supabase
      .from('content_queue')
      .select('id, status')
      .eq('id', id)
      .single();

    if (!item) {
      return res.status(404).json({ success: false, error: 'Queue item not found' });
    }

    if (item.status !== 'draft') {
      return res.status(400).json({
        success: false,
        error: `Cannot approve item with status: ${item.status}`
      });
    }

    const updated = await updateQueueStatus(id, 'approved', actor);

    logger.success(`Approved queue item ${id}`, { actor });

    // Notify approval
    notifyPostApproved(updated).catch(err => logger.warn('Notification failed', err));

    res.json({
      success: true,
      updated
    });
  } catch (err) {
    logger.error('Approve failed', err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

router.post('/reject', async (req, res) => {
  try {
    const { id, actor } = req.body || {};

    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'id is required'
      });
    }

    // Verify item exists and is in draft status
    const { data: item } = await supabase
      .from('content_queue')
      .select('id, status')
      .eq('id', id)
      .single();

    if (!item) {
      return res.status(404).json({ success: false, error: 'Queue item not found' });
    }

    if (item.status !== 'draft') {
      return res.status(400).json({
        success: false,
        error: `Cannot reject item with status: ${item.status}`
      });
    }

    const updated = await updateQueueStatus(id, 'rejected', actor);

    logger.success(`Rejected queue item ${id}`, { actor });

    res.json({
      success: true,
      updated
    });
  } catch (err) {
    logger.error('Reject failed', err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

/**
 * GET /agents/approval-queue/item/:id
 * Get a single queue item by ID (for mobile detail view)
 */
router.get('/item/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('content_queue')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !data) {
      return res.status(404).json({ success: false, error: 'Item not found' });
    }

    res.json({ success: true, item: data });
  } catch (err) {
    logger.error('Item fetch failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
module.exports.saveCampaignToQueue = saveCampaignToQueue;
