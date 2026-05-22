/**
 * Growth OS — Marketing Studio Generation Caps
 *
 * Hard guardrails on FGA's corporate Marketing Studio to protect the
 * Sora video generation budget. The platform-owner Marketing Studio is
 * the only caller; tenants never touch this.
 *
 * Caps (decided 2026-05-22):
 *   - Hard rolling 7-day cap:   3 video_promo drafts
 *   - Hard calendar month cap: 12 video_promo drafts
 *
 * Counting strategy: a draft row in content_drafts (tenant_id=FGA,
 * content_type='video_promo') counts once it's been inserted —
 * regardless of whether the underlying Sora/Veo render succeeded or
 * failed. This intentionally penalizes failed renders against quota so
 * the operator can't spam the button hoping to luck into a good output.
 *
 * Today's session API probes were direct API calls that never inserted
 * a content_drafts row, so they correctly don't count.
 */

const FGA_TENANT_ID = process.env.FGA_TENANT_ID || '30566ed6-026a-45e1-9502-029e6219df31';

const WEEKLY_CAP = Number(process.env.MARKETING_VIDEO_WEEKLY_CAP) || 3;
const MONTHLY_CAP = Number(process.env.MARKETING_VIDEO_MONTHLY_CAP) || 12;

class MarketingQuotaError extends Error {
  constructor(reason, retryAfterMs) {
    super(reason);
    this.name = 'MarketingQuotaError';
    this.quotaExceeded = true;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * @param {SupabaseClient} db
 * @returns {Promise<{
 *   allowed: boolean,
 *   weekly_used: number, weekly_max: number,
 *   monthly_used: number, monthly_max: number,
 *   reason: string|null,
 *   retry_after_ms: number|null,
 * }>}
 */
async function checkMarketingVideoQuota(db) {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  // First day of the CURRENT calendar month at 00:00:00 UTC.
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0));

  // We use head:true + count:exact to do a pure COUNT without pulling rows.
  const [weeklyRes, monthlyRes] = await Promise.all([
    db.from('content_drafts')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', FGA_TENANT_ID)
      .eq('content_type', 'video_promo')
      .gte('created_at', sevenDaysAgo.toISOString()),
    db.from('content_drafts')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', FGA_TENANT_ID)
      .eq('content_type', 'video_promo')
      .gte('created_at', monthStart.toISOString()),
  ]);

  if (weeklyRes.error) throw new Error(`Quota check failed (weekly): ${weeklyRes.error.message}`);
  if (monthlyRes.error) throw new Error(`Quota check failed (monthly): ${monthlyRes.error.message}`);

  const weeklyUsed = weeklyRes.count || 0;
  const monthlyUsed = monthlyRes.count || 0;

  let allowed = true;
  let reason = null;
  let retryAfterMs = null;

  if (weeklyUsed >= WEEKLY_CAP) {
    allowed = false;
    reason = 'Weekly generation limit reached to protect corporate ad budget.';
    // Retry-after = the moment the oldest of the 7-day window rolls off.
    // We approximate as "midnight UTC tomorrow"; precise calculation
    // would require pulling the oldest matching row's timestamp.
    const tomorrowUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0));
    retryAfterMs = tomorrowUtc.getTime() - now.getTime();
  } else if (monthlyUsed >= MONTHLY_CAP) {
    allowed = false;
    reason = 'Monthly generation limit reached to protect corporate ad budget.';
    const nextMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0));
    retryAfterMs = nextMonthStart.getTime() - now.getTime();
  }

  return {
    allowed,
    weekly_used: weeklyUsed,
    weekly_max: WEEKLY_CAP,
    monthly_used: monthlyUsed,
    monthly_max: MONTHLY_CAP,
    reason,
    retry_after_ms: retryAfterMs,
  };
}

module.exports = {
  checkMarketingVideoQuota,
  MarketingQuotaError,
  WEEKLY_CAP,
  MONTHLY_CAP,
};
