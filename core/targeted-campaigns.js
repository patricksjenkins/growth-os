/**
 * Targeted Campaigns — shared core (statuses, transitions, validation,
 * templates, activity, notifications, kill switches).
 *
 * Used by the targeted-campaign agent (worker), the admin API routes, and the
 * scheduler's idle-check predicate. Completely separate from the standard
 * prospecting agent — nothing here touches its config, schedule, or counters.
 */

'use strict';

const crypto = require('crypto');
const { getServiceClient } = require('../db/client');
const { getConfig } = require('./config');

// ─────────────────────────────────────────────────────────────────────
// Status model
// ─────────────────────────────────────────────────────────────────────

const STATUSES = [
  'draft',
  'strategy_review',
  'messaging_review',
  'ready_for_pilot',
  'pilot_running',
  'pilot_awaiting_approval',
  'approved_to_continue',
  'active',
  'paused',
  'audience_exhausted',
  'budget_limit_reached',
  'api_limit_reached',
  'completed',
  'cancelled',
  'archived',
  'failed',
];

// Statuses in which the agent is allowed to run (and therefore spend money).
// In EVERY other status the agent makes ZERO paid API calls — and thanks to
// the scheduler `when` predicate, it isn't even enqueued.
const EXECUTABLE_STATUSES = ['ready_for_pilot', 'pilot_running', 'approved_to_continue', 'active'];

// Terminal statuses — no transitions out except archive (and archived is final).
const TERMINAL_STATUSES = ['completed', 'cancelled', 'archived'];

// Owner-facing labels (single source of truth for the UI via the API).
const STATUS_LABELS = {
  draft: 'Draft',
  strategy_review: 'Strategy Review',
  messaging_review: 'Messaging Review',
  ready_for_pilot: 'Ready for Pilot',
  pilot_running: 'Pilot Running',
  pilot_awaiting_approval: 'Pilot Awaiting Approval',
  approved_to_continue: 'Approved to Continue',
  active: 'Active',
  paused: 'Paused',
  audience_exhausted: 'Audience Exhausted',
  budget_limit_reached: 'Budget Limit Reached',
  api_limit_reached: 'API Limit Reached',
  completed: 'Completed',
  cancelled: 'Cancelled',
  archived: 'Archived',
  failed: 'Failed',
};

// from → [allowed to]. 'cancelled' is reachable from any non-terminal status;
// 'archived' only from settled states.
const ALLOWED_TRANSITIONS = {
  draft: ['strategy_review', 'cancelled'],
  strategy_review: ['draft', 'messaging_review', 'cancelled'],
  messaging_review: ['draft', 'strategy_review', 'ready_for_pilot', 'cancelled'],
  ready_for_pilot: ['pilot_running', 'paused', 'cancelled', 'failed'],
  pilot_running: ['pilot_awaiting_approval', 'paused', 'audience_exhausted', 'budget_limit_reached', 'api_limit_reached', 'cancelled', 'failed'],
  pilot_awaiting_approval: ['approved_to_continue', 'paused', 'cancelled'],
  approved_to_continue: ['active', 'paused', 'audience_exhausted', 'budget_limit_reached', 'api_limit_reached', 'completed', 'cancelled', 'failed'],
  active: ['paused', 'audience_exhausted', 'budget_limit_reached', 'api_limit_reached', 'completed', 'cancelled', 'failed'],
  paused: ['ready_for_pilot', 'pilot_awaiting_approval', 'approved_to_continue', 'active', 'cancelled'],
  audience_exhausted: ['active', 'approved_to_continue', 'completed', 'cancelled', 'archived'],
  budget_limit_reached: ['active', 'approved_to_continue', 'completed', 'cancelled', 'archived'],
  api_limit_reached: ['active', 'approved_to_continue', 'completed', 'cancelled', 'archived'],
  completed: ['archived'],
  cancelled: ['archived'],
  failed: ['ready_for_pilot', 'approved_to_continue', 'active', 'cancelled', 'archived'],
  archived: [],
};

function isExecutable(status) {
  return EXECUTABLE_STATUSES.includes(status);
}

function canTransition(from, to) {
  const allowed = ALLOWED_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

/**
 * Optimistically transition a campaign: UPDATE ... WHERE status = expected.
 * Returns { success, campaign?, error? }. Never throws.
 */
async function transitionCampaign(campaignId, fromStatus, toStatus, { actor = 'system', detail = {}, extraFields = {} } = {}) {
  if (!canTransition(fromStatus, toStatus)) {
    return { success: false, error: `transition ${fromStatus} → ${toStatus} not allowed` };
  }
  try {
    const db = getServiceClient();
    const { data, error } = await db
      .from('targeted_campaigns')
      .update({ status: toStatus, updated_at: new Date().toISOString(), ...extraFields })
      .eq('id', campaignId)
      .eq('status', fromStatus)
      .select()
      .maybeSingle();
    if (error) return { success: false, error: error.message };
    if (!data) return { success: false, error: `campaign not in expected status '${fromStatus}' (raced or stale)` };
    await logCampaignActivity(data.tenant_id, campaignId, actor, 'status_change', {
      from: fromStatus, to: toStatus, ...detail,
    });
    return { success: true, campaign: data };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────

const WEBSITE_RULES = ['no_website', 'allow_any', 'require_website'];

/**
 * Validate the wizard config on a campaign row (or draft payload).
 * Returns { valid, errors: [] }. Strictness scales with the gate: a draft can
 * be sparse; moving past messaging_review requires everything.
 */
function validateCampaignConfig(campaign, { forLaunch = false } = {}) {
  const errors = [];
  const c = campaign || {};

  if (!c.name || !String(c.name).trim()) errors.push('name is required');

  const aud = c.audience || {};
  if (forLaunch) {
    if (!Array.isArray(aud.states) || aud.states.length === 0) errors.push('audience.states must list at least one state');
    if (!Array.isArray(aud.industries) || aud.industries.length === 0) errors.push('audience.industries must list at least one industry');
  }
  if (aud.website_rule && !WEBSITE_RULES.includes(aud.website_rule)) {
    errors.push(`audience.website_rule must be one of ${WEBSITE_RULES.join(', ')}`);
  }
  if (aud.employee_min != null && aud.employee_max != null && Number(aud.employee_min) > Number(aud.employee_max)) {
    errors.push('audience.employee_min cannot exceed employee_max');
  }

  const goal = Number(c.goal_qualified);
  if (!Number.isInteger(goal) || goal < 1 || goal > 1000) errors.push('goal_qualified must be an integer 1-1000');

  const pilot = Number(c.pilot_size);
  if (!Number.isInteger(pilot) || pilot < 1 || pilot > 25) errors.push('pilot_size must be an integer 1-25');

  const daily = Number(c.daily_batch_cap);
  if (!Number.isInteger(daily) || daily < 1 || daily > 25) errors.push('daily_batch_cap must be an integer 1-25');

  if (Number.isInteger(goal) && Number.isInteger(pilot) && pilot > goal) {
    errors.push('pilot_size cannot exceed goal_qualified');
  }

  const budget = c.budget || {};
  for (const k of ['max_serper_calls', 'max_ai_calls', 'max_apify_calls']) {
    if (budget[k] != null && (!Number.isInteger(Number(budget[k])) || Number(budget[k]) < 0)) {
      errors.push(`budget.${k} must be a non-negative integer`);
    }
  }

  if (forLaunch) {
    const opp = c.opportunity || {};
    if (!opp.description || !String(opp.description).trim()) errors.push('opportunity.description is required');
    const sol = c.solution || {};
    if (!Array.isArray(sol.modules) || sol.modules.length === 0) errors.push('solution.modules must list at least one FGA module');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate messaging variants before approval/launch: each approved variant
 * needs an email subject+body AND an FB DM body. Requires >=1 variant (3
 * recommended; the wizard creates A/B/C).
 */
function validateVariants(variants) {
  const errors = [];
  const list = Array.isArray(variants) ? variants : [];
  if (list.length === 0) errors.push('at least one messaging variant is required');
  for (const v of list) {
    const tag = `variant ${v.label || '?'}`;
    if (!v.email_subject || !String(v.email_subject).trim()) errors.push(`${tag}: email_subject is required`);
    if (!v.email_body || !String(v.email_body).trim()) errors.push(`${tag}: email_body is required`);
    if (!v.fb_dm_body || !String(v.fb_dm_body).trim()) errors.push(`${tag}: fb_dm_body is required`);
  }
  return { valid: errors.length === 0, errors };
}

// ─────────────────────────────────────────────────────────────────────
// Template rendering ({{placeholders}} — zero AI calls per lead)
// ─────────────────────────────────────────────────────────────────────

/**
 * Render {{first_name}} {{company}} {{city}} {{state}} {{industry}} (and any
 * other key in ctx) into a template string. Unknown placeholders render as ''.
 */
function renderTemplate(template, ctx = {}) {
  if (!template) return '';
  return String(template).replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
    const val = ctx[key];
    return val == null ? '' : String(val);
  });
}

/** Build the render context for a lead row. */
function leadTemplateContext(lead) {
  const company = lead.company || lead.name || 'your business';
  const contactName = lead.contact_name || lead.metadata?.contact_name || '';
  return {
    first_name: contactName ? String(contactName).split(/\s+/)[0] : 'there',
    company,
    city: lead.city || lead.metadata?.city || '',
    state: lead.state || lead.metadata?.state || '',
    industry: lead.industry || lead.metadata?.industry || '',
  };
}

// ─────────────────────────────────────────────────────────────────────
// Idempotency / handoff
// ─────────────────────────────────────────────────────────────────────

/**
 * Deterministic candidate idempotency key: campaign + best stable identity
 * (domain > phone > normalized name+state). Same business found twice in the
 * same campaign always produces the same key → membership UNIQUE constraint
 * makes re-processing a no-op.
 */
function candidateKey(campaignId, candidate = {}) {
  const domain = (candidate.website || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  const phone = (candidate.phone || '').replace(/\D/g, '');
  const name = (candidate.company || candidate.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const state = (candidate.state || '').toLowerCase();
  const identity = domain || phone || `${name}|${state}`;
  return crypto.createHash('sha1').update(`${campaignId}|${identity}`).digest('hex');
}

// ─────────────────────────────────────────────────────────────────────
// Activity + notifications
// ─────────────────────────────────────────────────────────────────────

/** Append to the campaign audit trail. Best-effort; never throws. */
async function logCampaignActivity(tenantId, campaignId, actor, action, detail = {}) {
  try {
    const db = getServiceClient();
    await db.from('targeted_campaign_activity').insert({
      tenant_id: tenantId, campaign_id: campaignId, actor, action, detail,
    });
  } catch (err) {
    console.warn(`[targeted-campaigns] activity log skipped: ${err.message}`);
  }
}

/**
 * Owner notification with a deep link to the campaign drill-down.
 * Best-effort; never throws.
 */
async function notifyCampaign(tenantId, campaignId, { title, message, priority = 'medium', metadata = {} } = {}) {
  try {
    const db = getServiceClient();
    await db.from('notifications').insert({
      tenant_id: tenantId,
      category: 'targeted_campaign',
      priority,
      title,
      message,
      metadata: { campaign_id: campaignId, deep_link: `/admin/targeted-campaigns/${campaignId}`, ...metadata },
      status: 'pending',
    });
  } catch (err) {
    console.warn(`[targeted-campaigns] notify skipped: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Kill switches + idle check
// ─────────────────────────────────────────────────────────────────────

const GLOBAL_KILL_KEY = 'targeted_campaigns_kill_switch';

/**
 * Global targeted-campaign kill switch (tenant_config). Affects ONLY the
 * targeted agent — never the standard prospecting agent. Fail-safe: a DB
 * error reads as "killed" so we never spend money blind.
 */
function isGloballyKilled(tenant) {
  try {
    const val = getConfig(tenant, GLOBAL_KILL_KEY, false);
    return val === true || val === 'true' || val === '1';
  } catch {
    return true;
  }
}

/**
 * Cheap idle check used by the scheduler `when` predicate: ONE count query,
 * zero paid API calls. If no campaign is executable, the daily job is not
 * even enqueued. Fail-safe: on error return 0 (stay idle).
 */
async function countExecutableCampaigns(tenantId) {
  try {
    const db = getServiceClient();
    let q = db
      .from('targeted_campaigns')
      .select('id', { count: 'exact', head: true })
      .in('status', EXECUTABLE_STATUSES)
      .eq('kill_switch', false);
    if (tenantId) q = q.eq('tenant_id', tenantId);
    const { count, error } = await q;
    if (error) return 0;
    return count || 0;
  } catch {
    return 0;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Budget / limit evaluation (pure)
// ─────────────────────────────────────────────────────────────────────

/**
 * Evaluate a campaign's hard limits. Returns the FIRST limit hit as
 * { limit: 'goal'|'serper'|'ai'|'apify', status } or null when clear.
 * goal → completed; provider caps → api_limit_reached or budget_limit_reached.
 */
function checkCampaignLimits(campaign) {
  if ((campaign.qualified_count || 0) >= (campaign.goal_qualified || 0)) {
    return { limit: 'goal', status: 'completed' };
  }
  const b = campaign.budget || {};
  if (b.max_serper_calls != null && (campaign.serper_calls_used || 0) >= Number(b.max_serper_calls)) {
    return { limit: 'serper', status: 'api_limit_reached' };
  }
  if (b.max_ai_calls != null && (campaign.ai_calls_used || 0) >= Number(b.max_ai_calls)) {
    return { limit: 'ai', status: 'api_limit_reached' };
  }
  if (b.max_apify_calls != null && (campaign.apify_calls_used || 0) >= Number(b.max_apify_calls)) {
    return { limit: 'apify', status: 'api_limit_reached' };
  }
  if (b.max_cost_usd != null && estimateCost(campaign) >= Number(b.max_cost_usd)) {
    return { limit: 'cost', status: 'budget_limit_reached' };
  }
  return null;
}

// Rough per-call cost estimates (USD) for the cost cap + wizard review step.
const COST_PER_CALL = { serper: 0.001, anthropic: 0.02, apify: 0.01 };

function estimateCost(campaign) {
  return (
    (campaign.serper_calls_used || 0) * COST_PER_CALL.serper +
    (campaign.ai_calls_used || 0) * COST_PER_CALL.anthropic +
    (campaign.apify_calls_used || 0) * COST_PER_CALL.apify
  );
}

module.exports = {
  STATUSES,
  STATUS_LABELS,
  EXECUTABLE_STATUSES,
  TERMINAL_STATUSES,
  ALLOWED_TRANSITIONS,
  WEBSITE_RULES,
  GLOBAL_KILL_KEY,
  COST_PER_CALL,
  isExecutable,
  canTransition,
  transitionCampaign,
  validateCampaignConfig,
  validateVariants,
  renderTemplate,
  leadTemplateContext,
  candidateKey,
  logCampaignActivity,
  notifyCampaign,
  isGloballyKilled,
  countExecutableCampaigns,
  checkCampaignLimits,
  estimateCost,
};
