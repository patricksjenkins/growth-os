/**
 * Growth OS — Onboarding Wizard Step Resolver
 *
 * Decides which wizard steps a tenant sees, based on the modules they
 * picked at sale time. Same answer drives both the mobile and web
 * onboarding wizards — there is one source of truth here, not two.
 *
 * Step list contract:
 *   - `alwaysShown: true` ⇒ step appears for every tenant
 *   - `requiresModules: [keys]` ⇒ shown if tenant has any of those modules
 *   - `requiresDeliveryPath: 'owned'` ⇒ shown only when the tenant has
 *     chosen Path B (their own Apple Developer account)
 *
 * Adding a new step means adding ONE entry here. Both UIs read it
 * through GET /api/tenant/onboarding-state.
 *
 * See docs/business/onboarding/onboarding-wizard-flow.md for context.
 */

const STEP_DEFINITIONS = [
  { key: 'welcome',        alwaysShown: true },
  { key: 'business_basics', alwaysShown: true },
  { key: 'path_choice',    alwaysShown: true },
  { key: 'apple_details',  requiresDeliveryPath: 'owned' },
  { key: 'logo',           alwaysShown: true },
  { key: 'colors',         alwaysShown: true },
  { key: 'photos',         requiresModules: ['content_engine', 'approval_queue'] },
  { key: 'voice',          requiresModules: ['content_engine', 'approval_queue', 'follow_up', 'referral_partners'] },
  { key: 'services',       alwaysShown: true },
  { key: 'gbp',            requiresModules: ['review_request'] },
  { key: 'social',         requiresModules: ['approval_queue', 'social_engagement'] },
  { key: 'customers',      requiresModules: ['referral_engine', 'follow_up', 'review_request'] },
  { key: 'dfy_website',    requiresModules: ['website'] },
  { key: 'ai_chat',        requiresModules: ['chat_agent'] },
  // Legal agreement acceptance — always shown, second-to-last step so
  // the customer reviews everything in context before the success card.
  // Captures: agreement_accepted_at, agreement_signature (typed name),
  // agreement_versions (which doc versions they accepted),
  // agreement_acceptance_ip (from request).
  { key: 'agreement',      alwaysShown: true },
  { key: 'complete',       alwaysShown: true },
];

/**
 * Compute the list of step keys this tenant should see, in order.
 *
 * @param {string[]} enabledModuleKeys - rows from tenant_modules where enabled=true
 * @param {string|null} deliveryPath - 'managed' or 'owned' from tenant_config (null = not chosen yet)
 * @returns {string[]} ordered list of applicable step keys
 */
function resolveApplicableSteps(enabledModuleKeys = [], deliveryPath = null) {
  const moduleSet = new Set(enabledModuleKeys);
  return STEP_DEFINITIONS.filter((step) => {
    if (step.alwaysShown) return true;
    if (step.requiresDeliveryPath) {
      return deliveryPath === step.requiresDeliveryPath;
    }
    if (step.requiresModules) {
      return step.requiresModules.some((m) => moduleSet.has(m));
    }
    return false;
  }).map((s) => s.key);
}

/**
 * Given the applicable steps and the list of completed step keys,
 * return the key of the next step to show. Returns null when complete.
 */
function nextStep(applicableSteps, completedSteps = []) {
  const done = new Set(completedSteps);
  for (const key of applicableSteps) {
    if (!done.has(key)) return key;
  }
  return null;
}

module.exports = {
  STEP_DEFINITIONS,
  resolveApplicableSteps,
  nextStep,
};
