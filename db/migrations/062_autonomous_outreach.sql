-- 062: Autonomous outreach (2026-07-03)
--
-- 1. autosend_decisions — one row per auto-send gate evaluation. The audit
--    trail for "why was this send allowed / blocked" plus the weekly-target
--    counter source (sent = true rows this ISO week).
-- 2. email_events — Resend webhook ingestion (bounce / complaint / delivered)
--    powering suppression + the deliverability circuit breaker.
-- 3. leads.automation_status — SECONDARY status so autonomous mode is visible
--    without touching the existing status / lifecycle_stage state machines.

create table if not exists autosend_decisions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  lead_id uuid references leads(id) on delete set null,
  sequence_id uuid,
  decision text not null check (decision in ('sent','blocked','needs_review','skipped')),
  reason text,                         -- first failing gate (or 'all_gates_passed')
  gates jsonb not null default '{}',   -- { gate_name: { pass, detail } }
  quality jsonb,                       -- cached draft-quality scorer output
  created_at timestamptz not null default now()
);
create index if not exists idx_autosend_decisions_tenant_week
  on autosend_decisions (tenant_id, created_at desc);
create index if not exists idx_autosend_decisions_lead
  on autosend_decisions (lead_id, created_at desc);

create table if not exists email_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants(id) on delete cascade,
  provider text not null default 'resend',
  provider_email_id text,              -- Resend email id
  recipient text,                      -- lowercased email address
  event text not null,                 -- bounced | complained | delivered | opened ...
  payload jsonb,
  created_at timestamptz not null default now()
);
create unique index if not exists uq_email_events_dedupe
  on email_events (provider, provider_email_id, event);
create index if not exists idx_email_events_recipient
  on email_events (recipient, created_at desc);
create index if not exists idx_email_events_recent
  on email_events (created_at desc);

alter table leads add column if not exists automation_status text;
create index if not exists idx_leads_automation_status
  on leads (tenant_id, automation_status)
  where automation_status is not null;

comment on column leads.automation_status is
  'Secondary autonomous-outreach status: auto_queued | auto_sent | needs_review | blocked_suppressed | blocked_duplicate | blocked_no_email | in_drip | replied_stop | unsubscribed | bounced. Never replaces status/lifecycle_stage.';
