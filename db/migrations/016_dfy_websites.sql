-- Migration 016: Done-For-You Website module
--
-- Stores per-tenant website configuration, generated content, and deploy
-- state for the DFY Website module (module key: "website").
--
-- The worker agent (dfy-website-build) reads page_data + theme, generates
-- static HTML via Claude + EJS templates, deploys to Cloudflare Pages,
-- and tracks the deploy lifecycle here.
--
-- page_data shape (populated from onboarding wizard + Claude generation):
-- {
--   "hero_headline": "...",
--   "hero_subheadline": "...",
--   "tagline": "...",
--   "about_text": "...",
--   "services": [{ "name": "...", "description": "..." }, ...],
--   "testimonials": [{ "name": "...", "text": "..." }, ...],
--   "cta_text": "Call Now",
--   "cta_phone": "+1...",
--   "cta_email": "...",
--   "hours": "...",
--   "service_area": "...",
--   "photos": ["url1", "url2", ...]
-- }
--
-- theme shape (derived from tenant branding):
-- {
--   "primary_color": "#RRGGBB",
--   "secondary_color": "#RRGGBB",
--   "accent_color": "#RRGGBB",
--   "font_family": "Inter"
-- }

CREATE TABLE IF NOT EXISTS tenant_websites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  domain TEXT,
  subdomain TEXT UNIQUE,
  cf_project_name TEXT,
  cf_zone_id TEXT,
  cf_domain_registered BOOLEAN DEFAULT FALSE,
  template TEXT DEFAULT 'service-business-v1',
  page_data JSONB DEFAULT '{}'::jsonb,
  theme JSONB DEFAULT '{}'::jsonb,
  status TEXT DEFAULT 'draft',
  build_error TEXT,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_tenant_websites_tenant ON tenant_websites(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_websites_domain ON tenant_websites(domain) WHERE domain IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tenant_websites_subdomain ON tenant_websites(subdomain) WHERE subdomain IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tenant_websites_status ON tenant_websites(status);
