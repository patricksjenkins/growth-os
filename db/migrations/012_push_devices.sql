-- Migration 012: Push Notification Devices
-- Stores Expo push tokens per tenant/user so agents can send push notifications.

CREATE TABLE IF NOT EXISTS push_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid,
  token text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('ios', 'android', 'web')),
  device_name text,
  active boolean NOT NULL DEFAULT true,
  last_seen_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(token)
);

CREATE INDEX IF NOT EXISTS idx_push_devices_tenant ON push_devices (tenant_id, active);
CREATE INDEX IF NOT EXISTS idx_push_devices_user ON push_devices (user_id);

ALTER TABLE push_devices ENABLE ROW LEVEL SECURITY;

CREATE POLICY push_devices_tenant ON push_devices
  FOR ALL USING (tenant_id = current_setting('app.tenant_id')::uuid);
