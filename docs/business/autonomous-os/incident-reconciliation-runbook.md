# Incident reconciliation activation runbook

## Current state

The canonical recovery path is implemented but disabled. The Operations
Guardian preserves its deployed compatibility behavior unless every flag and
exact FGA tenant cohort below is enabled. No active client tenant is eligible
by default.

Required flags:

- `FGA_OS_CONTROL_PLANE_API_ENABLED=true`
- `FGA_OS_DECISION_QUEUE_WRITES_ENABLED=true`
- `FGA_OS_INCIDENT_RECONCILIATION_WRITES_ENABLED=true`

Required exact-UUID cohorts:

- `FGA_OS_CONTROL_PLANE_TENANT_ALLOWLIST`
- `FGA_OS_DECISION_QUEUE_WRITE_TENANT_ALLOWLIST`
- `FGA_OS_INCIDENT_RECONCILIATION_TENANT_ALLOWLIST`

All three cohorts must contain only the intended tenant for the supervised
evidence period. Adding an active client tenant is a separate authority change.

## What the gated path does

1. Selects a successful agent job or resumed prospecting output after the
   incident/retry boundary.
2. Creates or reuses one tenant-bound canonical incident work item through the
   atomic command RPC.
3. Resolves the citation against the authoritative `agent_jobs` or `leads` row
   in the database, including tenant, agent/output type, result status, and
   observation time.
4. Under row locks, verifies the work item, marks the incident recovered,
   supersedes the legacy attention row, and appends immutable evidence.
5. Replays an identical request without creating another recovery event.

A missing, mismatched, pre-incident, cross-tenant, wrong-agent, wrong-output, or
caller-dated citation fails closed. A failed canonical reconciliation does not
fall back to a direct incident recovery update.

## Pre-activation evidence

Before requesting production activation:

1. Confirm the Autonomous OS safety workflow is green on the exact commit.
2. Confirm migrations 067–075 apply and replay in ephemeral PostgreSQL.
3. Confirm the released-shape upgrade fixture passes with legacy assignments
   and entity links intact.
4. Confirm service-role direct work-ledger mutations are denied.
5. Run the guardian in dry-run/shadow mode and inventory every candidate
   recovery without exposing incident content.
6. Prove the authoritative evidence record exists and is tenant-bound for each
   candidate class.
7. Record rollback and backup evidence.

## Containment and rollback

1. Disable `FGA_OS_INCIDENT_RECONCILIATION_WRITES_ENABLED`.
2. Remove the tenant UUID from the incident reconciliation cohort.
3. Preserve all reconciliation evidence.
4. Migration 075’s containment rollback removes the additional identity guards
   but intentionally retains RPC-only service mutation and assignment clearing
   on reopen.
5. Migration 074’s rollback refuses to remove evidence-bearing tables. Export
   and retain evidence before any separately approved schema removal.

Production flag activation and production migrations belong in the consolidated
approval packet.
