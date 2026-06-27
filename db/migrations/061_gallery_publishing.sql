-- 061_gallery_publishing.sql
-- Owner-managed Website Photos / Gallery Publishing workflow.
--
-- The gallery_items + gallery_item_assets tables were pre-provisioned (RLS on,
-- no policies, empty). This migration makes them usable by:
--   1. Adding the few fields the owner UI needs (city, service_type, before_*).
--   2. Adding JWT tenant-isolation RLS policies (same pattern as customers/jobs,
--      migration 055) so the owner portal (getUserClient) can read/write its own
--      rows. Public reads do NOT go direct — they go through the service-role
--      /api/public/gallery endpoint (published-only), so drafts never leak.
--   3. Indexes for the common owner + public queries.
--
-- Field mapping to the spec: headline -> title, caption -> description.
-- For Before & After items the finished/after image is public_image_url and the
-- optional before image is before_url (before is optional by design).

ALTER TABLE gallery_items ADD COLUMN IF NOT EXISTS city         text;
ALTER TABLE gallery_items ADD COLUMN IF NOT EXISTS service_type text;
ALTER TABLE gallery_items ADD COLUMN IF NOT EXISTS before_url   text;
ALTER TABLE gallery_items ADD COLUMN IF NOT EXISTS before_path  text;

-- Tenant isolation via JWT app_metadata.tenant_id (service_role bypasses).
DROP POLICY IF EXISTS tenant_iso_jwt_gallery_items ON gallery_items;
CREATE POLICY tenant_iso_jwt_gallery_items ON gallery_items FOR ALL
  USING      (auth.role() = 'service_role' OR tenant_id::text = (auth.jwt() -> 'app_metadata' ->> 'tenant_id'))
  WITH CHECK (auth.role() = 'service_role' OR tenant_id::text = (auth.jwt() -> 'app_metadata' ->> 'tenant_id'));

DROP POLICY IF EXISTS tenant_iso_jwt_gallery_item_assets ON gallery_item_assets;
CREATE POLICY tenant_iso_jwt_gallery_item_assets ON gallery_item_assets FOR ALL
  USING      (auth.role() = 'service_role' OR tenant_id::text = (auth.jwt() -> 'app_metadata' ->> 'tenant_id'))
  WITH CHECK (auth.role() = 'service_role' OR tenant_id::text = (auth.jwt() -> 'app_metadata' ->> 'tenant_id'));

-- Owner portal lists by category; public endpoint filters published + featured + sort.
CREATE INDEX IF NOT EXISTS idx_gallery_items_tenant_cat
  ON gallery_items (tenant_id, category, status, sort_order);
CREATE INDEX IF NOT EXISTS idx_gallery_items_public
  ON gallery_items (tenant_id, status, category, featured, sort_order);
