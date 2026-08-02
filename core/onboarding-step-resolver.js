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
  // Module 9 — Voice Receptionist setup (Scale-only). Captures the
  // forward-to phone, ring count, voice pick, and emergency keyword list
  // that drive integrations/voice-ai.js at call time.
  { key: 'voice_receptionist', requiresModules: ['voice_receptionist'] },
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
 * What each wizard step collects.
 *
 * Used to skip a step Patrick has already filled in from the Onboarding
 * Center. If he has their logo, the wizard should not ask for it — being
 * asked twice for something you already handed over reads as nobody paying
 * attention.
 */
const STEP_FIELDS = Object.freeze({
  business_basics:     ['business_name', 'owner_name', 'phone', 'service_area'],
  path_choice:         ['delivery_path'],
  apple_details:       ['legal_entity_name', 'duns_number'],
  logo:                ['logo_url'],
  colors:              ['color_primary'],
  photos:              ['photos'],
  voice:               ['brand_voice'],
  services:            ['key_services'],
  voice_receptionist:  ['voice_receptionist_forward_to'],
  gbp:                 ['google_review_url'],
  social:              ['facebook_url', 'instagram_url'],
  customers:           ['customers'],
  dfy_website:         ['dfy_website_prefs'],
  ai_chat:             ['ai_chat_training'],
});

/**
 * Steps that can never be switched off, whatever is configured.
 *
 * `agreement` is the load-bearing one: it captures the customer's acceptance
 * of the service terms, their typed signature, the document versions and their
 * IP. That is consent, and consent cannot be given on someone's behalf by
 * ticking a box in an admin panel. `welcome` and `complete` are the wizard's
 * own bookends and carry no data.
 */
const NON_SKIPPABLE = Object.freeze(['welcome', 'agreement', 'complete']);

/** Steps Patrick is allowed to turn off, for the picker. */
function skippableSteps() {
  return STEP_DEFINITIONS.map((s) => s.key).filter((k) => !NON_SKIPPABLE.includes(k));
}

function hasValue(v) {
  if (v === undefined || v === null || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/**
 * Compute the list of step keys this tenant should see, in order.
 *
 * @param {string[]} enabledModuleKeys - rows from tenant_modules where enabled=true
 * @param {string|null} deliveryPath - 'managed' or 'owned' from tenant_config (null = not chosen yet)
 * @param {Object}   [opts]
 * @param {string[]} [opts.excluded] step keys Patrick switched off for this tenant
 * @param {Object}   [opts.config]   tenant_config, so a step whose data he has
 *                                   already entered is not asked for again
 * @returns {string[]} ordered list of applicable step keys
 */
function resolveApplicableSteps(enabledModuleKeys = [], deliveryPath = null, opts = {}) {
  const moduleSet = new Set(enabledModuleKeys);
  const excluded = new Set(
    (opts.excluded || []).filter((k) => !NON_SKIPPABLE.includes(k)),
  );
  const config = opts.config || null;

  return STEP_DEFINITIONS.filter((step) => {
    // Relevance first — modules and delivery path decide whether the step
    // applies at all.
    let applies;
    if (step.alwaysShown) applies = true;
    else if (step.requiresDeliveryPath) applies = deliveryPath === step.requiresDeliveryPath;
    else if (step.requiresModules) applies = step.requiresModules.some((m) => moduleSet.has(m));
    else applies = false;
    if (!applies) return false;

    // Belt and braces, and deliberately so. This is redundant TODAY, because
    // `excluded` was already filtered above and none of the protected steps
    // declare STEP_FIELDS, so neither path below can reach them. It stops
    // being redundant the moment someone adds `agreement` to STEP_FIELDS —
    // at which point a tenant whose agreement_accepted_at happened to be set
    // would silently stop being asked to accept the terms. Do not remove it
    // because a mutation test says nothing breaks; nothing breaks yet.
    if (NON_SKIPPABLE.includes(step.key)) return true;

    // Switched off deliberately.
    if (excluded.has(step.key)) return false;

    // Or already answered. Every field the step collects has to be present —
    // a half-filled step still needs the customer.
    if (config) {
      const fields = STEP_FIELDS[step.key];
      if (fields && fields.length && fields.every((f) => hasValue(config[f]))) return false;
    }

    return true;
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
  STEP_FIELDS,
  NON_SKIPPABLE,
  skippableSteps,
  resolveApplicableSteps,
  nextStep,
};
