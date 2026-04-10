/**
 * WellMor Clients Agent
 * Provides API endpoints for client/prospect management.
 * Used by the mobile app for client list, search, and detail views.
 *
 * Actual clients table columns:
 *   id, company, industry, size, status, lifecycle_stage, morgan_notes,
 *   lead_score, lead_tier, outreach_ready, outreach_recommendation,
 *   domain, website, hq_city, hq_state, employee_count_actual,
 *   icp_score, icp_tier, source, enrichment_status, enriched_at,
 *   created_at, updated_at
 */

require('dotenv').config();
const express = require('express');
const { createLogger } = require('./shared/logger');
const { supabase } = require('./shared/supabase');

const logger = createLogger('ClientsAgent');
const router = express.Router();

/**
 * GET /agents/clients/list
 * List all clients with optional search and filters
 * Query params: search, stage, tier, limit, offset
 */
router.get('/list', async (req, res) => {
  try {
    const {
      search,
      stage,
      tier,
      limit = 50,
      offset = 0
    } = req.query;

    let query = supabase
      .from('clients')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1);

    if (search) {
      query = query.or(`company.ilike.%${search}%,industry.ilike.%${search}%,morgan_notes.ilike.%${search}%`);
    }

    if (stage) {
      query = query.eq('lifecycle_stage', stage);
    }

    if (tier) {
      query = query.eq('lead_tier', tier);
    }

    const { data, error, count } = await query;

    if (error) {
      if (error.message?.includes('does not exist')) {
        return res.json({
          success: true,
          clients: [],
          total: 0,
          limit: Number(limit),
          offset: Number(offset),
          note: 'Clients table column issue — check schema'
        });
      }
      throw error;
    }

    res.json({
      success: true,
      clients: data || [],
      total: count || 0,
      limit: Number(limit),
      offset: Number(offset)
    });
  } catch (err) {
    logger.error('Client list failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /agents/clients/detail/:id
 * Get a single client with contacts
 */
router.get('/detail/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: client, error } = await supabase
      .from('clients')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !client) {
      return res.status(404).json({ success: false, error: 'Client not found' });
    }

    // Fetch associated contacts (uses client_id foreign key)
    const { data: contacts } = await supabase
      .from('contacts')
      .select('id, first_name, last_name, title, email, linkedin_url, phone, is_primary_contact, role_in_buying')
      .eq('client_id', id)
      .order('is_primary_contact', { ascending: false });

    res.json({
      success: true,
      client,
      contacts: contacts || []
    });
  } catch (err) {
    logger.error('Client detail failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /agents/clients/stats
 * Client pipeline summary stats
 */
router.get('/stats', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('clients')
      .select('lifecycle_stage, lead_tier');

    if (error) {
      if (error.message?.includes('does not exist')) {
        // Try without lead_tier (column may not exist yet)
        const { data: fallback, error: fallbackErr } = await supabase
          .from('clients')
          .select('lifecycle_stage');

        if (fallbackErr) {
          return res.json({
            success: true,
            stats: { total: 0, by_stage: {}, by_tier: {} },
            note: 'Clients table needs migration'
          });
        }

        const clients = fallback || [];
        const stats = { total: clients.length, by_stage: {}, by_tier: {} };
        for (const c of clients) {
          const stage = c.lifecycle_stage || 'unknown';
          stats.by_stage[stage] = (stats.by_stage[stage] || 0) + 1;
        }
        return res.json({ success: true, stats });
      }
      throw error;
    }

    const clients = data || [];
    const stats = {
      total: clients.length,
      by_stage: {},
      by_tier: {}
    };

    for (const client of clients) {
      const stage = client.lifecycle_stage || 'unknown';
      const tier = client.lead_tier || 'unscored';
      stats.by_stage[stage] = (stats.by_stage[stage] || 0) + 1;
      stats.by_tier[tier] = (stats.by_tier[tier] || 0) + 1;
    }

    res.json({ success: true, stats });
  } catch (err) {
    logger.error('Client stats failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
