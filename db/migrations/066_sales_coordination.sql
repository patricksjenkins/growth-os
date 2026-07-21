-- ============================================================================
-- Migration 066: Sales coordination — shared per-lead next-action state
-- Date: 2026-07-21
-- Purpose: turn the existing sales agents into a coordinated department by
--          giving every lead exactly one next action, one owner, and a due
--          date, plus explicit human-handoff fields. Strictly additive:
--          nullable columns on `leads` only — no new tables (handoff events
--          use activity_log, owner actions use attention_queue), no changes
--          to existing columns, constraints, or RLS (table-level policies
--          already cover new columns).
-- ============================================================================

alter table leads add column if not exists next_best_action text;
alter table leads add column if not exists next_action_owner text;
alter table leads add column if not exists next_action_due_at timestamptz;
alter table leads add column if not exists human_handoff_reason text;
alter table leads add column if not exists handoff_at timestamptz;
alter table leads add column if not exists last_reply_at timestamptz;
alter table leads add column if not exists sales_call_status text;

comment on column leads.next_best_action is
  'Sales-coordination machine key set by core/sales/coordination.js: draft_outreach | review_draft | enrich | facebook_dm | await_sequence | enroll_followup | sales_call | answer_question | review_reply | prep_meeting | follow_up_proposal | trial_checkin | nurture_touch. NULL for closed leads.';
comment on column leads.next_action_owner is
  'Exactly one owner for the next action: an agent name (outreach, auto-outreach, drip-campaign, enrichment, meeting-prep, sales-nurture, facebook-prospecting) or ''owner'' (the human).';
comment on column leads.next_action_due_at is
  'When the next action becomes overdue (drives the owner-overdue sales invariant alert).';
comment on column leads.human_handoff_reason is
  'Why the human lane was triggered: interested_reply | question_reply | drip_reply | low_confidence | meeting_booked.';
comment on column leads.sales_call_status is
  'needed -> scheduled -> done. NULL when no call is on the table.';

-- Partial indexes: the owner queue ("what needs Patrick") and the due sweep
-- are the two hot filters; both exclude the (majority) NULL rows.
create index if not exists idx_leads_next_action_owner
  on leads (tenant_id, next_action_owner, next_action_due_at)
  where next_best_action is not null;
create index if not exists idx_leads_human_handoff
  on leads (tenant_id, handoff_at desc)
  where human_handoff_reason is not null;
