# FGA Growth Engine overhaul

Status: production control plane deployed 2026-09-06. Migration 106, the
historical event backfill, seven-touch campaign, signed Resend proof, Gmail
reply sync, canonical restart manifest, and Growth Engine readout are live.
First-touch and follow-up sending remain paused. No restart candidate is
authorized because employee-count evidence is still incomplete.

## Outcome contract

The system's job is not to report that agents ran. Its job is to create
qualified human conversations and hand warm replies to Patrick with an
auditable history.

- Tenant scope: First Gen Automate only. Customer tenant configuration, leads,
  sequences, communications, webhooks, and workflows retain their existing
  behavior.
- ICP: a legitimate business with a source-backed employee count from 1
  through 9. Exact public statements must cite a supplied source URL. Trusted
  provider estimates remain explicitly labeled as estimates and require an
  exact organization-domain match. A count of 10 is excluded. A range or
  unknown count is an evidence gap, never permission to send.
- Market: broad across the existing approved industry pool and all configured
  states. Industry helps prioritize copy; it is not an exclusion gate.
- Cadence: seven total emails on day 0, 3, 7, 14, 30, 90, and 180. The initial
  email and six follow-ups use different conversational purposes and ask for a
  reply rather than demanding a meeting.
- Stop conditions: customer match, suppression, complaint, bounce, human reply,
  terminal lifecycle state, recent accepted send, missing tenant identity, or
  unverifiable provider state.
- Handoff: interested or question replies become warm and stop automation.
  Patrick owns the conversation, pricing, offer, demo, and close.

## Read-only baseline — 2026-09-05

The inspection selected only the FGA tenant and emitted aggregates, not contact
or customer data.

| Signal | Observed |
| --- | ---: |
| FGA leads | 1,645 |
| Outreach sequences | 1,634 |
| Drip enrollments | 599 |
| Active overdue enrollments | 500 |
| Provider-backed drip sends, 365 days | 120 |
| Inbound messages, 365 days | 4 |
| Genuine / ambiguous inbound | 2 / 2 |
| Delivered / bounced, 90 days | 778 / 51 |
| Autosend decisions, 30 days | 13,238 |
| Autosend blocked, 30 days | 11,883 |
| Stored exact under-10 counts | 306 |
| Stored counts with durable employee-source proof | 0 |

An initial dry run appeared to classify 101 leads as eligible, but the final
safety pass proved those historical exact counts lacked durable source
provenance. The canonical 2026-09-06 manifest classified 0 leads as eligible,
1,541 as needing employee/contact evidence, and 106 as excluded. This is an
intentional fail-closed correction, not a loss of prospects. The two FGA-only
recovery waves validate up to 50 records per day, prioritizing otherwise
restart-ready prospects. Recovery orders least-attempted leads first and does
not enqueue outreach as a side effect. The manifest changed no lead,
enrollment, draft, or message.

## Step-by-step implementation plan

### 1. Protect the live company

- Keep every new code path FGA-only using the canonical FGA tenant ID.
- Preserve customer tenant prospecting, scoring, scheduling, integration, and
  communication behavior.
- Use additive migration 106, disabled or pending campaign state, paused sending,
  one-use restart authorization, and a reviewable rollback path.
- Fail closed on missing tenant identity, evidence, database reads, provider
  acceptance, webhook signature, reply sync, or restart authorization.

Exit evidence: isolation tests pass; migration contains no legacy table/column
drop; default script mode performs zero writes.

### 2. Repair prospect supply

- Rotate broadly through 12 industries per weekly FGA run from the configured
  40-industry pool and 49 states.
- Keep customer tenants on their previous 3–5 industry rotation.
- Reject exact headcount 10 or above and route unknown/range-only headcount to
  FGA evidence recovery.
- Persist exact public evidence only with confidence at least 0.8 and a source
  URL that was actually supplied to the search extractor. Apollo organization
  estimates are a separate evidence type, require a matching domain, and are
  never described as exact. A transient provider error does not mark a lead
  unqualified.
- Revalidate the historical backlog in two bounded FGA-only waves per day:
  25 high-score/contactable restart candidates first, then 25 general records.
  Stop after five unsuccessful attempts and leave the record out of outreach.

Exit evidence: strict eligibility, FGA/customer divergence, preflight, and
employee-evidence tests pass.

### 3. Replace activity counts with an evidence ledger

- Record append-only stages: discovered, contact verified, qualified, drafted,
  provider accepted, delivered, human reply, warm, owner accepted, demo held,
  proposal, and won.
- Bind idempotency keys to tenant, lead, event type, and source receipt.
- Keep emails, bodies, recipients, phone numbers, and credentials out of the
  canonical ledger.
- Count delivery only when its provider receipt links to an accepted message.
  Surface unmatched receipts instead of inflating conversion.

Exit evidence: ledger, mutation guard, idempotency, privacy sanitizer, correlated
delivery, and bounded-coverage tests pass.

### 4. Repair sending and follow-up

- Use a single seven-total-touch versioned campaign.
- Require suppression, dedupe, exact ICP, score, quality, cap, tenant, postal,
  provider, and restart gates before FGA autonomous first touch.
- Require immutable provider acceptance before marking a send successful.
- Never blind-retry an accepted message whose local receipt is uncertain.
- Quarantine a stale `sending` claim for review instead of sending it again.
- Run due follow-ups every day while still honoring caps and stop conditions.

Exit evidence: seven-touch contract, gate, provider receipt, stale-claim,
suppression, recovery, and daily-cadence tests pass.

### 5. Repair reply detection and warm handoff

- Scan Gmail with a durable cursor and a 14-day overlap so downtime cannot skip
  messages.
- Fetch and classify the full body. A failed body read becomes ambiguous and
  requires review; it never guesses from a snippet.
- Persist pending/routing-failed state and retry routing safely.
- Stop the sequence on every genuine human reply. Promote interested/question
  intent to warm; make not-interested terminal; route other human replies to
  review.
- Do not advance the cursor after an incomplete mailbox or database read.

Exit evidence: reply intent, retry, cursor, tenant, and fail-closed tests pass;
the dashboard shows the last successful sync.

### 6. Restart good existing prospects safely

- Generate a privacy-safe FGA-only manifest; never select a customer tenant.
- Exclude customers, replies, ambiguous replies, unsubscribes, suppressions,
  negative delivery history, terminal states, invalid sources, and cooldowns.
- Revalidate each eligible lead immediately before applying.
- Require the canonical campaign to be active and autonomous sending paused.
- Stop only that lead's old FGA enrollment, supersede only its FGA draft, reset
  the lead, and create a one-use authorization bound to the new sequence.
- Queue draft generation only. Review the batch before resuming sends.

Exit evidence: restart-policy tests pass; the apply script proves each write,
does not mark completion before every job is queued, and stops before all writes
if the separate large-batch approval gate would hold the jobs.

### 7. Rebuild the operator experience

- Keep the current light Command Center design language.
- Show qualified inventory, provider-accepted sends, linked deliveries, human
  replies, warm replies, demos, wins, conversion rates, touch distribution,
  block reasons, evidence coverage, reply freshness, webhook proof, and restart
  state.
- Treat an unavailable read as unavailable. Never render a confident zero from
  a failed request.
- Keep existing Pipeline and Review Queue drill-down paths.

Exit evidence: frontend typecheck/build and existing visual guards pass; backend
evidence reads return 503 when any required source is incomplete.

### 8. Activate in controlled production stages

Activation was authorized and executed through cohort preparation. Prospect
sending deliberately remains paused under Patrick's no-customer-outreach
boundary.

1. **Done:** pause FGA autonomous first-touch and follow-up sending while
   retaining live Gmail reply synchronization.
2. **Done:** configure and verify the Resend webhook. Unsigned callbacks return
   401; one signed owner-only activation probe produced a real delivery receipt.
3. **Done:** apply migration `106_growth_pipeline_overhaul.sql` idempotently and
   probe every required table and column.
4. **Done:** deploy backend, worker, and web changes without resuming sending.
5. **Done:** backfill 4,999 privacy-minimized growth events.
6. **Done:** create, review, and activate seven-touch campaign version 2 without
   deleting legacy campaign records.
7. **Done:** write the canonical restart manifest. It contains 1,647 FGA leads:
   0 authorized, 1,541 needing evidence, and 106 excluded.
8. **Blocked correctly:** no manifest candidate is eligible, so no restart was
   applied and no draft was generated under restart authority.
9. Review gate results and a sample from every touch/personalization cohort.
10. Resume FGA prospect sends only when webhook proof, Gmail freshness,
    deliverability, tenant isolation, and rollback checks are green.
11. Start with a bounded cohort, then increase daily volume only after clean
    delivery and reply evidence. Pause immediately on any complaint, unsafe
    bounce rate, stale reply sync, unmatched provider state, or isolation doubt.

## Verification commands

All commands default to read-only unless an explicit write flag is shown.

```sh
npm test
npm run security:secrets
node scripts/bootstrap-seven-touch-campaign.js
node scripts/backfill-growth-events.js
node scripts/plan-fga-prospect-restart.js
node scripts/apply-fga-prospect-restart.js --batch=<BATCH_ID>
```

Production write forms require an exact FGA tenant confirmation and should be
copied from the activation packet rather than improvised.

## Rollback

1. Pause FGA autonomous sending first.
2. Stop newly created FGA restart enrollments by batch ID and preserve provider
   receipts; never delete evidence of a message already accepted.
3. Revert the API, worker, and web deployment to the captured baseline.
4. Keep the additive migration in place during ordinary rollback. It is inert
   with the feature path disabled and preserves evidence for diagnosis.
5. Use `db/rollbacks/106_growth_pipeline_overhaul_rollback.sql` only with a
   separate destructive-schema approval after exporting required evidence.
6. Re-run customer-tenant regressions and FGA provider/reply reconciliation
   before any later reactivation.

## Verified production receipt — 2026-09-06

- Backend and worker commit: `611871931d4700be47cd46fc5991bf60ea3b74f6`.
- Backend PRs: #7, #8, and #9. Web PRs: #3 and #4.
- Railway API and worker deployments succeeded; API health returned OK.
- Full backend suite: 1,400/1,400. Secret scan passed. Web build, safety guards,
  Vercel deployment, and cross-tenant CI passed.
- Signed Resend callback observed; Gmail reply cursor fresh; seven-touch plan
  active; migration and 4,999-event backfill verified.
- Authenticated production UI shows `Not ready`, `employee evidence provider
  rejected`, `no qualified inventory`, `0 authorized`, and `Paused`.
- `autosend_paused=true`, `drip_campaign_enabled=true`, and
  `drip_sends_paused=true` after deployment.
- No customer tenant was selected or modified. No prospect/customer email,
  SMS, voice call, notification, or other outreach was sent.

## Remaining production gates

- Replace the rejected Apollo credential. `APOLLO_API_KEY` is configured but
  Apollo's organization endpoint returns HTTP 401. The configured Hunter key
  also returns 401 and is not a fallback.
- Re-run a bounded evidence-recovery batch and require a domain-matched 1–9
  result. Fifteen current candidates have been checked; none produced a
  defensible employee count.
- Write a new manifest only after evidence exists, then apply a small eligible
  batch while both send switches remain paused. Review the generated copy and
  every gate receipt before any future send decision.
- Prospect send resumption remains outside this activation and is intentionally
  paused.
- Revenue remains Earned L1 until production proves repeatable qualified replies
  and at least one accepted demo outcome. Code completion does not raise it.
