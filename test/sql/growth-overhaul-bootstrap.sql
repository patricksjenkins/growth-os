\set ON_ERROR_STOP on
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS auth;

CREATE OR REPLACE FUNCTION auth.role() RETURNS text
LANGUAGE sql STABLE AS $$ SELECT 'service_role'::text $$;
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb
LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;

CREATE TABLE public.tenants (
  id uuid PRIMARY KEY,
  slug text UNIQUE NOT NULL
);

CREATE TABLE public.leads (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.drip_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id)
);

CREATE TABLE public.drip_enrollments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  lead_id uuid NOT NULL REFERENCES public.leads(id)
);

CREATE TABLE public.outreach_sequences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  lead_id uuid NOT NULL REFERENCES public.leads(id)
);

CREATE TABLE public.email_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL
);

CREATE TABLE public.drip_inbound (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid()
);

CREATE TABLE public.email_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid()
);

INSERT INTO public.tenants (id, slug) VALUES
  ('11111111-1111-4111-8111-111111111111', 'fga-test'),
  ('22222222-2222-4222-8222-222222222222', 'customer-test');
INSERT INTO public.leads (id, tenant_id) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '22222222-2222-4222-8222-222222222222');

