/**
 * Growth OS — DFY Website Build Worker Agent
 *
 * Triggered when a tenant with the "website" module completes the
 * onboarding wizard (or when a rebuild is requested via PATCH
 * /api/tenant/website). The agent_jobs row has
 * agent_name='dfy-website-build'.
 *
 * What this agent does:
 *   1. Loads tenant intake data (business name, services, brand
 *      colors, tagline, about blurb, testimonials, photos, contact).
 *   2. Calls Claude to generate polished website copy (hero, about,
 *      service descriptions, CTA, meta descriptions).
 *   3. Renders the EJS template (service-business-v1) into static
 *      HTML with the tenant's branding as CSS custom properties.
 *   4. Optionally registers a domain via Cloudflare Registrar.
 *   5. Creates a Cloudflare Pages project and deploys the static
 *      HTML bundle via Direct Upload.
 *   6. Binds the custom domain (or uses the Pages default URL).
 *   7. Updates tenant_websites row with status='live', domain, and
 *      published_at.
 *
 * Env vars required: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID
 */

const path = require('path');
const fs = require('fs');
const ejs = require('ejs');
const { askClaudeJSON } = require('../../integrations/claude');
const {
  createPagesProject,
  deployToPages,
  addCustomDomain,
  addZone,
  findZone,
  registerDomain,
} = require('../../integrations/cloudflare');
const { createLogger } = require('../../core/logger');
const { getServiceClient } = require('../../db/client');

const TEMPLATE_DIR = path.join(__dirname, '..', '..', 'templates', 'websites', 'service-business-v1');
const API_BASE_URL = process.env.API_BASE_URL || 'https://api.firstgenautomate.com';

// ─── Helpers ─────────────────────────────────────────────────────────

async function loadTenantContext(db, tenantId) {
  const [configRes, modulesRes, websiteRes, tenantRes] = await Promise.all([
    db.from('tenant_config').select('key, value').eq('tenant_id', tenantId),
    db.from('tenant_modules').select('module, enabled, config').eq('tenant_id', tenantId),
    db.from('tenant_websites').select('*').eq('tenant_id', tenantId).maybeSingle(),
    db.from('tenants').select('*').eq('id', tenantId).single(),
  ]);

  const config = {};
  for (const r of configRes.data || []) config[r.key] = r.value;

  const modules = {};
  for (const r of modulesRes.data || []) modules[r.module] = { enabled: r.enabled, ...r.config };

  return {
    config,
    modules,
    website: websiteRes.data,
    tenant: tenantRes.data,
  };
}

function formatPhone(phone) {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  if (digits.length === 11 && digits[0] === '1') {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return phone;
}

const VERTICAL_LABELS = {
  tree_service: 'Tree Service',
  plumbing: 'Plumbing',
  hvac: 'HVAC',
  electrical: 'Electrical',
  roofing: 'Roofing',
  cleaning: 'Cleaning',
  landscaping: 'Landscaping',
  pest_control: 'Pest Control',
  home_services: 'Home Services',
  benefits_consulting: 'Benefits Consulting',
  auto_repair: 'Auto Repair',
  pet_grooming: 'Pet Grooming',
};

const VERTICAL_EMOJIS = {
  tree_service: '&#127794;',
  plumbing: '&#128679;',
  hvac: '&#10052;',
  electrical: '&#9889;',
  roofing: '&#127968;',
  cleaning: '&#10024;',
  landscaping: '&#127793;',
  home_services: '&#128736;',
};

// ─── Claude Copy Generation ──────────────────────────────────────────

function buildCopySystemPrompt() {
  return `You write professional website copy for small service businesses.
Your copy must be plain-spoken, confident, and direct — written for
business owners and their customers, not marketers or tech people.

OUTPUT FORMAT: Strict JSON only:
{
  "hero_headline": "8 words max, punchy, speaks to customer's need",
  "hero_subheadline": "1-2 sentences, what the business does and why them",
  "services_intro": "1 sentence introducing services section",
  "service_descriptions": [
    { "name": "service name", "description": "2-3 sentence description" }
  ],
  "about_text": "2-3 paragraphs about the business, separated by newlines",
  "cta_banner_headline": "5-8 words, action-oriented",
  "cta_banner_subtext": "1 sentence supporting the CTA",
  "meta_description": "155 chars max, SEO-friendly page description"
}

RULES:
- Never use jargon, buzzwords, or filler
- Never say "AI-powered", "cutting-edge", "revolutionary"
- Write like you're talking to a neighbor who needs the service
- Mention the service area when available
- Keep it real — these are small local businesses, not Fortune 500`;
}

function buildCopyUserPrompt(ctx) {
  const { businessName, vertical, serviceArea, services, tagline, aboutBlurb, testimonials, ownerName } = ctx;
  return `Write website copy for:

Business: ${businessName}
Industry: ${vertical}
Service area: ${serviceArea || 'local area'}
Owner: ${ownerName || 'the owner'}
Tagline (customer provided): ${tagline || 'none — write one'}
About (customer provided): ${aboutBlurb || 'none — write a professional about section'}

Services offered:
${(services || []).map((s) => `- ${typeof s === 'string' ? s : s.name}`).join('\n') || '- General ' + vertical + ' services'}

${testimonials && testimonials.length ? 'Customer testimonials exist — weave credibility into the about section.' : ''}

Write the JSON now.`;
}

// ─── Template Rendering ──────────────────────────────────────────────

function renderSite(templateData) {
  const layoutPath = path.join(TEMPLATE_DIR, 'layout.ejs');
  const indexPath = path.join(TEMPLATE_DIR, 'index.ejs');

  const layoutTemplate = fs.readFileSync(layoutPath, 'utf-8');
  const indexTemplate = fs.readFileSync(indexPath, 'utf-8');

  const body = ejs.render(indexTemplate, templateData);
  const html = ejs.render(layoutTemplate, { ...templateData, body });

  return html;
}

// ─── Cloudflare Deploy ───────────────────────────────────────────────

async function buildFormData(html, tenantSlug) {
  // Cloudflare Pages Direct Upload expects multipart/form-data with files.
  // We build it using the standard FormData interface (Node 18+).
  const formData = new FormData();
  formData.append('index.html', new Blob([html], { type: 'text/html' }), 'index.html');
  return formData;
}

async function ensurePagesProject(projectName, log) {
  try {
    const project = await createPagesProject(projectName);
    return project;
  } catch (err) {
    // Project may already exist (idempotent)
    if (err.message.includes('already exists') || err.message.includes('already being used')) {
      log.info(`Pages project ${projectName} already exists — reusing`);
      return { name: projectName };
    }
    throw err;
  }
}

async function setupDomain(domain, projectName, shouldRegister, log) {
  if (!domain) return null;

  // If we need to register the domain through CF Registrar
  if (shouldRegister) {
    try {
      log.info(`Registering domain ${domain} via Cloudflare Registrar...`);
      await registerDomain(domain);
      log.success(`Domain ${domain} registered`);
    } catch (err) {
      if (!err.message.includes('already registered')) {
        log.warn(`Domain registration failed: ${err.message} — continuing with zone setup`);
      }
    }
  }

  // Ensure zone exists (either from registration or manual add)
  let zone = await findZone(domain);
  if (!zone) {
    log.info(`Adding zone for ${domain}...`);
    zone = await addZone(domain);
  }

  // Bind domain to Pages project
  // Bind both apex and www
  try {
    await addCustomDomain(projectName, domain);
    log.success(`Bound ${domain} to Pages project`);
  } catch (err) {
    if (!err.message.includes('already exists')) {
      log.warn(`Domain bind failed for ${domain}: ${err.message}`);
    }
  }
  try {
    await addCustomDomain(projectName, `www.${domain}`);
  } catch {
    // www binding is best-effort
  }

  return zone;
}

// ─── Main Agent ──────────────────────────────────────────────────────

async function run(tenant, payload = {}) {
  const log = createLogger('dfy-website-build', tenant.slug);
  log.info(`Starting DFY website build for ${tenant.name} (${tenant.slug})`);

  const db = getServiceClient();
  const ctx = await loadTenantContext(db, tenant.id);
  const config = ctx.config;
  const chatEnabled = ctx.modules.chat_agent?.enabled === true;

  const businessName = tenant.name || config.business_name || 'Your Business';
  const vertical = tenant.vertical || 'home_services';
  const verticalLabel = VERTICAL_LABELS[vertical] || vertical.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const primaryColor = config.color_primary || '#132A4A';
  const secondaryColor = config.color_secondary || '#1e3a5f';
  const accentColor = config.color_accent || '#22C55E';
  const logoUrl = config.logo_url || ctx.tenant.branding?.logo_url || '';
  const tagline = config.module_website_tagline || config.tagline || '';
  const aboutBlurb = config.module_website_about_blurb || '';
  const rawTestimonials = config.module_website_testimonials || '';
  const ctaPreference = config.module_website_cta_preference || 'Call Now';
  const domainChoice = config.module_website_domain_choice || payload.domain_choice || 'subdomain';
  const customerDomain = config.module_website_domain_name || payload.domain || null;
  const serviceArea = config.service_area || '';
  const ownerName = config.owner_name || '';
  const hours = config.business_hours || '';
  // No fallback to the retired carrier's config key. FGA still held one,
  // pointing at a number given up in June 2026 — and this value is printed on
  // the customer's website.
  const phone = config.business_phone || config.telnyx_phone_number || '';
  const email = config.business_email || tenant.owner_email || '';

  // Parse services from config
  let services = config.key_services || config.services || [];
  if (typeof services === 'string') {
    services = services.split(',').map((s) => ({ name: s.trim() }));
  }

  // Parse testimonials from intake textarea
  let testimonials = [];
  if (rawTestimonials) {
    const lines = rawTestimonials.split('\n').filter((l) => l.trim());
    for (let i = 0; i < lines.length; i += 2) {
      const text = lines[i]?.replace(/^["']|["']$/g, '').trim();
      const name = lines[i + 1]?.replace(/^[-–—]\s*/, '').trim() || 'Happy Customer';
      if (text) testimonials.push({ text, name });
    }
  }

  // Parse photos from intake
  const photos = config.seed_photos || config.photos || [];
  const heroPhoto = (Array.isArray(photos) ? photos[0] : null) || '';
  const aboutPhoto = (Array.isArray(photos) ? photos[1] : null) || '';

  // ── Step 1: Generate copy via Claude ────────────────────────────
  log.info('Generating website copy via Claude...');
  const generatedCopy = await askClaudeJSON(
    buildCopySystemPrompt(),
    buildCopyUserPrompt({
      businessName, vertical: verticalLabel, serviceArea, services, tagline, aboutBlurb, testimonials, ownerName,
    }),
    { maxTokens: 2048, tenantSlug: tenant.slug },
  );
  log.success('Copy generated');

  // Merge generated service descriptions with intake service names
  const mergedServices = (generatedCopy.service_descriptions || []).map((s) => ({
    name: s.name,
    description: s.description,
    icon: null,
  }));
  // If Claude returned fewer services than intake, keep extras with no description
  if (services.length > mergedServices.length) {
    for (let i = mergedServices.length; i < services.length; i++) {
      const svc = typeof services[i] === 'string' ? { name: services[i] } : services[i];
      mergedServices.push({ name: svc.name, description: svc.description || '', icon: null });
    }
  }

  // ── Step 2: Determine domain + project name ─────────────────────
  const projectName = `gos-${tenant.slug}`.slice(0, 63).replace(/[^a-z0-9-]/g, '');
  let domain = null;
  let shouldRegister = false;

  if (domainChoice === 'own' && customerDomain) {
    domain = customerDomain.replace(/^(https?:\/\/)?(www\.)?/, '').replace(/\/.*/, '');
  } else if (domainChoice === 'register' || (domainChoice !== 'own' && payload.register_domain)) {
    // Auto-register: use slug-based domain suggestion or provided one
    domain = payload.domain || `${tenant.slug.replace(/-/g, '')}.com`;
    shouldRegister = true;
  }
  // If neither: tenant gets the Pages default URL (projectname.pages.dev)

  // ── Step 3: Render the site ─────────────────────────────────────
  log.info('Rendering site HTML...');
  const templateData = {
    // Meta
    pageTitle: businessName,
    metaDescription: generatedCopy.meta_description || `${businessName} — ${verticalLabel} in ${serviceArea || 'your area'}`,
    domain: domain || `${projectName}.pages.dev`,
    // Branding
    businessName,
    logoUrl,
    primaryColor,
    secondaryColor,
    accentColor,
    // Hero
    heroHeadline: generatedCopy.hero_headline || tagline || `${verticalLabel} You Can Count On`,
    heroSubheadline: generatedCopy.hero_subheadline || `Professional ${verticalLabel.toLowerCase()} services in ${serviceArea || 'your area'}.`,
    heroPhoto,
    verticalLabel,
    verticalEmoji: VERTICAL_EMOJIS[vertical] || '&#128736;',
    serviceArea,
    // Services
    services: mergedServices,
    servicesIntro: generatedCopy.services_intro || `Here's what ${businessName} can do for you.`,
    // About
    aboutText: generatedCopy.about_text || aboutBlurb || `${businessName} is a trusted ${verticalLabel.toLowerCase()} provider serving ${serviceArea || 'the local community'}.`,
    aboutPhoto,
    // Testimonials
    testimonials,
    // CTA
    ctaText: ctaPreference,
    ctaPhone: phone,
    ctaPhoneDisplay: formatPhone(phone),
    ctaEmail: email,
    ctaBannerHeadline: generatedCopy.cta_banner_headline || `Ready to Get Started?`,
    ctaBannerSubtext: generatedCopy.cta_banner_subtext || `Give us a call today. We'd love to help.`,
    // Contact
    hours,
    // System
    chatEnabled,
    tenantId: tenant.id,
    apiBaseUrl: API_BASE_URL,
    // V1 hardening (2026-05-24): mint the HMAC widget token at build
    // time and embed it in the <script> tag. Without this the chat
    // endpoint returns 403 invalid_widget_token for any non-FGA
    // tenant_id. The token only changes when CHAT_WIDGET_SECRET is
    // rotated — re-run the website-build agent to re-issue.
    chatWidgetToken: chatEnabled
      ? require('../../core/chat-widget-token').signWidgetToken(tenant.id)
      : null,
  };

  const html = renderSite(templateData);
  log.success(`Site rendered: ${html.length} bytes`);

  // ── Step 4: Deploy to Cloudflare Pages ──────────────────────────
  log.info('Deploying to Cloudflare Pages...');
  await ensurePagesProject(projectName, log);
  const formData = await buildFormData(html, tenant.slug);
  const deployment = await deployToPages(projectName, formData);
  const liveUrl = domain ? `https://${domain}` : deployment.url;
  log.success(`Deployed: ${liveUrl}`);

  // ── Step 5: Set up domain (if applicable) ───────────────────────
  let zone = null;
  if (domain) {
    zone = await setupDomain(domain, projectName, shouldRegister, log);
  }

  // ── Step 6: Persist to database ─────────────────────────────────
  const websiteRow = {
    tenant_id: tenant.id,
    domain: domain || null,
    subdomain: `${projectName}.pages.dev`,
    cf_project_name: projectName,
    cf_zone_id: zone?.id || null,
    cf_domain_registered: shouldRegister,
    template: 'service-business-v1',
    page_data: {
      ...templateData,
      generated_copy: generatedCopy,
    },
    theme: { primaryColor, secondaryColor, accentColor },
    status: 'live',
    build_error: null,
    published_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  if (ctx.website) {
    // Update existing row
    await db.from('tenant_websites')
      .update(websiteRow)
      .eq('tenant_id', tenant.id);
  } else {
    // Insert new row
    await db.from('tenant_websites').insert(websiteRow);
  }

  // Also persist the live URL to tenant_config for easy access
  await db.from('tenant_config').upsert(
    [
      { tenant_id: tenant.id, key: 'website_url', value: liveUrl },
      { tenant_id: tenant.id, key: 'website_status', value: 'live' },
      { tenant_id: tenant.id, key: 'website_built_at', value: new Date().toISOString() },
    ],
    { onConflict: 'tenant_id,key' },
  );

  // Activity log for founder
  try {
    await db.from('activity_log').insert({
      tenant_id: tenant.id,
      agent_name: 'dfy-website-build',
      action: 'website_deployed',
      metadata: {
        url: liveUrl,
        domain: domain || null,
        pages_project: projectName,
        chat_enabled: chatEnabled,
      },
    });
  } catch (logErr) {
    log.warn(`activity_log insert warning: ${logErr.message}`);
  }

  log.success(`DFY website live at ${liveUrl}`);
  return {
    success: true,
    url: liveUrl,
    domain: domain || null,
    pages_project: projectName,
    chat_enabled: chatEnabled,
  };
}

module.exports = run;
