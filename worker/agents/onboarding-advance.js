/**
 * Growth OS — Onboarding Advance Agent
 *
 * Runs daily. For each tenant that has an active onboarding workflow,
 * calls advanceOnboarding() which:
 *   1. Moves the workflow to the next day (if all prior-day steps are done)
 *   2. Auto-runs the "automated" steps for the new day (branding config,
 *      email sends, module activation, etc.)
 *
 * If the tenant has no active workflow, the agent short-circuits.
 *
 * This is what actually makes the Day 0 → Day 7 email sequence progress.
 * Without it, startOnboarding creates a workflow at Day 0 and it never
 * moves.
 */

const { createLogger } = require('../../core/logger');
const { getServiceClient } = require('../../db/client');
const { advanceOnboarding, getOnboardingStatus } = require('../../core/onboarding');

/**
 * @param {Object} tenant - Resolved tenant
 * @param {Object} payload - unused
 */
async function run(tenant, _payload = {}) {
  const log = createLogger('onboarding-advance', tenant.slug);
  const supabase = getServiceClient();

  // Does this tenant have an active onboarding workflow?
  const status = await getOnboardingStatus(supabase, tenant.id);
  if (!status) {
    return { success: true, skipped: true, message: 'No active onboarding workflow' };
  }

  if (status.status === 'completed') {
    return { success: true, skipped: true, message: 'Onboarding already completed' };
  }

  try {
    const result = await advanceOnboarding(supabase, tenant.id);
    log.info(
      `Onboarding advance — current_day=${status.currentDay} result=${JSON.stringify(result)}`
    );
    return {
      success: true,
      previous_day: status.currentDay,
      ...result,
    };
  } catch (err) {
    log.error('advanceOnboarding failed', err);
    return { success: false, error: err.message };
  }
}

module.exports = run;
