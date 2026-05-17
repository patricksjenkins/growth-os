/**
 * Growth OS — Per-Tenant Usage Cap Enforcement
 *
 * Central checker + incrementer for the volume limits in CLAUDE.md.
 * Every expensive op (Claude call, email send, Twilio voice minute,
 * Gemini image, chat reply, lead capture, outreach send) runs through
 * here so the platform never burns more than the tenant's tier allows.
 *
 * Usage:
 *   const { checkUsageOrThrow, incrementUsage, UsageCapExceededError } = require('./usage-caps');
 *
 *   try {
 *     await checkUsageOrThrow(tenant, 'email_send_count');
 *     // ... do the expensive thing ...
 *     await incrementUsage(tenant.id, 'email_send_count', 1);
 *   } catch (err) {
 *     if (err instanceof UsageCapExceededError) {
 *       // graceful fallback — agent shouldn't crash
 *     } else { throw err; }
 *   }
 *
 * Per-tenant override:
 *   Any cap can be overridden per-tenant via
 *   tenant_config.usage_cap.<column_name> (numeric value).
 *
 * Resets:
 *   - Monthly counters reset to 0 on the 1st of the month via the
 *     'monthly-usage-reset' cron (worker/agents/monthly-usage-reset.js).
 *   - Daily counters (lead_capture_count_today) reset inside
 *     checkUsageOrThrow when the stored date is not today.
 */

const { db } = require('../db/client');
const { getConfig } = require('./config');
const { createLogger } = require('./logger');

const log = createLogger('usage-caps');

// ── Tier defaults ──
// Keys match the column names in tenant_usage. Caps are *monthly* unless
// the key name says otherwise (lead_capture_count_today is daily).
const TIER_CAPS = {
  growth: {
    sms_count:                    500,
    email_send_count:             500,
    chat_msg_count:               500,
    image_gen_count:              50,
    twilio_voice_minutes_total:   1000,
    lead_capture_count_today:     200,
    claude_spend_cents:           1000, // $10.00
    outreach_send_count:          200,  // Growth gets 1/3 of Scale outreach
    voice_minutes_used:           0,    // Voice Receptionist is Scale-only
  },
  scale: {
    sms_count:                    1000,
    email_send_count:             2000,
    chat_msg_count:               1000,
    image_gen_count:              100,
    twilio_voice_minutes_total:   2000,
    lead_capture_count_today:     200,
    claude_spend_cents:           2500, // $25.00
    outreach_send_count:          600,
    voice_minutes_used:           200,
  },
};

// Map column name → ISO 8601 period for human messages
const CAP_LABELS = {
  sms_count:                  { unit: 'SMS messages', period: 'this month' },
  email_send_count:           { unit: 'emails',       period: 'this month' },
  chat_msg_count:             { unit: 'chat replies', period: 'this month' },
  image_gen_count:            { unit: 'image generations', period: 'this month' },
  twilio_voice_minutes_total: { unit: 'voice minutes',period: 'this month' },
  lead_capture_count_today:   { unit: 'inbound leads',period: 'today' },
  claude_spend_cents:         { unit: 'AI spend (cents)', period: 'this month' },
  outreach_send_count:        { unit: 'outreach sends',   period: 'this month' },
  voice_minutes_used:         { unit: 'AI-answered voice minutes', period: 'this month' },
};

class UsageCapExceededError extends Error {
  constructor(tenantId, column, used, cap) {
    super(`Tenant ${tenantId} hit cap on ${column}: ${used}/${cap}`);
    this.name = 'UsageCapExceededError';
    this.tenantId = tenantId;
    this.column = column;
    this.used = used;
    this.cap = cap;
  }
}

/**
 * Pull the per-tenant cap value for a given column.
 * Order of precedence:
 *   1. tenant_config.usage_cap.<column> (per-tenant override)
 *   2. TIER_CAPS[tier][column] (tier default)
 *   3. fallback to 0 (no cap means "not available on this tier")
 *
 * @param {Object} tenant - resolved tenant (with config + tier loaded)
 * @param {string} column - usage column name
 * @returns {number}
 */
function getCap(tenant, column) {
  const overrides = getConfig(tenant, 'usage_cap', {}) || {};
  if (typeof overrides[column] === 'number') return overrides[column];

  const tier = (tenant.tier || tenant.subscription_tier || 'growth').toLowerCase();
  const tierCaps = TIER_CAPS[tier] || TIER_CAPS.growth;
  return tierCaps[column] ?? 0;
}

/**
 * Refresh + read current usage for a tenant. Handles the daily-counter
 * roll-over for lead_capture_count_today.
 *
 * @param {string} tenantId
 * @returns {Promise<Object>} the tenant_usage row (auto-created if missing)
 */
async function getUsage(tenantId) {
  // Try to fetch; create if missing
  const { data } = await db.from('tenant_usage')
    .select('*')
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (data) return data;
  const { data: created } = await db.from('tenant_usage')
    .insert({ tenant_id: tenantId })
    .select('*')
    .single();
  return created;
}

/**
 * Reset the daily lead-capture counter if the stored date isn't today.
 * Self-healing — runs inline on every checkUsageOrThrow for the daily
 * counter, no cron needed.
 */
async function maybeResetDailyCounters(tenantId, usage) {
  const today = new Date().toISOString().slice(0, 10);
  const storedDate = usage.lead_capture_count_today_date
    ? new Date(usage.lead_capture_count_today_date).toISOString().slice(0, 10)
    : null;
  if (storedDate !== today) {
    await db.from('tenant_usage')
      .update({ lead_capture_count_today: 0, lead_capture_count_today_date: today })
      .eq('tenant_id', tenantId);
    usage.lead_capture_count_today = 0;
    usage.lead_capture_count_today_date = today;
  }
  return usage;
}

/**
 * Throws UsageCapExceededError if adding `amount` to the current usage
 * would exceed the cap. Pass `amount=0` to check without intent to add.
 *
 * @param {Object} tenant - resolved tenant object
 * @param {string} column - usage column name (must be in TIER_CAPS)
 * @param {number} amount - amount the caller intends to add (default 1)
 */
async function checkUsageOrThrow(tenant, column, amount = 1) {
  if (!tenant || !tenant.id) throw new Error('checkUsageOrThrow: tenant.id required');
  const cap = getCap(tenant, column);

  // Cap of 0 means "not available on this tier" → throw immediately
  if (cap === 0) {
    throw new UsageCapExceededError(tenant.id, column, 0, 0);
  }

  let usage = await getUsage(tenant.id);

  // Daily counters self-heal
  if (column === 'lead_capture_count_today') {
    usage = await maybeResetDailyCounters(tenant.id, usage);
  }

  const used = Number(usage[column] || 0);
  if (used + amount > cap) {
    throw new UsageCapExceededError(tenant.id, column, used, cap);
  }
  return { used, cap, remaining: cap - used };
}

/**
 * Atomic-ish increment of a usage counter. Tries the `increment_usage`
 * RPC first (atomic SQL); falls back to read-modify-write if the RPC
 * isn't available (e.g. dev DB without migration 019).
 *
 * Fire-and-forget — caller should not await this on the hot path
 * unless they care about strict ordering.
 *
 * @param {string} tenantId
 * @param {string} column
 * @param {number} amount
 */
async function incrementUsage(tenantId, column, amount = 1) {
  if (!tenantId || !column || amount === 0) return;
  try {
    await db.rpc('increment_usage', {
      p_tenant_id: tenantId,
      p_column: column,
      p_amount: amount,
    });
  } catch (rpcErr) {
    // Fallback: read-modify-write
    try {
      const { data } = await db.from('tenant_usage')
        .select(column)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      const next = Number(data?.[column] || 0) + amount;
      await db.from('tenant_usage')
        .upsert({ tenant_id: tenantId, [column]: next }, { onConflict: 'tenant_id' });
    } catch (fallbackErr) {
      log.warn(`Could not increment ${column} for ${tenantId}: ${fallbackErr.message}`);
    }
  }
}

/**
 * Convenience: notify the owner when a cap is hit. Inserts a high-priority
 * notification row that the notifications worker delivers via push + SMS +
 * email per tenant preference. Idempotent per (tenant, column, day) so we
 * don't spam during a cap-out window.
 */
async function notifyOwnerCapReached(tenantId, column, used, cap) {
  const label = CAP_LABELS[column] || { unit: column, period: 'this period' };
  const today = new Date().toISOString().slice(0, 10);
  const dedupeKey = `cap_reached:${column}:${today}`;
  try {
    // Check idempotency via activity_log
    const { data: existing } = await db.from('activity_log')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('action', dedupeKey)
      .maybeSingle();
    if (existing) return;
    await db.from('activity_log').insert({
      tenant_id: tenantId,
      agent: 'usage-caps',
      action: dedupeKey,
      details: { column, used, cap },
    });
    await db.from('notifications').insert({
      tenant_id: tenantId,
      type: 'usage_cap_reached',
      priority: 'high',
      title: `You've hit your ${label.unit} cap for ${label.period}`,
      body: `${used} of ${cap} used. New ${label.unit.toLowerCase()} will be queued or skipped until your next cycle. Upgrade to Scale for higher limits.`,
      metadata: { column, used, cap },
      status: 'pending',
    });
  } catch (err) {
    log.warn(`notifyOwnerCapReached failed: ${err.message}`);
  }
}

/**
 * Approximate Claude API spend in cents based on model + tokens.
 * Pricing as of 2025 (in cents per million tokens).
 * Adjust when Anthropic publishes new pricing.
 */
const CLAUDE_PRICING_CENTS_PER_MTOK = {
  // model substring → [input, output] cents/Mtok
  'haiku':  [80, 400],     // $0.80 in / $4 out per Mtok
  'sonnet': [300, 1500],   // $3 in / $15 out per Mtok
  'opus':   [1500, 7500],  // $15 in / $75 out per Mtok
};

function estimateClaudeSpendCents(model, inputTokens, outputTokens) {
  const m = String(model || '').toLowerCase();
  let pricing = CLAUDE_PRICING_CENTS_PER_MTOK.haiku; // default to haiku rates
  for (const key of Object.keys(CLAUDE_PRICING_CENTS_PER_MTOK)) {
    if (m.includes(key)) { pricing = CLAUDE_PRICING_CENTS_PER_MTOK[key]; break; }
  }
  const inCents = (Number(inputTokens || 0) / 1_000_000) * pricing[0];
  const outCents = (Number(outputTokens || 0) / 1_000_000) * pricing[1];
  // Round up to nearest cent so small calls still count
  return Math.max(0, Math.ceil(inCents + outCents));
}

module.exports = {
  TIER_CAPS,
  CAP_LABELS,
  UsageCapExceededError,
  getCap,
  getUsage,
  checkUsageOrThrow,
  incrementUsage,
  notifyOwnerCapReached,
  estimateClaudeSpendCents,
};
