/**
 * Growth OS — Onboarding Intake (v1, 2026-05-14)
 *
 * POST /api/onboarding/intake — accepts the multi-step intake form from
 * /onboarding on the marketing site. The form sends multipart/form-data
 * with general fields (business_name, owner_name, email, address, etc.)
 * plus per-module config fields prefixed `module_cfg__<moduleKey>__<field>`.
 *
 * Lifecycle:
 *   1. Validate the basic identity fields.
 *   2. Look up or create the tenant row (matched by owner_email).
 *   3. Persist the GENERAL intake answers into tenant_config rows.
 *   4. Group the `module_cfg__*` fields into per-module config objects and
 *      save each under tenant_config[`module_<moduleKey>_config`].
 *   5. Toggle the picked modules on in `tenant_modules` (enabled=true).
 *   6. Mark tenant.status = 'onboarding' so the onboarding-advance agent
 *      can move them through the 7-day setup workflow.
 *
 * This route is PUBLIC (mounted before authMiddleware) — the prospect's
 * onboarding token is the `client_id` field they were issued at signup.
 * For v1 we trust the client_id from the form; per-link signing comes later.
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const crypto = require('crypto');
const { db } = require('../../db/client');
const { createLogger } = require('../../core/logger');

const log = createLogger('onboarding-intake');

// V1 hardening (2026-05-24): this endpoint used to match a tenant by
// `owner_email` and overwrite name/status/config/modules — making it a
// trivial tenant-takeover primitive for anyone who knew a customer's
// signup email. We now require a signed `onboarding_token` issued by
// the Stripe checkout webhook (or manual admin onboard) that pins the
// intake submission to one specific tenant_id.
//
// Token shape: base64url(JSON{ tenant_id, email, iat }) + "." + HMAC.
// TTL: 30 days (intake can legitimately be paused + resumed).
const ONBOARDING_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
function getOnboardingSecret() {
  return process.env.ONBOARDING_TOKEN_SECRET
    || process.env.SUPABASE_SERVICE_ROLE_KEY
    || 'INSECURE_FALLBACK_DO_NOT_USE_IN_PROD';
}
function verifyOnboardingToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.', 2);
  if (!body || !sig) return null;
  const expected = crypto
    .createHmac('sha256', getOnboardingSecret())
    .update(body)
    .digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let parsed;
  try { parsed = JSON.parse(Buffer.from(body, 'base64url').toString()); }
  catch { return null; }
  if (!parsed.iat || Date.now() - parsed.iat > ONBOARDING_TOKEN_TTL_MS) return null;
  if (!parsed.tenant_id || !parsed.email) return null;
  return parsed;
}
// States that legitimately permit intake (re)submission. A LIVE active
// tenant cannot be reverted via this endpoint — payment/support flows
// must use the authenticated admin endpoints instead.
const INTAKE_ALLOWED_STATUSES = new Set([
  'onboarding',
  'onboarding_intake_complete',
  'pending_intake',
  'pre_intake',
]);

// Accept multipart but keep files in memory; we're not storing photos yet
// (Phase 2 will route them to Supabase Storage). For now we just acknowledge
// receipt and forward the text fields to tenant_config.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 20 },
});

// Fields that map cleanly to tenant_config one-to-one.
const GENERAL_FIELDS = [
  'business_name',
  'owner_name',
  'phone',
  'business_address',
  'service_area',
  'business_hours',
  'industry',
  'google_review_url',
  'key_services',
  'color_primary',
  'color_secondary',
  'brand_voice',
  'facebook_url',
  'instagram_url',
  'special_instructions',
  // App delivery path choice. 'managed' = FGA's Apple Developer account
  // (Quick Start). 'owned' = customer's own developer account (Full
  // Ownership). See docs/business/onboarding/path-choice.md.
  'delivery_path',
  // Path B (owned) extras — captured only when delivery_path='owned'.
  // Used during the Day 1 Apple Developer enrollment call.
  'legal_entity_name',
  'duns_number',
];

/**
 * Parse module_cfg__<moduleKey>__<fieldName> form fields into a
 * { [moduleKey]: { [fieldName]: value } } object. Repeated fields (checkbox
 * groups submit the same name N times) collapse into an array.
 */
function groupModuleConfig(formBody) {
  const grouped = {};
  for (const [rawKey, rawVal] of Object.entries(formBody || {})) {
    const match = rawKey.match(/^module_cfg__([a-z0-9_]+)__(.+)$/i);
    if (!match) continue;
    const [, moduleKey, fieldName] = match;
    if (!grouped[moduleKey]) grouped[moduleKey] = {};
    // multer/express form parsing returns arrays for repeated fields
    grouped[moduleKey][fieldName] = Array.isArray(rawVal) ? rawVal : rawVal;
  }
  return grouped;
}

/**
 * Find selected modules from form fields named `module_<key>` = 'enabled'.
 */
function pickSelectedModules(formBody) {
  const selected = [];
  for (const [rawKey, rawVal] of Object.entries(formBody || {})) {
    const m = rawKey.match(/^module_([a-z0-9_]+)$/i);
    if (m && rawVal === 'enabled') {
      selected.push(m[1]);
    }
  }
  return selected;
}

router.post('/intake', upload.any(), async (req, res) => {
  try {
    const body = req.body || {};
    const email = String(body.email || '').trim().toLowerCase();
    const businessName = String(body.business_name || '').trim();
    const ownerName = String(body.owner_name || '').trim();
    const tier = String(body.tier || 'growth').toLowerCase() === 'scale' ? 'scale' : 'growth';
    const clientId = String(body.client_id || '').trim() || null;
    const onboardingToken = String(body.onboarding_token || body.client_id || '').trim();

    if (!email || !businessName || !ownerName) {
      return res.status(400).json({ success: false, error: 'business_name, owner_name, and email are required' });
    }

    // V1 hardening (2026-05-24): require a signed onboarding token that
    // names the specific tenant_id. Stripe checkout webhook (and the
    // manual admin /api/admin/onboard-tenant endpoint) issues one with
    // the welcome email's magic link. Without this, any anonymous POST
    // could overwrite a customer's tenant by knowing their signup email.
    const claims = verifyOnboardingToken(onboardingToken);
    if (!claims) {
      return res.status(401).json({
        success: false,
        error: 'Invalid or expired onboarding link. Please use the magic link from your welcome email or contact support.',
      });
    }
    if (claims.email.toLowerCase() !== email) {
      return res.status(401).json({
        success: false,
        error: 'Email on the form does not match the onboarding link recipient.',
      });
    }

    // Resolve the tenant from the SIGNED token, not from a body-supplied
    // email. This eliminates the email-spoofing path entirely.
    let tenant;
    const { data: existing } = await db
      .from('tenants')
      .select('*')
      .eq('id', claims.tenant_id)
      .maybeSingle();

    if (existing) {
      // Refuse to clobber a live tenant. Only tenants still in the
      // intake-window states can resubmit the wizard.
      if (!INTAKE_ALLOWED_STATUSES.has(existing.status)) {
        return res.status(409).json({
          success: false,
          error: `Onboarding intake is closed for this tenant (current status: ${existing.status}). Use the in-app settings to edit your config.`,
        });
      }
      tenant = existing;
      await db.from('tenants')
        .update({ name: businessName, status: 'onboarding_intake_complete', updated_at: new Date().toISOString() })
        .eq('id', tenant.id);
    } else {
      // Generate a kebab-case slug from the business name. Add a short
      // suffix to avoid collisions; the slug only matters for internal
      // routing, not branding.
      const slugBase = businessName.toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);
      const slug = `${slugBase}-${Math.random().toString(36).slice(2, 7)}`;

      const { data: created, error: createErr } = await db
        .from('tenants')
        .insert({
          name: businessName,
          slug,
          owner_email: email,
          status: 'onboarding',
          vertical: 'home_services',
          is_demo: false,
        })
        .select()
        .single();
      if (createErr) throw createErr;
      tenant = created;
    }

    // Persist the general fields as one row per key in tenant_config.
    const upserts = [];
    for (const key of GENERAL_FIELDS) {
      if (body[key] !== undefined && body[key] !== null && body[key] !== '') {
        upserts.push({ tenant_id: tenant.id, key, value: String(body[key]).slice(0, 8000) });
      }
    }
    upserts.push({ tenant_id: tenant.id, key: 'tier', value: tier });
    if (ownerName) {
      upserts.push({ tenant_id: tenant.id, key: 'owner_name', value: ownerName });
    }

    // Per-module config — saved as JSON under module_<key>_config so each
    // agent can read its own settings cleanly. We store the JSON as text
    // because tenant_config.value is a text column.
    const moduleConfig = groupModuleConfig(body);
    for (const [moduleKey, fields] of Object.entries(moduleConfig)) {
      upserts.push({
        tenant_id: tenant.id,
        key: `module_${moduleKey}_config`,
        value: JSON.stringify(fields),
      });
    }

    // Module selection (which 7-or-all modules they picked).
    const selectedModules = pickSelectedModules(body);
    if (selectedModules.length) {
      upserts.push({
        tenant_id: tenant.id,
        key: 'modules_selected',
        value: JSON.stringify(selectedModules),
      });
    }

    if (upserts.length) {
      const { error: cfgErr } = await db
        .from('tenant_config')
        .upsert(upserts, { onConflict: 'tenant_id,key' });
      if (cfgErr) log.warn(`tenant_config upsert warning: ${cfgErr.message}`);
    }

    // Toggle modules on in tenant_modules. Scale gets all 16; Growth gets
    // exactly the picked set. Either way, we set the picked modules to
    // enabled=true via upsert (idempotent).
    const modulesToEnable = tier === 'scale'
      ? [
          'lead_capture','speed_to_lead','missed_call','follow_up','content_engine',
          'approval_queue','review_request','branded_app','social_engagement',
          'referral_engine','referral_partners','prospecting',
          'lead_scoring','website','chat_agent',
        ]
      : selectedModules;

    if (modulesToEnable.length) {
      const moduleUpserts = modulesToEnable.map((m) => ({
        tenant_id: tenant.id,
        module: m,
        enabled: true,
      }));
      const { error: modErr } = await db
        .from('tenant_modules')
        .upsert(moduleUpserts, { onConflict: 'tenant_id,module' });
      if (modErr) log.warn(`tenant_modules upsert warning: ${modErr.message}`);
    }

    log.info(`Onboarding intake captured for ${businessName} <${email}> — tenant ${tenant.id.slice(0, 8)}, ${modulesToEnable.length} modules, ${Object.keys(moduleConfig).length} module configs`);

    res.json({
      success: true,
      tenant_id: tenant.id,
      tenant_slug: tenant.slug,
      modules_enabled: modulesToEnable.length,
      module_configs_captured: Object.keys(moduleConfig).length,
      client_id_echo: clientId,
    });
  } catch (err) {
    log.error(`Intake submit failed: ${err.message}`);
    res.status(500).json({ success: false, error: 'Onboarding intake failed. Please try again.' });
  }
});

module.exports = router;
