-- Migration 010: Platform & Tenant Health Monitoring
-- Phase 8: Operational Automation & Steady State

-- Platform-level health checks (Supabase, Twilio, Buffer, API, Worker)
CREATE TABLE IF NOT EXISTS platform_health_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service text NOT NULL,
  status text NOT NULL CHECK (status IN ('healthy', 'degraded', 'down')),
  response_time_ms integer,
  error_message text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_platform_health_service ON platform_health_checks (service, created_at DESC);
CREATE INDEX idx_platform_health_created ON platform_health_checks (created_at DESC);

-- Per-tenant health checks
CREATE TABLE IF NOT EXISTS tenant_health_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  status text NOT NULL CHECK (status IN ('healthy', 'degraded', 'down')),
  metrics jsonb DEFAULT '{}',
  issues text[] DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_tenant_health_tenant ON tenant_health_checks (tenant_id, created_at DESC);
CREATE INDEX idx_tenant_health_status ON tenant_health_checks (status, created_at DESC);

-- Client health scores (used by health-scoring.js)
CREATE TABLE IF NOT EXISTS client_health_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  score text NOT NULL CHECK (score IN ('green', 'yellow', 'red')),
  factors jsonb DEFAULT '{}',
  recommendations text[] DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_health_scores_tenant ON client_health_scores (tenant_id, created_at DESC);
CREATE INDEX idx_health_scores_score ON client_health_scores (score, created_at DESC);
