'use strict';

/**
 * Growth OS — the module registry. One list of valid module keys, and it is
 * this one. (The gate that *checks* a key at request time lives in
 * core/modules.js; this file defines what a legal key is in the first place.)
 *
 * WHY THIS EXISTS (2026-07-30)
 * A module key is a string written into `tenant_modules.module` and later
 * compared, verbatim, against a hardcoded string in a cron entry or a
 * `requireModule()` call. Nothing validated the write side. So the admin
 * onboarding form could — and did — enable a module key that no gate in the
 * system can ever match.
 *
 * That is not hypothetical. Live tenant 923A Coins (tier=scale) has a
 * `tenant_modules` row for `ai_voice_receptionist`. Every gate checks
 * `voice_receptionist`. The row is inert: it displays as enabled and does
 * nothing, forever, silently. A typo in a React constant became a paying
 * customer's flagship module never turning on.
 *
 * So `assertValidModules()` is the gate at the write boundary. A key that is
 * not in here cannot be persisted.
 *
 * DELIBERATELY NOT AN ALIAS MAP. It would be easy to normalise
 * `ai_voice_receptionist` -> `voice_receptionist` on read. That would silently
 * switch on the voice receptionist for 923A, which is a live product decision
 * and not one a compatibility shim gets to make (Patrick, 2026-07-30: leave
 * 923A's row as-is). Unknown keys are rejected at write time; existing rows are
 * left exactly as they are.
 *
 * `gates` on each entry is the evidence — the actual cron agents and runtime
 * checks that read this key, taken from worker/scheduler/cron.js and the
 * `requireModule`/`isModuleEnabled` call sites. It is what makes the admin
 * picker honest: you can see what a module actually switches on before you
 * switch it on. If you add a module, add its gates here too, or the picker
 * starts lying again. An empty `gates` array is a real answer and means the
 * key records intent but schedules no work.
 */

/**
 * @typedef {Object} ModuleDef
 * @property {string} key            canonical key, exactly as stored and compared
 * @property {string} label          customer-facing name
 * @property {string} summary        plain-English, no overpromising
 * @property {'core'|'growth'|'scale'|'platform'} category
 * @property {string[]} gates        agents/routes that check this key (evidence)
 * @property {string[]} [needs]      keys this one does nothing useful without
 */

/** @type {ModuleDef[]} */
const MODULES = [
  // --- Lead capture and response -------------------------------------------
  {
    key: 'lead_capture',
    label: 'Lead Capture',
    summary: 'Captures leads from the website, chat, and calls into one list.',
    category: 'core',
    gates: ['cron:clients-manager', 'requireModule'],
  },
  {
    key: 'speed_to_lead',
    label: 'Speed to Lead',
    summary: 'Sweeps hourly for new leads nobody has contacted yet and responds.',
    category: 'core',
    gates: ['cron:speed-to-lead (hourly)', 'requireModule'],
    needs: ['lead_capture'],
  },
  {
    key: 'missed_call',
    label: 'Missed-Call Text Back',
    summary: 'Texts back automatically when a call is missed.',
    category: 'core',
    gates: ['requireModule', 'webhook:voice'],
  },
  {
    key: 'follow_up',
    label: 'Follow-Up Sequences',
    summary: 'Follow-up messages on a schedule until the lead replies.',
    category: 'core',
    gates: [
      'cron:follow-up (Mon/Wed/Fri 11am ET)',
      'cron:past-customer-reengagement (Wed 9am ET)',
      'requireModule',
    ],
    needs: ['lead_capture'],
  },
  {
    key: 'lead_scoring',
    label: 'Lead Scoring',
    summary: 'Ranks leads so the best ones surface first.',
    category: 'growth',
    gates: ['cron:scoring (7:30am ET)', 'cron:meeting-prep', 'requireModule'],
    needs: ['lead_capture'],
  },

  // --- Content -------------------------------------------------------------
  {
    key: 'content_engine',
    label: 'Content Engine',
    summary: 'Writes social posts and generates the images for them.',
    category: 'growth',
    gates: [
      'cron:content-generation (Mon/Thu 11am ET)',
      'cron:content-plan (Sun 6:40pm ET)',
      'cron:image-generation',
      'requireModule',
    ],
    // Content generated but never published is the failure mode here — it is
    // exactly the state 923A is in today (content_engine, no publishing).
    needs: ['approval_queue', 'publishing'],
  },
  {
    key: 'approval_queue',
    label: 'Approval Queue',
    summary: 'Nothing goes out until the owner approves it.',
    category: 'core',
    gates: ['cron:approval-queue (1pm ET — scheduled under publishing)'],
  },
  {
    key: 'publishing',
    label: 'Publishing',
    summary: 'Sends approved posts out to the connected social accounts.',
    category: 'growth',
    gates: ['cron:publisher (9am ET)', 'cron:approval-queue (1pm ET)'],
    needs: ['approval_queue'],
  },

  // --- Reviews and referrals ----------------------------------------------
  {
    key: 'review_request',
    label: 'Review Requests',
    summary: 'Asks for a review after a job is marked done.',
    category: 'growth',
    gates: ['cron:review-request (10am ET)'],
  },
  {
    key: 'referral_engine',
    label: 'Referral Requests',
    summary: 'Asks past customers for referrals after a job.',
    category: 'growth',
    gates: ['cron:referral-request (2pm ET)', 'requireModule'],
  },
  {
    key: 'referral_partners',
    label: 'Referral Partners',
    summary: 'Tracks referral partners and the work they send over.',
    category: 'growth',
    // Honest: this key gates no scheduled work of its own. It records partners
    // for the Command Center; the check-in crons run off partner_outreach.
    gates: [],
    needs: ['partner_outreach'],
  },
  {
    key: 'partner_outreach',
    label: 'Partner Check-Ins',
    summary: 'Keeps in touch with referral partners on a schedule.',
    category: 'growth',
    gates: ['cron:partner-outreach (Mon 9am, Tue/Thu 11am ET)'],
  },

  // --- Owner surfaces ------------------------------------------------------
  {
    key: 'branded_app',
    label: 'Branded Mobile App',
    summary: 'The owner and their crew get the Command Center on their phone.',
    category: 'scale',
    gates: [
      'cron:notifications (hourly)',
      'cron:notification-push (hourly)',
      'cron:client-health (Mon 7am ET)',
      'cron:account-management (Mon 6am ET)',
    ],
  },
  {
    key: 'digest',
    label: 'Daily Digest',
    summary: 'End-of-day summary of what happened, plus a weekly report.',
    category: 'growth',
    gates: ['cron:digest (5pm ET daily)', 'cron:reporting (Fri 5pm ET)'],
  },
  {
    key: 'website',
    label: 'Done-For-You Website',
    summary: 'We build and host the site.',
    category: 'scale',
    // Gated by the build job enqueued at wizard completion, not by a cron key.
    gates: ['job:dfy-website-build (enqueued at wizard completion)'],
  },
  {
    key: 'chat_agent',
    label: 'Website Chat',
    summary: 'Answers questions on the site and captures the lead.',
    category: 'scale',
    gates: [],
    needs: ['lead_capture'],
  },
  {
    key: 'voice_receptionist',
    label: 'AI Voice Receptionist',
    summary: 'Answers the phone when nobody can, and captures the caller.',
    category: 'scale',
    gates: [
      'requireModule (api/routes/voice.js)',
      'webhook:voice-receptionist',
      'agent:app-asset-pipeline',
    ],
  },

  // --- Platform / FGA's own machinery --------------------------------------
  // Granted deliberately, never as part of a tier. `prospecting` in particular
  // must not be switched on for a tenant with no ICP configured.
  {
    key: 'outreach_drip',
    label: 'Outbound Email',
    summary: 'Daily outbound email drafts and reply classification.',
    category: 'platform',
    gates: ['cron:outreach (9am ET daily)', 'cron:reply-classification (hourly)', 'requireModule'],
  },
  {
    key: 'prospecting',
    label: 'Prospecting',
    summary: 'Finds new prospects to reach out to.',
    category: 'platform',
    gates: [
      'cron:prospecting (6am ET)',
      'cron:enrichment',
      'cron:facebook-prospecting (2pm ET)',
      'cron:advertising (Mon 7am ET)',
    ],
    needs: ['outreach_drip'],
  },
  {
    key: 'finance',
    label: 'Finance',
    summary: 'Bookkeeping, billing, tax prep, and threshold alerts.',
    category: 'platform',
    gates: [
      'cron:bookkeeping (Mon 6am ET)', 'cron:billing (1st 6am ET)',
      'cron:tax-prep (quarterly)', 'cron:audit-dry-run (quarterly)',
      'cron:nexus-monitor (1st 7am ET)', 'cron:financial-dashboard (7am ET)',
      'cron:threshold-alerts (8:30am ET)', 'cron:churn-risk-detector (8am ET)',
      'requireModule',
    ],
  },
  {
    key: 'email_chief',
    label: 'Chief of Staff',
    summary: 'Inbox triage and the revenue briefing.',
    category: 'platform',
    gates: ['cron:chief-of-staff (8am/noon/5pm ET daily)'],
  },
];

// ---------------------------------------------------------------------------
// Products — what Patrick actually sells, and the keys each one switches on
// ---------------------------------------------------------------------------

/**
 * A product is one line item on the pricing page. A module key is one string a
 * cron entry compares against. They are NOT the same thing, and conflating
 * them is what breaks tenants.
 *
 * "Content Approval & Scheduling" is a single thing the customer buys, but it
 * needs TWO keys: `approval_queue` (the owner approves) and `publishing` (the
 * approved post actually goes to Buffer). The old admin form only offered
 * `approval_queue`. That is why 923A generates content every week that has
 * never once been published — the publisher cron is gated on a key nobody
 * ever set.
 *
 * So: Patrick picks products. The system enables every key each product needs.
 * Nobody has to remember that scheduling is two keys.
 *
 * Packaging matches CLAUDE.md: 14 standard products, plus the Scale-only AI
 * Voice Receptionist. Growth picks any 7 of the 14; Scale gets all 15.
 */

/**
 * @typedef {Object} ProductDef
 * @property {string} id
 * @property {string} label     exactly as it appears on the pricing page
 * @property {string} summary
 * @property {string[]} keys    module keys this product enables
 * @property {boolean} [scaleOnly]
 * @property {string} [caution] shown in the picker before selection
 */

/** @type {ProductDef[]} */
const PRODUCTS = [
  { id: 'lead_capture', label: 'Lead Capture & CRM',
    summary: 'Every lead from the website, chat, and calls in one list.',
    keys: ['lead_capture'] },

  { id: 'speed_to_lead', label: 'Speed-to-Lead',
    summary: 'New leads get a response fast, even mid-job.',
    keys: ['speed_to_lead'] },

  { id: 'missed_call', label: 'Missed Call Text-Back',
    summary: 'A missed call gets a text back automatically.',
    keys: ['missed_call'] },

  { id: 'follow_up', label: 'Follow-Up Sequences',
    summary: 'Follow-ups keep going until the lead replies.',
    keys: ['follow_up'] },

  { id: 'content_engine', label: 'Content Engine',
    summary: 'Turns job photos into social posts, images included.',
    keys: ['content_engine'] },

  // Two keys, one product. This is the pairing that was broken.
  { id: 'content_approval', label: 'Content Approval & Scheduling',
    summary: 'The owner approves, then approved posts go out on schedule.',
    keys: ['approval_queue', 'publishing'] },

  { id: 'review_request', label: 'Review Requests',
    summary: 'Asks for a review once a job is done.',
    keys: ['review_request'] },

  { id: 'branded_app', label: 'Branded Mobile App + Web Portal',
    summary: 'The owner and crew run the business from their phone.',
    keys: ['branded_app'] },

  { id: 'voice_receptionist', label: 'AI Voice Receptionist', scaleOnly: true,
    summary: 'Answers calls nobody can pick up and captures the caller.',
    keys: ['voice_receptionist'] },

  { id: 'referral_engine', label: 'Referral Engine',
    summary: 'Turns happy customers into referrals.',
    keys: ['referral_engine'] },

  // Also two keys: the record plus the check-in schedule.
  { id: 'referral_partners', label: 'Referral Partner Outreach',
    summary: 'Keeps referral partners engaged on a schedule.',
    keys: ['referral_partners', 'partner_outreach'] },

  { id: 'prospecting', label: 'Prospecting Engine',
    summary: 'Finds new prospects and drafts the outreach.',
    keys: ['prospecting', 'outreach_drip'],
    caution: 'Needs an ICP (target states + industries) configured, or the '
      + 'daily prospecting run fails every morning. Do not enable for a tenant '
      + 'that is not actually prospecting.' },

  { id: 'lead_scoring', label: 'Lead Scoring',
    summary: 'Ranks leads so the best ones surface first.',
    keys: ['lead_scoring'] },

  { id: 'website', label: 'Done-For-You Website',
    summary: 'We build, host, and update the site.',
    keys: ['website'] },

  { id: 'chat_agent', label: 'AI Chat Agent',
    summary: 'Answers questions on the site and captures the lead.',
    keys: ['chat_agent'] },
];

/**
 * Enabled for every tenant regardless of what was picked. The daily digest and
 * weekly report are part of the service, not a line item (CLAUDE.md lists
 * digest reporting under what the system does for every client).
 */
const BASE_KEYS = ['digest'];

const PRODUCT_BY_ID = new Map(PRODUCTS.map((p) => [p.id, p]));

/** Products sellable at a tier. Growth picks 7 of these; Scale gets all 15. */
function productsForTier(tier) {
  return tier === 'scale' ? PRODUCTS.slice() : PRODUCTS.filter((p) => !p.scaleOnly);
}

/**
 * Turn the products Patrick picked into the module keys to persist.
 * Always includes BASE_KEYS.
 *
 * @param {string[]} productIds
 * @returns {string[]} de-duplicated module keys
 * @throws if a product id is unknown
 */
function keysForProducts(productIds) {
  if (!Array.isArray(productIds)) {
    throw new Error('products must be an array of product ids');
  }
  const unknown = productIds.filter((id) => !PRODUCT_BY_ID.has(id));
  if (unknown.length) {
    throw new Error(
      `Unknown product id(s): ${unknown.join(', ')}. `
      + `Valid ids: ${PRODUCTS.map((p) => p.id).join(', ')}`,
    );
  }
  const keys = new Set(BASE_KEYS);
  for (const id of productIds) {
    for (const k of PRODUCT_BY_ID.get(id).keys) keys.add(k);
  }
  return [...keys];
}

const BY_KEY = new Map(MODULES.map((m) => [m.key, m]));
const ALL_KEYS = MODULES.map((m) => m.key);

/**
 * Keys a customer can be sold. Excludes `platform`, which is FGA's own
 * machinery — those are granted deliberately, not by tier.
 */
const SELLABLE_KEYS = MODULES.filter((m) => m.category !== 'platform').map((m) => m.key);

/** Scale can be sold everything sellable. */
const SCALE_KEYS = SELLABLE_KEYS.slice();

/** Growth is everything sellable except the Scale-only flagships. */
const GROWTH_KEYS = MODULES
  .filter((m) => m.category === 'core' || m.category === 'growth')
  .map((m) => m.key);

function getModule(key) {
  return BY_KEY.get(key) || null;
}

function isValidModule(key) {
  return BY_KEY.has(key);
}

/**
 * The write-boundary gate. Throws on anything that is not a real key, so a
 * typo cannot reach `tenant_modules` and sit there inert.
 *
 * @param {string[]} keys
 * @returns {string[]} the same keys, de-duplicated, order preserved
 */
function assertValidModules(keys) {
  if (!Array.isArray(keys)) {
    throw new Error('modules must be an array of module keys');
  }
  const unknown = keys.filter((k) => !BY_KEY.has(k));
  if (unknown.length) {
    throw new Error(
      `Unknown module key(s): ${unknown.join(', ')}. Valid keys: ${ALL_KEYS.join(', ')}`,
    );
  }
  return [...new Set(keys)];
}

/**
 * Modules that were picked but are missing something they need to do anything.
 * Advisory: the caller decides whether to warn or block. This is what catches
 * "content_engine but no publishing", where posts generate forever and never
 * reach an audience.
 *
 * @param {string[]} keys
 * @returns {{key: string, label: string, missing: string[]}[]}
 */
function findMissingDependencies(keys) {
  const picked = new Set(keys);
  const out = [];
  for (const key of picked) {
    const def = BY_KEY.get(key);
    if (!def || !def.needs) continue;
    const missing = def.needs.filter((n) => !picked.has(n));
    if (missing.length) out.push({ key, label: def.label, missing });
  }
  return out;
}

/** Default picks for a tier, used only when the caller specifies nothing. */
function defaultModulesForTier(tier) {
  return tier === 'scale' ? SCALE_KEYS.slice() : GROWTH_KEYS.slice();
}

module.exports = {
  MODULES,
  ALL_KEYS,
  SELLABLE_KEYS,
  SCALE_KEYS,
  GROWTH_KEYS,
  getModule,
  isValidModule,
  assertValidModules,
  findMissingDependencies,
  defaultModulesForTier,
  // Product layer — what Patrick picks in the admin form.
  PRODUCTS,
  BASE_KEYS,
  productsForTier,
  keysForProducts,
};
