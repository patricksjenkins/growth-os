# Agentic Sales Department — Pass 2: Architecture

*Design principle: FGA already employs the sales team (see 01-current-state-map.md). This
pass adds the three things a collection of agents needs to become a department:
**shared per-lead state** (next action + owner + due date), **formal handoffs**, and a
**loud human-handoff lane**. Everything is additive; no send path, gate, cap, or cron
changes. Kill switch: `tenant_config sales_coordination_enabled` — coordination is ON
unless explicitly set to `'false'` (all writes are FGA-tenant-scoped and reversible).*

## 1. Org chart (existing agents, new coordination)

```
                    ┌─────────────────────────────────────────┐
                    │  SALES ORCHESTRATOR (Head of Sales)     │
                    │  = prospecting-orchestrator, extended   │
                    │  3×/day: snapshot + per-lead next       │
                    │  actions + stale-draft supersession +   │
                    │  sales invariants → alerts              │
                    └───────┬─────────────────────────────────┘
        assigns/monitors via leads.next_best_action / next_action_owner
   ┌──────────┬──────────┬──────┴─────┬─────────────┬──────────────┬───────────┐
 PROSPECTING  ENRICH   QUALIFY      OUTREACH      SEQUENCES     CONVERSATION  HUMAN (Patrick)
 prospecting  enrich-  scoring +    outreach      drip-campaign reply-class.  sales calls,
 fb-prospect. ment     autosend     (drafts) +    outreach-cad. conv-resp.    judgment,
 targeted-c.           quality gate auto-outreach sales-nurture drip sync     relationships
                                    (send gates)  sched-email
   └──────────┴──────────┴────────────┴─────────────┴──────┬───────┴───────────┘
                                                    handoff events → activity_log
                     SUPPORT: meeting-prep (briefs) · digest/chief-of-staff/
                     platform-daily-digest (reporting) · operations-guardian +
                     system-monitor + threshold-alerts (sales ops guardian)
```

No agent is renamed, deleted, or rescheduled. The orchestrator coordinates by writing
shared state that other surfaces read — it does not invoke agents synchronously (no
agent-to-agent recursion; everything stays on the existing cron/queue).

## 2. Shared sales state (migration 066, additive columns on `leads`)

| Field | Type | Meaning |
|---|---|---|
| `next_best_action` | TEXT | machine key: `draft_outreach`, `review_draft`, `enrich`, `await_sequence`, `enroll_followup`, `sales_call`, `answer_question`, `prep_meeting`, `send_proposal`, `close_out` — NULL for terminal leads |
| `next_action_owner` | TEXT | exactly one owner: an agent name (`outreach`, `auto-outreach`, `drip-campaign`, `enrichment`, `meeting-prep`) or `'owner'` (Patrick) |
| `next_action_due_at` | TIMESTAMPTZ | when it's late |
| `human_handoff_reason` | TEXT | why the human lane was triggered (`interested_reply`, `question_reply`, `drip_reply`, `low_confidence`, …) |
| `handoff_at` | TIMESTAMPTZ | when handed to the human |
| `last_reply_at` | TIMESTAMPTZ | latest inbound from the prospect |
| `sales_call_status` | TEXT | `needed` → `scheduled` → `done` (NULL otherwise) |

Why columns on `leads`, not a new table: every reader (pipeline API `select('*')`, mobile,
orchestrator, guardian) already fetches leads; a side table would need joins in six places
and create a second source of truth. `activity_log` (audited convention:
`agent/action/entity_type/entity_id/level/metadata`) records the **handoff trail**:
`action='sales_handoff'`, metadata `{from_owner, to_owner, reason, next_action, due_at,
source_agent}` — no new table. `attention_queue` records **owner actions** (existing CHECKed
severities red/amber/blue; new types `sales_reply_interested` (red), `sales_reply_question`
(amber); dedup 24h/lead like auto-outreach's `raiseAttention`).

Ownership rule (tested): `deriveLeadNextAction()` is a pure function of lead + context
(draft present? enrollment active? classification?) returning exactly ONE `{action, owner,
due}` — so two agents can never own the same lead's next step, and every non-terminal lead
gets one. Terminal statuses come from `core/growth/suppression.js TERMINAL_LEAD_STATUSES`
(single source; the tri-definition drift noted in Pass 1 is a follow-up recommendation).

## 3. Event-driven handoffs (formalized on existing transitions)

| Event (already happens) | Where | New coordination (additive) |
|---|---|---|
| Prospect found | prospecting inserts lead | orchestrator assigns `enrich`/`draft_outreach` on next pass |
| Enriched → qualified | enrichment/scoring | NBA becomes `review_draft`/`draft_outreach` |
| First touch sent | `core/outreach-send.js` (unchanged) | NBA → `await_sequence` owner `drip-campaign`, due = next touch |
| Reply received (drip) | `drip-gmail routeClassified` genuine_reply | + handoff fields, push, red/amber surfacing (it already stops automation + writes blue item) |
| Reply classified interested/question | `reply-classification` | **HUMAN HANDOFF**: attention item (red/amber) + push + `sales_call_status='needed'` + meeting-prep enqueue `{lead_id}` + handoff log |
| Meeting booked | Calendly webhook | meeting-prep now resolves `contact_id → lead_id` (bug fix) so the brief targets the right lead |
| Demo → close | sales-nurture cadences (unchanged) | NBAs `prep_meeting`/`send_proposal`; outcomes stay `won/lost` + `loss_reason` |

## 4. Human-handoff lane (the owner's contract)

Patrick is summoned exactly when: interested reply · substantive question · meeting request
(Calendly) · drip reply (already-stopped automation, needs a human read) · low-confidence
classification (`ambiguous` → existing `drip_review` amber). On handoff: automation is
already stopped by the existing stop-on-reply machinery (verified — suppression +
`automation_status='replied_stop'` + enrollment stop); coordination *adds*: red/amber
attention item with reply snippet + recommended action, push notification, per-lead
`sales_call_status='needed'`, and a meeting brief generated before the call. Autonomy
boundaries are unchanged and inherited: no pricing in cold outreach (starvation-enforced),
no promises (fact-gated copy), suppression/unsubscribe/caps/identity gates untouched.

## 5. Surfaces

- **Web Growth Engine**: funnel gains `sales_calls_needed` + `no_next_action` (the invariant
  metric — should read 0); NBA list gains the owner lane; alerts gain sales invariants
  (owner action overdue >48h, reply unsurfaced >24h). All tiles keep deep-linking to
  Pipeline queue views; new `?view=sales-calls` predicate on `next_action_owner='owner'`.
- **Mobile**: already renders attention items + push on Home. Additive: `attentionNav`
  mappings so `sales_reply_*` and `drip_reply` deep-link to the lead (ships with next
  TestFlight build; until then the cards render as today, non-linked).
- **Daily brief**: platform-daily-digest gains a Sales Brief section (replies awaiting
  response, sales calls needed, interested leads, drafts to review, demos booked) — real
  counts from `leads`/`attention_queue`, same 24h window.
- **Learning**: auto-outreach's Monday `weeklyReport` (real `autosend_decisions` +
  `drip_sends` + classifications) gains reply-rate by industry and score band — measured
  data only, no fabricated insight.

## 6. Guardian integration

Sales invariants live in the orchestrator's `deriveAlerts` (feeds snapshot → dashboard →
platform digest critical section) rather than a new guardian: (a) active leads with no
next action, (b) owner actions overdue, (c) inbound replies in last 24h without an open
attention item, (d) draft backlog + existing alerts. Ops Guardian continues to own
agent-health/self-healing; nothing there changes.

## 7. Explicitly out of scope (recommendations, need approval)

1. Unify the three terminal-status definitions into one exported set (touches bulk-send +
   drip; do as its own reviewed change).
2. `pipeline_prospects` retirement (near-dead; its one write path in `core/onboarding.js`
   appears broken against the schema — verify then remove).
3. Fix `activity_log` writers using non-existent `type`/`details` columns
   (health-scoring.js, usage-caps.js) — silent data loss today.
4. Auto-drafted reply suggestions for interested prospects (agent writes a suggested
   response for one-tap send) — high value, but it's a new outbound surface; wants its own
   safety review.
5. `/api/admin/pipeline` payload trim (still ~17s; long-standing perf task).
