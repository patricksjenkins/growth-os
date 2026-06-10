# AI Safety System — Final Change Summary (Release 1: Monitoring Only)

Date: 2026-06-10. Status: **implemented + locally tested, NOT deployed.** Nothing
is committed, pushed, or applied to production. No hard enforcement is enabled.

---

## 1. Audit findings

**AI call sites (text):** Two wrappers are the only chokepoints —
`integrations/claude.js` (the sole Anthropic SDK instantiation) and
`integrations/gemini.js` (Gemini via axios). ~36 files call AI, all through
those wrappers. `api/routes/chat.js` previously instantiated its own Anthropic
client; it now routes through the shared `callClaude` (pace-gate + retry +
tracking).

**Media call sites:** Sora/Veo/Gemini-image are separate quota-limited APIs,
not the Sonnet limit. Gemini image + analyze now emit monitor-only usage events.

**Queue / job creation:** ~40 in-repo enqueue sites. All insert **one job per
event** (webhooks, captures, user actions) or a single bounded agent job.
**Nothing in the repo bulk-enqueues 100+ jobs.** The 2026-06-09 burst came from
**off-repo hand-run scripts** that insert directly into `agent_jobs` —
`apify_email_one_shot_2026-06-09` (68) + `fb_fallback_one_shot_2026-06-09` (36).
Neither reason string exists in the codebase. No self-enqueue, recursion, or
unbounded loops found. Job processor (`worker/jobs/processor.js`) is sequential,
3 jobs / 10s, and marks failures terminal (no requeue → no queue-retry
multiplication).

**Runtime / replicas:** `npm start` runs `api/server.js`, which registers all
agents and starts the scheduler + job processor **in-process**. `worker/index.js`
just requires `api/server.js`. Railway runs an `api` service AND a `worker`
service, both loading this file; duplicate cron/processor is prevented ONLY by
setting `SCHEDULER_ENABLED=false` + `JOB_PROCESSOR_ENABLED=false` on the
secondary service. **Action: confirm those are set on the worker service — if
not, every cron and job runs twice.** API + worker are separate processes
sharing one `ANTHROPIC_API_KEY`/`GOOGLE_API_KEY`, so the in-memory pace gate is
**per-process** and resets on restart — which is why the persistent
`ai_usage_events` ledger (not memory) is the authoritative counter.

## 2. Root cause assessment

104 single-lead outreach jobs hand-enqueued at the same instant → the processor
drained them, each outreach draft calling `askClaudeJSON`. **Retry
multiplication** turned ~104 logical drafts into ~800+ provider HTTP attempts:
Anthropic SDK default retries (≈3 attempts) × `withRetry` (3) × `askClaudeJSON`
outer loop (3) = **up to 27 HTTP attempts per logical op** on sustained 429s.
104 × ~8 ≈ 832 ≈ the **847** rate-limit hits observed.

## 3. Retry analysis (Phase 9)

| Layer | Attempts | Notes |
|---|---|---|
| Anthropic SDK (default `maxRetries`) | ~3 | **not configured → invisible amplifier** |
| `withRetry` (`integrations/_retry.js`) | 3 | honors Retry-After |
| `askClaudeJSON` outer loop | 3 | re-calls on ANY error incl. provider errors |
| Worker/queue requeue | 0 | failed = terminal |
| node-cron | 0 | no retry |

Worst case logical op = 3×3×3 = **27**. Policy target = **3**.
**Top recommended fix (1 line each, not yet applied):** set `maxRetries: 0` on
the Anthropic client so `withRetry` is the single authority, and make
`askClaudeJSON` re-call only on JSON-parse errors (not provider/network errors).
Collapses 27 → 3. Every attempt now counts toward usage totals via
`guard.afterCall` (recorded at the `withRetry` level).

## 4. Files changed / added

**Active behavior change (already present from the incident fix):**
- `integrations/claude.js` — pace gate, `callClaude` exported, **guard wired
  (monitor-only)**, per-attempt usage recording, full option pass-through in
  `askClaudeJSON`.
- `api/routes/chat.js` — routes through shared `callClaude` with human-initiated
  metadata.
- `integrations/gemini.js` — monitor-only usage recording on image + analyze.
- `api/server.js` — mounts `/api/admin/ai-safety`.

**New (safety layer — present, dormant until flags flip):**
- `core/ai-safety/flags.js` — flags + thresholds + state snapshot.
- `core/ai-safety/usage-tracker.js` — `recordUsage`, `countCalls`, `sumCostUsd`.
- `core/ai-safety/switches.js` — kill switches + circuit breakers + audit.
- `core/ai-safety/events.js` — event log + alert dedup/cooldown.
- `core/ai-safety/guard.js` — `beforeCall`/`afterCall` orchestrator + threshold eval.
- `core/ai-safety/idempotency.js` — deterministic outreach key + duplicate detect.
- `core/ai-safety/guarded-enqueue.js` — batch-tracked enqueue.
- `core/ai-safety/overview.js` — dashboard aggregation.
- `api/routes/admin-ai-safety.js` — overview API + manual switch/batch controls.
- `db/migrations/046_ai_safety_foundation.sql` (+ `_rollback.sql`).
- `test/ai-safety/safety.test.js` + `fake-db.js`.
- `.env.example` — documented all new vars.

## 5. Database migrations

`046_ai_safety_foundation.sql` — **additive only, written but NOT applied.**
New tables: `ai_usage_events`, `ai_safety_switches`, `ai_safety_switch_audit`,
`ai_safety_events`, `ai_job_batches`; one **nullable** `agent_jobs.batch_id`
column. No constraints/backfills on existing data, **no unique constraints**
(duplicate audit must precede them). RLS + tenant-iso policies mirror
`043_outreach_batches`. Rollback drops only the new objects.

## 6. New env vars / defaults / flag behavior

See `.env.example`. **Observability** (`AI_USAGE_TRACKING_ENABLED`,
`AI_MONITOR_MODE_ENABLED`, `AI_ALERTS_ENABLED`) default **ON** (on unless
`=false`). **All enforcement** flags default **OFF** (off unless `=true`). A
missing var never blocks traffic. Thresholds documented with defaults.

## 7. Test results

`node --test "test/**/*.test.js"` → **33 pass / 0 fail** (15 new safety + 18
pre-existing, no regressions). Coverage: safe-default contract, flag
independence, usage recording + untracked flag, tracking-off no-write, switch
monitor-vs-enforce + human exemption, guard allow-in-monitor + block-when-enforced,
threshold breach logged-not-enforced, guarded-enqueue (104→1 batch; approval hold),
duplicate detection.

**Runaway simulation:** 104 single-lead jobs recorded as ONE batch; two
"workers" (separate clients, shared store) accumulate into the same ledger;
threshold + per-lead breaches detected; counts survive a simulated restart;
**every event `enforced:false` and `beforeCall` still allows** — i.e. monitor
mode interrupts nothing.

## 8. Status breakdown

**Implemented & ACTIVE (once deployed):** pace gate; chat.js shared routing;
provider-wrapper usage recording (monitor); dashboard API; manual switch/batch
controls (records only until enforcement on).

**Implemented but DISABLED (flag-gated off):** all threshold *blocking*, circuit
breakers, kill-switch enforcement, idempotency blocking, queue limits, batch
approval gating, cost enforcement, strict metadata.

**Recommended, NOT yet implemented:** (a) Anthropic `maxRetries:0` +
`askClaudeJSON` provider-error no-retry; (b) migrate hand-run backfill scripts
to `guardedEnqueue`; (c) Redis/Postgres distributed limiter (Phase 12) for true
cross-process rate limiting; (d) React owner dashboard UI consuming
`/api/admin/ai-safety/overview`; (e) external alert delivery (email/SMS) — the
durable `ai_safety_events` 'alert' rows + dedup exist; (f) per-job runtime/loop
caps inside agents.

## 9. Remaining bypasses & known limitations

- Hand-run scripts inserting directly into `agent_jobs` bypass guarded enqueue
  until migrated.
- Pace gate is per-process/in-memory (resets on restart, not shared across the
  api+worker processes) — distributed limiter needed for hard cross-process caps.
- SDK-internal retries aren't individually counted (only `withRetry`-level
  attempts are) until `maxRetries:0` is set.
- `ai_usage_events` grows unbounded — add a retention/rollup job before enabling
  heavy querying at scale.

## 10. Rollback

Code: revert the listed files. DB: run `046_..._rollback.sql` (drops only new
objects; existing data untouched). Flags: unset the `AI_*` vars (safe defaults
keep monitoring on, enforcement off).

## 11. Recommended order to enable enforcement

R1 (now): `AI_USAGE_TRACKING_ENABLED`, `AI_MONITOR_MODE_ENABLED`,
`AI_ALERTS_ENABLED` — validate counts/cost/metadata/false-positives.
R2: manual kill-switch / breaker / batch controls (no auto-blocking).
R3 (low-risk): per-job call cap, retry cap, verified-stage duplicate blocking,
large-backfill approval. R4 (shared): distributed limits, auto circuit breakers,
cost hard-stop, strict metadata — only after multi-process testing.
**Advance one release at a time, with test results + approval at each gate.**
