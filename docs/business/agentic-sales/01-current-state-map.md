# Agentic Sales Department — Pass 1: Current-State Map

*Audited 2026-07-21 against the live codebase and production behavior. This maps what ALREADY
exists of a sales department inside FGA. Verdict up front: FGA already employs most of a
sales team — what's missing is not agents, it's coordination state (per-lead next action +
ownership), formalized handoffs, and the human-handoff surface.*

## 1. The sales roster that already exists

| Sales-department role | Existing agent(s) | Trigger | Status | Verdict |
|---|---|---|---|---|
| Head of Sales (coordination) | `prospecting-orchestrator` | 3×/day cron (6:15/12:15/17:15 ET), FGA-only | ACTIVE — rules-based, no paid API, never sends. Builds funnel + Next Best Actions + stall alerts → `growth_engine_snapshots` | **PROMOTE** — this is the Sales Orchestrator seed. Extend it; do not build a rival. |
| Prospecting (SDR-research) | `prospecting` (daily 6am, multi-industry rotation, weekly qualified target, hard caps) + `facebook-prospecting` (2pm, fb-only leads) + `targeted-campaign` (idle-by-default, owner-defined) | cron | ACTIVE | **KEEP AS-IS** — already capacity-managed and deduped |
| Research/Enrichment | `enrichment` (inline + 8am sweeper; ~9 public sources; goal = email or FB URL; confidence via found fields) | cron + inline | ACTIVE | **KEEP AS-IS** |
| Qualification/Scoring | `scoring` (100-pt ICP: size 30 / industry 20 / geo 15 / growth 15 / benefits 10 / contact 10) + autosend `draft_quality` gate | 7:30am + event | ACTIVE | **KEEP AS-IS**; scoring feeds eligibility already |
| Outreach (first touch) | `outreach` (drafts ONLY — email or FB DM; 9am Mon–Sat) + `auto-outreach` (armed dispatcher, 3 windows/day, every-gate-must-pass, ramp, circuit breaker, `autosend_decisions` audit) | cron, flag-gated | ACTIVE | **KEEP AS-IS** — the safety architecture here is the crown jewel; nothing new touches sending |
| Sequences/Follow-up | `drip-campaign` (TOUCH_DAYS 7…180, stop-on-reply, daily cap, holiday/window aware) + `outreach-cadence` (per-tenant enrollments) + `follow-up` (customer-side) | cron | ACTIVE | **KEEP AS-IS** |
| Conversation/Reply | `reply-classification` (half-hourly + event from inbound webhook; interested / positive_objection / firm_no / unsubscribe / OOO / wrong_person / needs_more_info → routes lead, sets suppressions, stops automation) + `conversation-responder` (bounded AI turns, escalates) + drip `sync_replies` (Gmail) | cron + event | ACTIVE | **KEEP; EXTEND surfacing** — classification works; the OWNER-VISIBLE handoff on "interested" is the gap |
| Warm-pipeline nurture | `sales-nurture` (demo follow-up, trial check-ins d7/d13, monthly nurture; email-only; idempotent per intent/period) | daily 9am | ACTIVE | **KEEP AS-IS** |
| Sales assistant / meeting prep | `meeting-prep` (8am/2pm cron + Calendly event; Claude briefing emailed to owner) | cron + event | ACTIVE | **KEEP; ADD trigger** — nothing invokes it when a cold prospect turns interested |
| Partner motion | `partner-outreach` (cadence per partner; step-1 owner-approved) | cron | ACTIVE | **KEEP; coordinate only** |
| Reporting/visibility | `digest` (per-tenant 5pm), `platform-daily-digest` (6:30am, FGA), `reporting` (Fri weekly), `chief-of-staff` (briefings) | cron | ACTIVE | **KEEP; EXTEND** with sales-intel section |
| Sales ops guardian | `operations-guardian` (3h; detects failing/stalled agents + missing output; bounded L1 fixes; `ops_incidents`) + `system-monitor` (3h dependency probes) + `threshold-alerts` + `churn-risk-detector` | cron | ACTIVE | **KEEP; EXTEND checks** (leads w/o next action, unsurfaced replies) |
| Send plumbing | `core/outreach-send.js` choke point (atomic claim, CAN-SPAM, unsubscribe, postal, drip enrollment), `scheduled-email-dispatch`, Resend webhooks (bounce/complaint → breaker), central suppression (`core/growth/suppression.js`, `lead_suppressions`) | — | ACTIVE | **UNTOUCHED** — all sending continues to flow through here |

Agents inspected and **intentionally excluded** from the sales team: content pipeline
(content-plan/generation/finalize/publisher/approval-queue — marketing, not sales),
finance/back-office (billing, bookkeeping, tax-prep, mercury-sync, invoice-scan,
audit-dry-run, nexus-monitor), onboarding/platform (onboarding-advance, dfy-website-build,
app-asset-pipeline, monthly-usage-reset), customer-delivery agents (voice-receptionist,
speed-to-lead, missed-call, review-request, referral-request, past-customer-reengagement —
these serve *tenants'* customers), 923A-scoped commercial-discovery/finder,
AKA-scoped referral-partner-finder. Dormant: campaign-orchestrator, distribution.

## 2. Where the sales work actually lives (data model)

- **`leads`** — the prospect record (status: new_lead → contacted → replied/interested →
  demo_booked → … / no_response / unsubscribed / bounced / long_term_followup). FGA's own
  sales pipeline runs on `leads` under the FGA tenant.
- **`outreach_sequences`** — first-touch drafts + sent messages (status `draft` /
  `needs_review` / sent…). KNOWN DEFECT (open item since 2026-07-09): already-contacted
  leads retain `status='draft'` rows that pollute candidate pools and counts.
- **`autosend_decisions`** — per-lead gate audit (decision + reason) for the dispatcher.
- **`drip_enrollments` / `drip_sends`** — follow-up sequence state, idempotent per touch.
- **`lead_suppressions`** — central do-not-contact (bounce/unsub/engaged/customer).
- **`growth_engine_snapshots`** — orchestrator output (funnel, NBAs, stalls) that the
  Growth Engine page + mobile screen render.
- **`attention_queue`** — unified needs-attention inbox (red/amber/blue/green) already
  surfaced on web + mobile with push.
- **`activity_log` / `agent_jobs`** — event + run history.
- **`pipeline_prospects`** — legacy/parallel record used by onboarding + admin flows.
- **`lead_tasks`** — per-lead task rows (owner to-do surface).

## 3. Verified gaps (the real ones)

1. **No per-lead next action / ownership.** NBAs exist only inside snapshot JSON. A lead can
   sit in `contacted` with no owner, no due date, and nothing sweeping it. (The 25-wedged
   drip / starved-outreach incidents of June–July were all "nobody owned the next step"
   failures caught late.)
2. **Stale-draft pollution.** Contacted leads keep `draft` sequences → wrong counts, wasted
   candidate-pool slots. Flagged 2026-07-09; display-level fixes only so far.
3. **Interest doesn't summon the human loudly.** `reply-classification` stops automation and
   moves the lead, but an *interested* reply does not reliably create a high-priority owner
   action + push + meeting brief. (Patrick finds interested replies by reading the inbox.)
4. **Meeting prep is calendar-triggered only.** Nothing prepares a brief when a cold
   prospect turns hot before a Calendly booking exists.
5. **No formal handoff record.** Transitions happen (statuses change) but no structured
   who-owned-it → who-owns-it-now → why → due-when trail.
6. **No learning rollup.** `autosend_decisions`, `drip_sends`, and reply classifications
   exist as raw data; nothing aggregates reply-rate by vertical/angle/score-band into the
   weekly report.
7. **Guardian doesn't know sales invariants.** Ops Guardian watches agent health, not
   "every active lead has a next action" or "no reply older than N hours unsurfaced."

## 4. What must NOT change (protection list, verified call sites before any edit)

`core/outreach-send.js` gates · `core/auto-outreach.js` gate engine + breaker · suppression
& unsubscribe paths · drip cursor/idempotency · tenant email identity (audience gate,
per-tenant From) · `callClaude` choke point + pace gate · usage caps · RLS/tenant isolation ·
all cron cadences · the 281-test suite stays green.
