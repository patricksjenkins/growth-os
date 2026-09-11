'use strict';

/**
 * Exact-FGA Growth Engine resource policy.
 *
 * These limits govern research and draft supply, never provider delivery.
 * Customer tenants do not consume this policy and keep their deployed paths.
 */

function boundedInteger(value, fallback, { min = 1, max = 100 } = {}) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function draftInventoryDays(value = process.env.FGA_DRAFT_INVENTORY_DAYS) {
  return boundedInteger(value, 2, { min: 1, max: 7 });
}

function draftInventoryTarget(dailyTarget, days = process.env.FGA_DRAFT_INVENTORY_DAYS) {
  const safeTarget = boundedInteger(dailyTarget, 25, { min: 1, max: 1000 });
  return Math.max(1, safeTarget * draftInventoryDays(days));
}

function recoveryLimits(env = process.env) {
  return Object.freeze({
    restart_ready: boundedInteger(env.FGA_RESTART_RECOVERY_DAILY_LIMIT, 25, { min: 1, max: 25 }),
    general: boundedInteger(env.FGA_GENERAL_RECOVERY_DAILY_LIMIT, 10, { min: 1, max: 25 }),
    contact: boundedInteger(env.FGA_CONTACT_RECOVERY_DAILY_LIMIT, 5, { min: 1, max: 25 }),
  });
}

module.exports = {
  boundedInteger,
  draftInventoryDays,
  draftInventoryTarget,
  recoveryLimits,
};
