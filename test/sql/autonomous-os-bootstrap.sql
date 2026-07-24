\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS storage;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION auth.jwt()
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb,
    '{}'::jsonb
  )
$$;

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(auth.jwt()->>'sub', '')::uuid
$$;

CREATE OR REPLACE FUNCTION storage.foldername(path text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN path IS NULL OR path = '' THEN ARRAY[]::text[]
    ELSE (string_to_array(path, '/'))[
      1:GREATEST(array_length(string_to_array(path, '/'), 1) - 1, 0)
    ]
  END
$$;

CREATE TABLE IF NOT EXISTS public.tenants (
  id uuid PRIMARY KEY,
  status text NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS public.attention_queue (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  resolved_at timestamptz,
  resolved_by_label text,
  resolution text,
  resolution_payload jsonb
);

CREATE TABLE IF NOT EXISTS public.leads (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  status text NOT NULL DEFAULT 'new',
  lead_source text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.customers (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id)
);

CREATE TABLE IF NOT EXISTS public.content_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  status text NOT NULL DEFAULT 'draft'
);

CREATE TABLE IF NOT EXISTS public.tenant_users (
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  user_id uuid NOT NULL,
  role text NOT NULL DEFAULT 'member',
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.onboarding_workflows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  status text NOT NULL DEFAULT 'active',
  started_at timestamptz,
  completed_at timestamptz,
  current_day integer NOT NULL DEFAULT 0,
  intake_data jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.agent_jobs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  agent_name text NOT NULL DEFAULT 'fixture-agent',
  status text NOT NULL DEFAULT 'pending',
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.ops_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES public.tenants(id),
  agent_name text NOT NULL,
  issue_type text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  attention_queue_id uuid,
  verification_result text,
  detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.referral_credits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  referrer_lead_id uuid REFERENCES public.leads(id),
  referee_lead_id uuid REFERENCES public.leads(id)
);

CREATE TABLE IF NOT EXISTS storage.buckets (
  id text PRIMARY KEY,
  name text NOT NULL,
  public boolean NOT NULL DEFAULT false,
  file_size_limit bigint,
  allowed_mime_types text[]
);

CREATE TABLE IF NOT EXISTS storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id text NOT NULL,
  name text NOT NULL
);

GRANT USAGE ON SCHEMA public, auth, storage TO authenticated;
