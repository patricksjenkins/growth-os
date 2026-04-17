/**
 * Growth OS — Vertical Config Registry
 *
 * Every tenant belongs to a vertical. A vertical defines:
 *   - labels: UI copy that changes per industry (Customers vs Clients vs Patients,
 *             Jobs vs Listings vs Appointments, etc.)
 *   - palette: default brand colors tenants inherit before they upload a logo
 *   - pipeline_stages: default deal stages for that industry
 *   - revenue_model: one-time (service pros), recurring (SaaS), commission (real estate)
 *
 * The mobile app reads a tenant's vertical config on login and renders labels + theme
 * from it. Per-tenant branding (logo, custom colors) overrides the vertical defaults.
 *
 * See MIGRATION 015 for the schema additions (tenants.branding, tenants.is_demo).
 */

const HOME_SERVICES = require('./home-services');
const REAL_ESTATE = require('./real-estate');
const RETAIL = require('./retail');

const VERTICALS = {
  [HOME_SERVICES.slug]: HOME_SERVICES,
  [REAL_ESTATE.slug]: REAL_ESTATE,
  [RETAIL.slug]: RETAIL,
  // Legacy slugs map to the closest equivalent so existing tenants keep working.
  tree_service: HOME_SERVICES,
  benefits_consulting: HOME_SERVICES,
};

// Neutral defaults applied when a tenant's vertical is unknown.
const DEFAULTS = {
  slug: 'default',
  name: 'Service Business',
  labels: {
    customer: 'Customer',
    customers: 'Customers',
    lead: 'Lead',
    leads: 'Leads',
    job: 'Job',
    jobs: 'Jobs',
    revenue: 'Revenue',
    pipeline: 'Pipeline',
  },
  palette: {
    primary: '#132A4A',
    secondary: '#22C55E',
    accent: '#FFA726',
  },
  pipeline_stages: ['new_lead', 'contacted', 'estimate_given', 'won', 'lost'],
  revenue_model: 'one_time',
};

/**
 * Resolve a vertical config by slug. Returns DEFAULTS if the slug is unknown.
 * @param {string} slug - e.g. 'home_services', 'real_estate', 'retail', 'tree_service'
 * @returns {object} vertical config
 */
function getVertical(slug) {
  if (!slug) return DEFAULTS;
  return VERTICALS[slug] || DEFAULTS;
}

/**
 * Merge a tenant's per-tenant branding overrides on top of the vertical palette.
 * tenant.branding is a JSONB column: { primary_color, secondary_color, accent_color, logo_url, business_name }
 *
 * @param {object} tenant - tenant row with optional .branding and .vertical
 * @returns {{labels: object, palette: object, logo_url: string|null, business_name: string, vertical: object}}
 */
function resolveTenantTheme(tenant) {
  const vertical = getVertical(tenant?.vertical);
  const b = tenant?.branding || {};
  return {
    vertical,
    labels: vertical.labels,
    palette: {
      primary: b.primary_color || vertical.palette.primary,
      secondary: b.secondary_color || vertical.palette.secondary,
      accent: b.accent_color || vertical.palette.accent,
    },
    logo_url: b.logo_url || null,
    business_name: b.business_name || tenant?.name || vertical.name,
    pipeline_stages: vertical.pipeline_stages,
    revenue_model: vertical.revenue_model,
  };
}

module.exports = {
  VERTICALS,
  DEFAULTS,
  getVertical,
  resolveTenantTheme,
};
