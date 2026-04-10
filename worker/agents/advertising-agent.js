/**
 * Advertising Agent
 * Weekly advertising performance analysis and recommendations
 * Analyzes ROI, CPL, and provides strategic recommendations
 */

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { createLogger } = require('./shared/logger');
const { askClaudeJSON } = require('./shared/claude');
const {
  supabase,
  getSystemConfig,
  createActivityLog
} = require('./shared/supabase');

const logger = createLogger('AdvertisingAgent');
const router = express.Router();

/**
 * Fetch last 30 days of marketing performance data
 * @returns {Promise<Object>} Performance data grouped by channel
 */
async function fetchPerformanceData() {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split('T')[0];

    const { data, error } = await supabase
      .from('marketing_performance')
      .select('*')
      .gte('date', thirtyDaysAgo)
      .order('date', { ascending: false });

    if (error) {
      throw error;
    }

    // Group by channel
    const grouped = {};
    (data || []).forEach(row => {
      if (!grouped[row.channel]) {
        grouped[row.channel] = [];
      }
      grouped[row.channel].push(row);
    });

    return grouped;
  } catch (error) {
    logger.error('Error fetching performance data', error);
    return {};
  }
}

/**
 * Fetch lead source attribution data
 * @returns {Promise<Object>} Leads by source
 */
async function fetchLeadAttribution() {
  try {
    const { data, error } = await supabase
      .from('leads')
      .select('source, id')
      .gte('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());

    if (error) {
      throw error;
    }

    // Count by source
    const counts = {};
    (data || []).forEach(lead => {
      if (lead.source) {
        counts[lead.source] = (counts[lead.source] || 0) + 1;
      }
    });

    return counts;
  } catch (error) {
    logger.error('Error fetching lead attribution', error);
    return {};
  }
}

/**
 * Fetch meetings booked by lead source
 * @returns {Promise<Object>} Meetings by source
 */
async function fetchMeetingsBySource() {
  try {
    const { data, error } = await supabase
      .from('meetings')
      .select('leads(source)')
      .gte('scheduled_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());

    if (error) {
      throw error;
    }

    // Count by source
    const counts = {};
    (data || []).forEach(meeting => {
      const source = meeting.leads?.source;
      if (source) {
        counts[source] = (counts[source] || 0) + 1;
      }
    });

    return counts;
  } catch (error) {
    logger.error('Error fetching meetings by source', error);
    return {};
  }
}

/**
 * Calculate key metrics from performance data
 * @param {Object} performanceByChannel - Performance data grouped by channel
 * @param {Object} leadCounts - Lead counts by source
 * @param {Object} meetingCounts - Meeting counts by source
 * @returns {Promise<Object>} Calculated metrics
 */
async function calculateMetrics(
  performanceByChannel,
  leadCounts,
  meetingCounts
) {
  try {
    const metrics = {};

    for (const [channel, performances] of Object.entries(performanceByChannel)) {
      // Sum totals
      const totalSpend = performances.reduce((sum, p) => sum + (p.spend || 0), 0);
      const totalClicks = performances.reduce((sum, p) => sum + (p.clicks || 0), 0);
      const totalImpressions = performances.reduce(
        (sum, p) => sum + (p.impressions || 0),
        0
      );

      // Get lead count for this channel
      const leadsFromChannel = leadCounts[channel] || 0;
      const meetingsFromChannel = meetingCounts[channel] || 0;

      // Calculate CPL and other metrics
      const cpl = leadsFromChannel > 0 ? totalSpend / leadsFromChannel : 0;
      const ctr =
        totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;
      const conversionRate =
        totalClicks > 0 ? (leadsFromChannel / totalClicks) * 100 : 0;
      const leadToMeetingRate =
        leadsFromChannel > 0 ? (meetingsFromChannel / leadsFromChannel) * 100 : 0;

      metrics[channel] = {
        spend: parseFloat(totalSpend.toFixed(2)),
        clicks: totalClicks,
        impressions: totalImpressions,
        leads: leadsFromChannel,
        meetings: meetingsFromChannel,
        cpl: parseFloat(cpl.toFixed(2)),
        ctr: parseFloat(ctr.toFixed(2)),
        conversion_rate: parseFloat(conversionRate.toFixed(2)),
        lead_to_meeting_rate: parseFloat(leadToMeetingRate.toFixed(2))
      };
    }

    return metrics;
  } catch (error) {
    logger.error('Error calculating metrics', error);
    return {};
  }
}

/**
 * Generate advertising analysis using Claude
 * @param {Object} metrics - Calculated metrics
 * @returns {Promise<Object>} Analysis report
 */
async function generateAnalysis(metrics) {
  try {
    logger.info('Generating advertising analysis');

    // Build metrics summary
    const metricsSummary = Object.entries(metrics)
      .map(
        ([channel, data]) => `
${channel.toUpperCase()}:
- Spend: $${data.spend}
- Leads: ${data.leads}
- CPL: $${data.cpl}
- CTR: ${data.ctr}%
- Lead-to-Meeting Rate: ${data.lead_to_meeting_rate}%
- Meetings Booked: ${data.meetings}`
      )
      .join('\n');

    const userMessage = `Analyze this advertising performance data and provide strategic recommendations:

${metricsSummary}

Benchmark targets:
- LinkedIn CPL: $75-150
- Google Search CPL: $50-100
- LinkedIn CTR: 0.4%+
- Google CTR: 3%+
- Lead-to-Meeting Rate Target: 15%+

Return as JSON:
{
  "executive_summary": string (3-4 sentences),
  "channel_analysis": {
    "channel_name": {
      "performance": string,
      "vs_benchmark": string,
      "key_insight": string
    }
  },
  "top_recommendations": [
    {
      "priority": number (1-3),
      "title": string,
      "description": string,
      "expected_impact": string,
      "action_items": [string]
    }
  ],
  "ab_test_suggestions": [string] (2-3 tests),
  "budget_recommendation": {
    "total_monthly_budget": number,
    "allocation_by_channel": {
      "channel_name": number (percentage or dollar amount)
    },
    "rationale": string
  },
  "critical_alerts": [string] (if any)
}`;

    const systemPrompt = `You are a digital marketing analyst for WellMor Benefits & Co. You analyze paid advertising performance and provide strategic recommendations.

IMPORTANT CONSTRAINTS:
- You can only recommend budget changes, not execute them automatically if >$200 per channel
- Never recommend starting a new advertising platform without human approval
- Focus on B2B benefits consulting ROI metrics
- Benchmark CPL targets: LinkedIn $75-150, Google Search $50-100

Metrics to analyze:
- CPL (cost per lead) vs. benchmarks
- CTR (click-through rate): LinkedIn benchmark 0.4%+, Google 3%+
- Lead-to-meeting rate: target 15%+
- Week-over-week performance trends
- Best and worst performing campaigns/ad sets

Provide:
1. Executive summary (3-4 sentences)
2. Channel-by-channel analysis
3. Top 3 prioritized recommendations (specific, actionable)
4. A/B test suggestions
5. Budget reallocation recommendation (within approved limits)`;

    const report = await askClaudeJSON(systemPrompt, userMessage, {
      maxTokens: 2500
    });

    return report;
  } catch (error) {
    logger.error('Error generating analysis', error);
    throw error;
  }
}

/**
 * Update Airtable Ad Performance base
 * @param {Object} metrics - Calculated metrics
 * @returns {Promise<void>}
 */
async function updateAirtable(metrics) {
  try {
    const airtableApiKey = process.env.AIRTABLE_API_KEY;
    const airtableBaseId = process.env.AIRTABLE_BASE_ID_ADS;

    if (!airtableApiKey || !airtableBaseId) {
      logger.warn('Airtable credentials not configured');
      return;
    }

    // Create records for each channel
    for (const [channel, data] of Object.entries(metrics)) {
      const records = [
        {
          fields: {
            Channel: channel,
            Date: new Date().toISOString().split('T')[0],
            Spend: data.spend,
            Leads: data.leads,
            Meetings: data.meetings,
            CPL: data.cpl,
            CTR: data.ctr,
            'Conversion Rate': data.conversion_rate,
            'Lead-to-Meeting Rate': data.lead_to_meeting_rate
          }
        }
      ];

      await axios.post(
        `https://api.airtable.com/v0/${airtableBaseId}/Performance`,
        { records },
        {
          headers: {
            Authorization: `Bearer ${airtableApiKey}`,
            'Content-Type': 'application/json'
          }
        }
      );
    }

    logger.info('Updated Airtable with performance data');
  } catch (error) {
    logger.warn('Could not update Airtable', error.message);
  }
}

/**
 * Send Slack notification with analysis
 * @param {Object} report - Analysis report
 * @param {Object} metrics - Calculated metrics
 * @returns {Promise<void>}
 */
async function sendSlackNotification(report, metrics) {
  try {
    const slackWebhook = process.env.SLACK_WEBHOOK_URL;
    if (!slackWebhook) {
      logger.warn('SLACK_WEBHOOK_URL not configured');
      return;
    }

    // Format recommendations for Slack
    const recommendations = report.top_recommendations
      .slice(0, 3)
      .map(
        (r, i) =>
          `${i + 1}. *${r.title}* (Priority ${r.priority})\n${r.description}`
      )
      .join('\n\n');

    // Format metrics summary
    const metricsSummary = Object.entries(metrics)
      .map(([channel, data]) => {
        const cplBenchmark = channel.includes('linkedin') ? 150 : 100;
        const cplStatus = data.cpl <= cplBenchmark ? '✓' : '⚠';
        return `${cplStatus} ${channel}: CPL $${data.cpl}, Leads ${data.leads}, Meetings ${data.meetings}`;
      })
      .join('\n');

    const criticalAlerts =
      report.critical_alerts && report.critical_alerts.length > 0
        ? `⚠️ *ALERTS:* ${report.critical_alerts.join(', ')}`
        : '';

    const payload = {
      text: 'Weekly Advertising Performance Report',
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: 'Weekly Advertising Performance',
            emoji: true
          }
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Executive Summary*\n${report.executive_summary}`
          }
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Performance by Channel*\n${metricsSummary}`
          }
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Top Recommendations*\n${recommendations}`
          }
        }
      ]
    };

    if (criticalAlerts) {
      payload.blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: criticalAlerts
        }
      });
    }

    await axios.post(slackWebhook, payload);
    logger.info('Sent Slack notification with analysis');
  } catch (error) {
    logger.warn('Could not send Slack notification', error.message);
  }
}

/**
 * Run advertising analysis
 * @returns {Promise<Object>} Summary of analysis
 */
async function run() {
  const startTime = Date.now();

  try {
    logger.info('Starting advertising analysis');

    // Fetch data
    const performanceByChannel = await fetchPerformanceData();
    const leadCounts = await fetchLeadAttribution();
    const meetingCounts = await fetchMeetingsBySource();

    if (Object.keys(performanceByChannel).length === 0) {
      logger.info('No performance data available');
      return {
        success: false,
        message: 'No performance data available',
        duration_ms: Date.now() - startTime
      };
    }

    logger.info('Fetched performance data', {
      channels: Object.keys(performanceByChannel)
    });

    // Calculate metrics
    const metrics = await calculateMetrics(
      performanceByChannel,
      leadCounts,
      meetingCounts
    );

    logger.info('Calculated metrics', metrics);

    // Generate analysis
    const report = await generateAnalysis(metrics);

    logger.success('Generated advertising analysis');

    // Update Airtable
    await updateAirtable(metrics);

    // Send Slack notification
    await sendSlackNotification(report, metrics);

    // Store report in Supabase
    const { data: storedReport } = await supabase
      .from('marketing_performance_reports')
      .insert([
        {
          id: uuidv4(),
          report_data: report,
          metrics: metrics,
          created_at: new Date().toISOString()
        }
      ])
      .select()
      .single();

    // Log activity
    await createActivityLog('AdvertisingAgent', 'generated_analysis', 'system', 'advertising', {
      channels_analyzed: Object.keys(metrics).length,
      metrics: metrics,
      top_recommendation: report.top_recommendations[0]?.title
    });

    const duration = Date.now() - startTime;

    logger.success('Advertising analysis completed', {
      channels: Object.keys(metrics).length,
      duration: duration
    });

    return {
      success: true,
      channels_analyzed: Object.keys(metrics).length,
      report_id: storedReport.id,
      metrics,
      top_recommendations: report.top_recommendations.slice(0, 3),
      duration_ms: duration,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    logger.error('Advertising analysis failed', error);
    throw error;
  }
}

/**
 * Express route handler
 */
router.post('/run', async (req, res) => {
  try {
    const result = await run();
    res.json({
      success: result.success,
      data: result
    });
  } catch (error) {
    logger.error('Route handler error', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = {
  run,
  router,
  generateAnalysis
};
