/**
 * Growth OS — App Asset Pipeline Worker Agent
 *
 * Triggered when a tenant completes the onboarding wizard
 * (POST /api/tenant/onboarding-complete inserts an agent_jobs row
 * with agent_name='app-asset-pipeline').
 *
 * What this agent does (server-side parts of the per-customer app
 * build pipeline — see docs/business/onboarding/app-pipeline.md):
 *   1. Loads the tenant's intake data (brand colors, business name,
 *      vertical, services, delivery_path).
 *   2. Generates a 1024×1024 app icon via Gemini, seeded with brand
 *      cues. Uploads to Supabase Storage under
 *      tenant-assets/<slug>/app-assets/app_icon_1024.png.
 *   3. Generates App Store listing copy (subtitle, promo text,
 *      description, keywords) via Claude. Stores in tenant_config
 *      as app_listing_copy.
 *   4. Runs a server-side 4.2.6 compliance audit (the subset that
 *      doesn't need local filesystem access — basically the listing
 *      copy quality checks). Stores results in tenant_config as
 *      app_audit_report.
 *   5. Flips tenant_config.app_assets_ready = true.
 *   6. Logs a notification for the founder: "Tenant X assets ready —
 *      run scripts/app-pipeline/patch-build-config.js + the
 *      fga-testflight-deploy skill locally to ship the branded app."
 *
 * Why server-side ends here: the next steps (patching app.json,
 * archiving for App Store via Xcode, uploading to TestFlight) require
 * Patrick's local Mac + Xcode + signing keys. Those still run via
 * the CLI scripts in scripts/app-pipeline/ + the fga-testflight-deploy
 * skill.
 */

const { generateImage } = require('../../integrations/gemini');
const { askClaude } = require('../../integrations/claude');
const { createLogger } = require('../../core/logger');
const { getServiceClient } = require('../../db/client');

const STORAGE_BUCKET = 'tenant-assets';

const INDUSTRY_ICON_CUES = {
  hvac: 'a stylized HVAC element (heat pump fan, vent grille, or temperature gauge)',
  plumbing: 'a stylized plumbing element (pipe joint, wrench silhouette, or water drop)',
  electrical: 'a stylized electrical element (lightning bolt, plug, or panel breaker)',
  roofing: 'a stylized roofing element (rooftop silhouette or shingle pattern)',
  tree_service: 'a stylized tree element (silhouette of a mature tree or pine)',
  cleaning: 'a stylized cleaning element (sparkle or microfiber pattern)',
  home_services: 'a stylized tool element (wrench, hammer, or service icon)',
};

async function loadOnboardingContext(db, tenantId) {
  const { data: rows } = await db
    .from('tenant_config').select('key, value').eq('tenant_id', tenantId);
  const config = {};
  for (const r of rows || []) config[r.key] = r.value;
  return config;
}

function buildIconPrompt({ businessName, vertical, primaryColor, accentColor }) {
  const cue = INDUSTRY_ICON_CUES[(vertical || '').toLowerCase()]
    || 'a stylized service-trade element';
  return `Generate a 1024×1024 mobile app icon for "${businessName}".

CRITICAL APPLE REQUIREMENTS:
- Exact dimensions: 1024 × 1024 pixels, square.
- Solid background. NO transparency. NO alpha channel.
- NO rounded corners (iOS applies them automatically).
- NO small text.
- High contrast. Crisp at 60×60 pixels.

DESIGN BRIEF:
- Subject: ${cue}. Simple, iconic, modern.
- Primary color: ${primaryColor || '#132A4A'}.
- Accent color: ${accentColor || '#22C55E'}.
- Style: flat / minimal / vector-like (NOT photorealistic, NOT 3D).

DO NOT include the business name as text — Apple shows the app name beneath the icon automatically.`;
}

function buildListingSystem() {
  return `You write App Store listing copy for branded mobile apps that small service-trade businesses use to run their operations.

Each app is a real B2B custom build — NOT a clone, NOT a template. Copy must feel written for THIS business specifically.

VOICE: Plain-spoken, owner-operator tone. Not corporate. Not techy.

OUTPUT FORMAT: Strict JSON only:
{
  "subtitle": "max 30 chars",
  "promo_text": "max 170 chars",
  "description": "300-3500 chars, plain prose with line breaks",
  "keywords": "max 100 chars, comma-separated, lowercase"
}

CRITICAL RULES:
- Mention the business's actual name in the description 2+ times
- Mention the vertical at least once
- Mention the service area in the description
- Never use "Growth OS", "FGA", "First Gen Automate"
- Description must read like a real B2B app description Apple would approve under 4.2.6
- Keywords: lowercase comma-separated, no spaces after commas`;
}

function buildListingUser({ businessName, vertical, serviceArea, services, ownerName }) {
  return `Write App Store listing copy for the branded mobile app belonging to:

Business: ${businessName}
Owner: ${ownerName || 'the owner'}
Vertical: ${vertical}
Service area: ${serviceArea || 'the local market'}
Services offered: ${services || 'standard ' + vertical + ' services'}

The app is what ${businessName} uses to:
- Manage incoming leads from their website, calls, and ads
- Send fast text-back replies when they can't pick up
- Approve social media posts the system writes from job site photos
- Ask happy customers for Google reviews
- Track their pipeline and accounts

Write the JSON object now.`;
}

function safeJsonParse(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : text).trim();
  const first = candidate.indexOf('{');
  const last = candidate.lastIndexOf('}');
  if (first === -1 || last === -1) throw new Error('No JSON object in Claude response');
  return JSON.parse(candidate.slice(first, last + 1));
}

function clamp(value, max) {
  return String(value || '').trim().slice(0, max);
}

/**
 * Server-side subset of audit-426-compliance.js.
 * Filesystem-dependent checks (icon hash, URL fetches) are skipped —
 * those still run via the local script before TestFlight upload.
 */
function audit426ServerSide({ tenant, listing, deliveryPath }) {
  const results = [];
  const baseSev = deliveryPath === 'managed' ? 'managed' : 'owned';

  // App name vs FGA-internal
  const name = (tenant.name || '').toLowerCase();
  const bannedNames = ['fga', 'first gen automate', 'firstgenautomate'];
  if (name && bannedNames.some((b) => name === b)) {
    results.push({ check: 'app_name', pass: false, msg: `App name "${tenant.name}" matches FGA-internal name` });
  } else {
    results.push({ check: 'app_name', pass: true, msg: `App name: "${tenant.name}"` });
  }

  // Listing description checks
  const desc = (listing.description || '').toLowerCase();
  const nameLower = (tenant.name || '').toLowerCase();
  results.push({
    check: 'name_in_description',
    pass: nameLower ? desc.includes(nameLower) : false,
    msg: nameLower ? `Description mentions "${tenant.name}": ${desc.includes(nameLower)}` : 'No business name to check',
  });
  results.push({
    check: 'vertical_in_description',
    pass: (tenant.vertical || '').toLowerCase().split('_').some((t) => t && desc.includes(t)),
    msg: `Description mentions vertical (${tenant.vertical})`,
  });
  const leakage = ['fga', 'first gen automate', 'firstgenautomate', 'growth os'];
  const found = leakage.find((s) => desc.includes(s));
  results.push({
    check: 'no_internal_brand_leakage',
    pass: !found,
    msg: found ? `Found internal-brand leakage: "${found}"` : 'No internal-brand leakage',
  });

  // Description length (stricter for managed path)
  const minLength = baseSev === 'managed' ? 800 : 500;
  results.push({
    check: 'description_length',
    pass: (listing.description || '').length >= minLength,
    msg: `Description length: ${(listing.description || '').length} chars (min ${minLength} for ${baseSev})`,
  });

  return {
    delivery_path: deliveryPath,
    audited_at: new Date().toISOString(),
    results,
    blockers: results.filter((r) => !r.pass).length,
    server_side_only: true, // local script must run before submission for full check
  };
}

async function uploadIcon(supabase, tenantSlug, buffer) {
  const objectPath = `${tenantSlug}/app-assets/app_icon_1024.png`;
  // V1 hardening (2026-05-24): "best effort" still gets a log line so a
  // mass-failure shows up in Railway. We don't capture to Sentry — the
  // remove() failing on a non-existent file is the normal case.
  try {
    await supabase.storage.from(STORAGE_BUCKET).remove([objectPath]);
  } catch (e) {
    console.warn(`[app-asset-pipeline] icon pre-remove for ${tenantSlug} non-fatal: ${e.message}`);
  }
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(objectPath, buffer, { contentType: 'image/png', upsert: true });
  if (error) throw new Error(`Icon upload failed: ${error.message}`);
  const { data: pub } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(objectPath);
  return pub?.publicUrl || null;
}

async function run(tenant, payload = {}) {
  const log = createLogger('app-asset-pipeline', tenant.slug);
  log.info(`Starting app-asset-pipeline for ${tenant.name} (${tenant.slug})`);

  const db = getServiceClient();
  const config = await loadOnboardingContext(db, tenant.id);

  const businessName = tenant.name || config.business_name || 'Your Business';
  const vertical = tenant.vertical || 'home_services';
  const primaryColor = config.color_primary || '#132A4A';
  const accentColor = config.color_secondary || '#22C55E';
  const serviceArea = config.service_area || '';
  const services = config.key_services || '';
  const ownerName = config.owner_name || '';
  const deliveryPath = payload.delivery_path || config.delivery_path || 'managed';

  // 0. Provision Twilio number if the tenant has any SMS-using modules
  // enabled (speed-to-lead, missed-call, follow-up, review-request,
  // referral-request) and doesn't already have one.
  let twilioPhone = config.twilio_phone_number || null;
  let twilioPhoneSid = config.twilio_phone_sid || null;
  try {
    const { data: modRows } = await db
      .from('tenant_modules').select('module').eq('tenant_id', tenant.id).eq('enabled', true);
    const enabled = new Set((modRows || []).map((r) => r.module));
    const needsSms = ['speed_to_lead', 'missed_call', 'follow_up', 'review_request', 'referral_engine']
      .some((m) => enabled.has(m));
    const needsVoice = enabled.has('voice_receptionist');

    if (!twilioPhone && (needsSms || needsVoice)) {
      log.info('Tenant has SMS/voice modules — provisioning Twilio number…');
      const { provisionLocalNumber } = require('../../integrations/telnyx');
      const areaCode = (config.preferred_area_code || '470');
      const result = await provisionLocalNumber({
        areaCode,
        tenantSlug: tenant.slug,
        friendlyName: `FGA - ${tenant.name}`,
      });
      twilioPhone = result.phone_number;
      twilioPhoneSid = result.sid;
      await db.from('tenant_config').upsert(
        [
          { tenant_id: tenant.id, key: 'twilio_phone_number', value: result.phone_number },
          { tenant_id: tenant.id, key: 'twilio_phone_sid', value: result.sid },
          { tenant_id: tenant.id, key: 'twilio_area_code', value: result.area_code },
          { tenant_id: tenant.id, key: 'twilio_provisioned_at', value: new Date().toISOString() },
        ],
        { onConflict: 'tenant_id,key' },
      );
      log.success(`Twilio number ${result.phone_number} bought + persisted`);
    } else if (twilioPhone) {
      log.info(`Existing Twilio number on tenant: ${twilioPhone}`);
    } else {
      log.info('No SMS or voice modules enabled — skipping Twilio provisioning');
    }

    // Configure SMS + voice webhook URLs whenever the tenant has the
    // matching modules enabled. Re-runnable so toggling voice_receptionist
    // ON later picks up the voice URL on the next pipeline pass.
    if (twilioPhoneSid && process.env.PUBLIC_API_BASE) {
      const { configureNumberWebhooks } = require('../../integrations/telnyx');
      const urls = {};
      if (needsSms) {
        urls.smsUrl = `${process.env.PUBLIC_API_BASE}/webhooks/twilio/sms`;
        urls.statusCallback = `${process.env.PUBLIC_API_BASE}/webhooks/twilio/status`;
      }
      if (needsVoice) {
        // Module 9 — voice receptionist takes the primary voice URL with
        // missed-call text-back as the voice fallback for full belt+braces.
        urls.voiceUrl = `${process.env.PUBLIC_API_BASE}/webhooks/voice-receptionist`;
        urls.voiceFallbackUrl = `${process.env.PUBLIC_API_BASE}/webhooks/twilio/voice`;
      } else if (enabled.has('missed_call')) {
        urls.voiceUrl = `${process.env.PUBLIC_API_BASE}/webhooks/twilio/voice`;
      }
      if (Object.keys(urls).length > 0) {
        try {
          await configureNumberWebhooks(twilioPhoneSid, urls);
          log.success(`Twilio webhooks configured (sms=${!!urls.smsUrl}, voice=${urls.voiceUrl || 'none'})`);
        } catch (cfgErr) {
          log.warn(`Twilio webhook config failed (continuing): ${cfgErr.message}`);
        }
      }
    }
  } catch (twilioErr) {
    // Non-fatal — assets can still ship, Patrick will manually buy if needed
    log.warn(`Twilio provisioning failed (continuing without): ${twilioErr.message}`);
  }

  // 1. Generate the app icon via Gemini
  log.info('Generating app icon via Gemini…');
  const iconPrompt = buildIconPrompt({ businessName, vertical, primaryColor, accentColor });
  const iconBuffer = await generateImage(iconPrompt, { tenantSlug: tenant.slug });
  const iconUrl = await uploadIcon(db, tenant.slug, iconBuffer);
  log.success(`Icon uploaded: ${iconUrl}`);

  // 2. Generate App Store listing copy via Claude
  log.info('Generating listing copy via Claude…');
  const claudeRaw = await askClaude(
    buildListingSystem(),
    buildListingUser({ businessName, vertical, serviceArea, services, ownerName }),
    { maxTokens: 2048, temperature: 0.7, tenantSlug: tenant.slug },
  );
  const parsed = safeJsonParse(claudeRaw);
  const listing = {
    subtitle: clamp(parsed.subtitle, 30),
    promo_text: clamp(parsed.promo_text, 170),
    description: clamp(parsed.description, 4000),
    keywords: clamp(parsed.keywords, 100),
  };
  log.success(`Listing copy ready (${listing.description.length} char description)`);

  // 3. Run the server-side 4.2.6 audit
  const audit = audit426ServerSide({ tenant, listing, deliveryPath });
  log.info(`Audit: ${audit.results.length} checks, ${audit.blockers} blocker(s)`);

  // 4. Persist results to tenant_config so the admin UI + local
  // patch-build-config.js script can pick them up.
  const manifest = {
    tenant_id: tenant.id,
    slug: tenant.slug,
    delivery_path: deliveryPath,
    icon_url: iconUrl,
    generated_at: new Date().toISOString(),
  };

  await db.from('tenant_config').upsert(
    [
      { tenant_id: tenant.id, key: 'app_assets_manifest', value: manifest },
      { tenant_id: tenant.id, key: 'app_icon_url', value: iconUrl },
      { tenant_id: tenant.id, key: 'app_listing_copy', value: listing },
      { tenant_id: tenant.id, key: 'app_audit_report', value: audit },
      { tenant_id: tenant.id, key: 'app_assets_ready', value: true },
      { tenant_id: tenant.id, key: 'app_assets_ready_at', value: new Date().toISOString() },
    ],
    { onConflict: 'tenant_id,key' },
  );

  // 5. Surface a founder-facing reminder in activity log so Patrick
  // knows to run the local build step.
  try {
    await db.from('activity_log').insert({
      tenant_id: tenant.id,
      agent_name: 'app-asset-pipeline',
      action: 'assets_ready_local_build_required',
      metadata: {
        next_step: 'Run scripts/app-pipeline/patch-build-config.js --tenant ' + tenant.slug + ' then fga-testflight-deploy skill',
        delivery_path: deliveryPath,
        audit_blockers: audit.blockers,
      },
    });
  } catch (logErr) {
    // activity_log may not exist in all schemas — non-fatal
    log.warn(`activity_log insert warning: ${logErr.message}`);
  }

  log.success(`Done. Patrick: run scripts/app-pipeline/patch-build-config.js --tenant ${tenant.slug} to build the local TestFlight.`);

  return {
    success: true,
    icon_url: iconUrl,
    listing_description_len: listing.description.length,
    audit_blockers: audit.blockers,
    delivery_path: deliveryPath,
    next_step: 'local_patch_and_testflight',
  };
}

module.exports = run;
