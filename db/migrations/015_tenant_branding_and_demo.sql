-- Migration 015: Tenant branding + demo flag
--
-- Two small changes to the tenants table that power per-client theming and
-- the public demo account.
--
-- 1. `branding` JSONB — per-tenant theme overrides that win over the vertical
--    default palette in core/verticals/. Shape:
--    {
--      "primary_color":   "#RRGGBB",
--      "secondary_color": "#RRGGBB",
--      "accent_color":    "#RRGGBB",
--      "logo_url":        "https://...",
--      "business_name":   "Jenkins Plumbing"
--    }
--    All fields optional. Missing fields fall back to vertical defaults.
--
-- 2. `is_demo` BOOLEAN — when true, the tenant is a demo/sandbox account.
--    Integration layer (twilio, buffer, stripe, email) checks this flag and
--    short-circuits real sends/charges so prospects can tap around without
--    triggering real-world side effects. Writes to the DB still work so the
--    UX feels real; a weekly reset cron wipes the demo state and re-seeds.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS branding JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS is_demo  BOOLEAN DEFAULT FALSE;

-- Partial index so the demo-mode guardrails can find demo tenants fast.
CREATE INDEX IF NOT EXISTS idx_tenants_is_demo
  ON tenants(id)
  WHERE is_demo = true;
