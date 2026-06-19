-- 053_customer_reviews.sql
-- Per-customer review-request tracking for the owner portal Reviews command center.
-- Model: the owner MANUALLY ADDS a customer (going forward) with name + email +
-- phone + what the job was, then sends/copies a review request and tracks status.
-- (Finance income history has no emails, so we don't mine it.)

CREATE TABLE IF NOT EXISTS customer_reviews (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_name   TEXT NOT NULL,
  customer_email  TEXT,
  customer_phone  TEXT,
  service_type    TEXT,
  status          TEXT NOT NULL DEFAULT 'not_sent',  -- not_sent | sent | received | do_not_ask
  sent_at         TIMESTAMPTZ,
  sent_to         TEXT,
  channel         TEXT,                               -- email | manual_copy
  received_at     TIMESTAMPTZ,
  review_source   TEXT,                               -- Google | HomeAdvisor | Facebook | ...
  do_not_request  BOOLEAN NOT NULL DEFAULT FALSE,
  request_count   INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customer_reviews_tenant ON customer_reviews(tenant_id);

ALTER TABLE customer_reviews ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_iso_customer_reviews ON customer_reviews;
CREATE POLICY tenant_iso_customer_reviews ON customer_reviews FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
