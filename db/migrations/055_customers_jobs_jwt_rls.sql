-- 055_customers_jobs_jwt_rls.sql
-- customers and jobs already have RLS ENABLED but NO policies, which means only
-- service_role can touch them and the tenant user client (getUserClient: anon
-- key + user JWT) is fully denied. That is why the portal derives "customers"
-- from finance_entries instead of using the customers table.
--
-- Add the same JWT-claim tenant-isolation policy used by customer_reviews and
-- finance_entries so the connected workflow can read/write real customer + job
-- rows under proper per-tenant isolation. service_role (workers/admin) bypasses.
--
-- Safe: this only GRANTS tenant-scoped access where none existed. No existing
-- code reads/writes these tables via the user client today (verified: 0 refs).

DROP POLICY IF EXISTS tenant_iso_jwt_customers ON customers;
CREATE POLICY tenant_iso_jwt_customers ON customers FOR ALL
  USING      (auth.role() = 'service_role' OR tenant_id::text = (auth.jwt() -> 'app_metadata' ->> 'tenant_id'))
  WITH CHECK (auth.role() = 'service_role' OR tenant_id::text = (auth.jwt() -> 'app_metadata' ->> 'tenant_id'));

DROP POLICY IF EXISTS tenant_iso_jwt_jobs ON jobs;
CREATE POLICY tenant_iso_jwt_jobs ON jobs FOR ALL
  USING      (auth.role() = 'service_role' OR tenant_id::text = (auth.jwt() -> 'app_metadata' ->> 'tenant_id'))
  WITH CHECK (auth.role() = 'service_role' OR tenant_id::text = (auth.jwt() -> 'app_metadata' ->> 'tenant_id'));
