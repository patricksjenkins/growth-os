-- Migration 011: Social Engagement Agent & Email Chief of Staff
-- Phase 3: Scale-tier AI Agents

-- ---------------------------------------------------------------------------
-- Social Platform OAuth Connections
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS social_platform_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  platform text NOT NULL CHECK (platform IN ('facebook', 'instagram', 'tiktok')),
  access_token text NOT NULL,
  refresh_token text,
  page_id text,
  page_name text,
  scopes text[] DEFAULT '{}',
  expires_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(tenant_id, platform)
);

CREATE INDEX idx_social_connections_tenant ON social_platform_connections (tenant_id);
CREATE INDEX idx_social_connections_platform ON social_platform_connections (tenant_id, platform);
CREATE INDEX idx_social_connections_expires ON social_platform_connections (expires_at);

-- ---------------------------------------------------------------------------
-- Social Comments
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS social_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  platform text NOT NULL CHECK (platform IN ('facebook', 'instagram', 'tiktok')),
  post_id text NOT NULL,
  comment_id text NOT NULL,
  parent_comment_id text,
  author_name text,
  author_id text,
  content text NOT NULL,
  classification text CHECK (classification IN ('lead', 'compliment', 'question', 'negative', 'spam')),
  confidence_score numeric(4,3),
  response_text text,
  response_status text NOT NULL DEFAULT 'pending' CHECK (response_status IN ('auto_responded', 'flagged', 'hidden', 'pending', 'dismissed')),
  liked boolean DEFAULT false,
  lead_id uuid,
  responded_at timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_social_comments_tenant ON social_comments (tenant_id, created_at DESC);
CREATE INDEX idx_social_comments_platform ON social_comments (tenant_id, platform);
CREATE INDEX idx_social_comments_status ON social_comments (tenant_id, response_status);
CREATE INDEX idx_social_comments_classification ON social_comments (tenant_id, classification);
CREATE INDEX idx_social_comments_comment_id ON social_comments (comment_id);
CREATE UNIQUE INDEX idx_social_comments_unique ON social_comments (tenant_id, platform, comment_id);

-- ---------------------------------------------------------------------------
-- Social Engagement Log
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS social_engagement_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  action_type text NOT NULL CHECK (action_type IN ('like', 'respond', 'hide', 'flag', 'classify', 'lead_capture', 'approve', 'dismiss')),
  platform text NOT NULL,
  comment_id text,
  details jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_social_log_tenant ON social_engagement_log (tenant_id, created_at DESC);
CREATE INDEX idx_social_log_action ON social_engagement_log (tenant_id, action_type);

-- ---------------------------------------------------------------------------
-- Email Connections
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS email_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  provider text NOT NULL CHECK (provider IN ('gmail', 'outlook')),
  access_token text NOT NULL,
  refresh_token text,
  email_address text NOT NULL,
  expires_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(tenant_id, provider)
);

CREATE INDEX idx_email_connections_tenant ON email_connections (tenant_id);
CREATE INDEX idx_email_connections_provider ON email_connections (tenant_id, provider);

-- ---------------------------------------------------------------------------
-- Email Messages
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS email_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  provider text NOT NULL CHECK (provider IN ('gmail', 'outlook')),
  message_id text NOT NULL,
  thread_id text,
  from_address text NOT NULL,
  from_name text,
  to_address text,
  subject text,
  body_preview text,
  classification text CHECK (classification IN ('lead_inquiry', 'customer_question', 'vendor_solicitation', 'important_personal', 'spam')),
  confidence_score numeric(4,3),
  response_text text,
  response_status text NOT NULL DEFAULT 'pending' CHECK (response_status IN ('auto_responded', 'flagged', 'archived', 'pending', 'dismissed')),
  lead_id uuid,
  processed_at timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_email_messages_tenant ON email_messages (tenant_id, created_at DESC);
CREATE INDEX idx_email_messages_provider ON email_messages (tenant_id, provider);
CREATE INDEX idx_email_messages_status ON email_messages (tenant_id, response_status);
CREATE INDEX idx_email_messages_classification ON email_messages (tenant_id, classification);
CREATE INDEX idx_email_messages_message_id ON email_messages (message_id);
CREATE UNIQUE INDEX idx_email_messages_unique ON email_messages (tenant_id, provider, message_id);

-- ---------------------------------------------------------------------------
-- Email Agent Log
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS email_agent_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  action_type text NOT NULL CHECK (action_type IN ('classify', 'auto_respond', 'flag', 'archive', 'lead_capture', 'approve', 'dismiss', 'connect', 'refresh_token')),
  provider text,
  message_id text,
  details jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_email_log_tenant ON email_agent_log (tenant_id, created_at DESC);
CREATE INDEX idx_email_log_action ON email_agent_log (tenant_id, action_type);

-- ---------------------------------------------------------------------------
-- RLS Policies
-- ---------------------------------------------------------------------------

ALTER TABLE social_platform_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_engagement_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_agent_log ENABLE ROW LEVEL SECURITY;

-- Tenants can only see their own data
CREATE POLICY social_connections_tenant ON social_platform_connections
  FOR ALL USING (tenant_id = current_setting('app.tenant_id')::uuid);

CREATE POLICY social_comments_tenant ON social_comments
  FOR ALL USING (tenant_id = current_setting('app.tenant_id')::uuid);

CREATE POLICY social_log_tenant ON social_engagement_log
  FOR ALL USING (tenant_id = current_setting('app.tenant_id')::uuid);

CREATE POLICY email_connections_tenant ON email_connections
  FOR ALL USING (tenant_id = current_setting('app.tenant_id')::uuid);

CREATE POLICY email_messages_tenant ON email_messages
  FOR ALL USING (tenant_id = current_setting('app.tenant_id')::uuid);

CREATE POLICY email_log_tenant ON email_agent_log
  FOR ALL USING (tenant_id = current_setting('app.tenant_id')::uuid);
