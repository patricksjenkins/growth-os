# Autonomous FGA Company Blueprint

**Date:** 2026-07-24 · **Status:** Approved planning baseline (no new autonomy activated)
**Visual version:** `~/Desktop/FGA/dashboards/autonomous-company-blueprint.html` (open that first — this doc is the operating text behind it)

---

## A. Executive summary

**What FGA is today.** A multi-tenant operating platform with **63 agent modules, 49 of which ran in production in the last 30 days** (~9,700 runs). Three live tenants (FGA itself, 923A Coins active, A Kut Above annual) plus the Apex demo. The specialist layer is genuinely strong: the delivery runtime (speed-to-lead, drip, notifications, dispatch) runs thousands of jobs a month at ~100% job success, finance closes itself weekly, and three monitoring agents already watch the platform.

**What is strong.**
- **Client delivery runtime** — speed-to-lead (1,049 runs/30d), drip (901), notifications (2,059), scheduled dispatch (1,752): all 100% job success. This is the product, and it works.
- **Finance & back office** — Mercury sync daily, invoice scan, bookkeeping, tax prep, churn detection, reconciled dashboards. Closest to autonomous today.
- **Monitoring plumbing** — system-monitor (dependency probes), operations-guardian (agent health), threshold-alerts (business thresholds), Agent Hub, Information Center, Day Activity. The observation layer exists; the judgment layer doesn't.

**What is weak.**
- **Outcomes vs. activity.** The sales machine produces activity, not results yet: 444 high-score prospects, 177 cold emails sent, **1 reply, 0 interested**. Every agent reports "success" while the department fails its actual KPI. `past-customer-reengagement` has *never sent anything* (`sent: 0` on 100% of runs) and still reports success. `prospecting` failed 13× on a client tenant over a missing ICP config and nobody was told.
- **Job-success ≠ outcome-success** is the systemic blind spot. The monitors watch whether agents *ran*, not whether they *achieved anything*.

**What is missing.**
- A **leadership layer**: nothing owns a department's number, coordinates its agents, or escalates by exception. Patrick is the de-facto head of every department.
- **Department scorecards** — outcome KPIs per department, tracked over time.
- A **consolidated executive brief** — platform-daily-digest is a status dump, not a decision queue.

**Highest-value next moves (in order).**
1. Sales hygiene (config fix, dead-agent fix, work the 95-draft review queue, reply-rate experiments) — days, not weeks.
2. Stand up the **Head of Sales Agent** on the prospecting-orchestrator skeleton.
3. Stand up the **Chief of Staff Agent** so Patrick manages the whole company from one brief.
4. Then Onboarding → Client Success → Marketing → Finance → Platform Ops, one at a time.

---

## B. The organizational structure

```
                     PATRICK (Owner)
      closes deals · onboarding calls · key approvals · relationships
                            │
                  CHIEF OF STAFF AGENT  ← to be built (Phase 2)
        one daily company brief · escalation routing · goal tracking
     ┌──────────┬──────────┬─┴────────┬──────────┬──────────┬──────────┐
   SALES     MARKETING   CLIENT     ONBOARDING  FINANCE   PLATFORM
                         SUCCESS      & IMPL    & BACK     OPERATIONS
                         & SUPPORT              OFFICE
   Head of   Head of     Head of     Head of    Head of   Head of
   Sales*    Marketing   Client      Onboarding Finance*  Platform Ops*
   (extend   (new thin   Success     (extend    (extend   (extend
   orchestr.) supervisor) (extend     onboarding financial- operations-
                          client-     -advance)  dashboard) guardian)
                          health)
   14 agents  10 agents   13 agents   3 agents+  9 agents   4 agents+
                                      human steps           shared svc
```
`*` = strongest existing skeleton to extend.

**Reporting cadence:** each Head produces a daily department report (facts + exceptions) and a weekly scorecard (KPIs vs. target). The Chief of Staff consolidates them into ONE morning brief with a decision queue. Only exceptions reach Patrick.

**Naming note:** the existing `chief-of-staff.js` agent is a per-tenant *owner-briefing/email* agent (module `email_chief`, internal-only). It becomes the **inbox arm** of the Executive Office; the company-coordinator Chief of Staff is a new, FGA-internal supervisory agent. Do not overload the old one.

---

## C. Department blueprints

### 1. Executive Office — Chief of Staff Agent
- **Mission:** Patrick runs the company from one brief and a short decision queue.
- **Owns:** company goals, cross-department dependencies, escalation SLA, the morning brief, meeting prep.
- **Existing assets:** platform-daily-digest (73 runs/30d), digest, meeting-prep (62 runs), Information Center, Day Activity panel, attention_queue (just cleaned: alerts must be live-computed, deep-link, act-in-place).
- **Autonomy level:** Mostly automated with owner review. Decides: report composition, escalation routing, priority ordering. Needs approval: anything customer-facing, money, strategy changes.
- **Gaps:** no department_reports store, no goal registry, no escalation SLA tracking, briefs are status dumps not decision queues.
- **Maturity: 1.5/5**

### 2. Sales — Head of Sales Agent
- **Mission:** keep a full calendar of qualified sales conversations for Patrick; nothing enters cold outreach that shouldn't; no lead stalls silently.
- **KPIs:** replies/wk, interested/wk, demos booked/wk, reply rate ≥2%, review-queue age < 48h, sends/day vs cap.
- **Specialists (14):** prospecting (⚠ 62% — ICP config), enrichment, scoring, outreach, auto-outreach, facebook-prospecting, outreach-cadence, drip-campaign, reply-classification, sales-nurture, meeting-prep (shared w/ Exec), targeted-campaign (idle by design), commercial-discovery (923A RFP), past-customer-reengagement (❌ zero-output), partner-outreach + referral-partner-finder (channel dev).
- **Skeleton to extend:** `prospecting-orchestrator` (84 runs/30d, 100%; already: funnel snapshot, next-best-actions, stall alerts, supersede stale drafts, sales invariants; never sends, never spends).
- **Head additions:** owns the KPI set; daily dept report; escalation when reply rate < target or queue stale; coordinates copy experiments (propose → Patrick approves prompt diffs); watches per-tenant config validity.
- **Owner's role:** approve drafts in Review Queue, take sales calls, approve prompt/copy changes.
- **Gaps:** reply rate (1/177 = the department's real problem — copy, not plumbing); ICP config validation; no demo-booking automation (Cal.com unwired); zero-output agent handling; handoff to Onboarding is manual.
- **Maturity: 2.5/5** — machine runs, doesn't convert yet.

### 3. Marketing — Head of Marketing Agent
- **Mission:** FGA (and every content-module tenant) visibly alive everywhere a prospect looks; content that produces inbound.
- **Specialists (10):** content-plan, content-concept-finalize, content-generation, image-generation, content-screenshot, content-visual-regenerate, publisher, approval-queue, distribution (unscheduled by design), advertising (weekly ad angles). Plus Marketing Studio (Sora video, owner-driven).
- **KPIs:** posts published/wk vs plan, approval latency, content→site sessions, ad angle tests run.
- **Head:** new thin supervisor — verifies plan→concept→draft→approve→publish chain completed each week, reports holes (concept not approved by Sunday, draft without image, publisher skipped).
- **Owner's role:** approve concepts + content (existing flows), record video when Sora pipeline asks.
- **Gaps:** **no paid-ads capability** — the advertising agent writes angles only; Meta Pixel is live but nothing can create/manage campaigns (no Meta Marketing API), Google Ads is entirely absent incl. site conversion tracking, no placement-spec creatives, no spend controls (see §F); no case-study engine (923A blueprint exists as seed material, unconverted); no content performance loop (posts go out, nothing reads engagement back).
- **Maturity: 3/5 organic · 1/5 paid**

### 4. Client Success & Support — Head of Client Success Agent
- **Mission:** every client visibly healthier every month; support answered inside SLA; churn caught before it happens.
- **Specialists (13):** the tenant-facing runtime — speed-to-lead, missed-call (webhook), inbound-sms-responder, voice-receptionist (webhook), conversation-responder, follow-up, review-request, referral-request, notification-push, notifications — plus client-health, churn-risk-detector, account-management, clients-manager, digest, reporting.
- **KPIs:** client health scores, product usage per tenant, support SLA (Growth 24h / Scale 4h), NPS-ish signal, churn saves.
- **Head:** extend `client-health` — it already scores; add playbook actions (yellow → re-engagement sequence, red → escalate), a monthly value report per client ("what FGA did for you this month" — the retention weapon), and support triage.
- **Owner's role:** relationship moments, escalated support, churn saves.
- **Gaps:** support inbox has no agent owner (manual, playbook exists); health playbooks don't fire actions; no per-client monthly value report; only 2 real clients so patterns unproven at scale.
- **Maturity: 3.5/5** (runtime excellent, management layer thin)

### 5. Onboarding & Implementation — Head of Onboarding Agent
- **Mission:** signed → live in 7 days, every time, with the premium feel intact.
- **Specialists:** onboarding-advance (73 runs/30d — the timeline machine), app-asset-pipeline, dfy-website-build, welcome-wizard core, admin endpoints (resend/refire/switch-path).
- **Deliberate human steps:** Day-5 onboarding call (the product), TestFlight build (local Mac + skill), Apple enrollment call (Path B).
- **KPIs:** days signed→live, wizard completion rate, steps blocked >24h, asset pipeline success.
- **Head:** extend `onboarding-advance` — it already advances stages; add SLA watching (step stuck >24h → escalate with the exact unblock action), auto-trigger from Sales closed-won, and a per-client go-live checklist report.
- **Gaps:** closed-won → onboarding trigger is manual; no stuck-step SLA alerts; TestFlight step depends on Patrick's Mac (acceptable, but should be *scheduled* by the head, not remembered).
- **Maturity: 3/5**

### 6. Finance & Back Office — Head of Finance Agent
- **Mission:** books always current, money always reconciled, taxes never a surprise, unit economics visible per client.
- **Specialists (9):** mercury-sync (daily), invoice-scan, bookkeeping, billing, financial-dashboard, tax-prep, audit-dry-run, nexus-monitor, threshold-alerts (+ Stripe webhooks).
- **KPIs:** unreconciled days, uncategorized txns, MRR truth (isBillingActive rule), margin per client, tax calendar adherence.
- **Head:** extend `financial-dashboard` + threshold-alerts into a weekly close report: what closed clean, what needs Patrick (categorizations, approvals), margin per client trend.
- **Owner's role:** approve expenses, categorize edge cases, file taxes.
- **Gaps:** margin per client not computed continuously; no monthly close checklist; Stripe-orphan linkage gap (known, documented).
- **Maturity: 4/5** — closest to autonomous.

### 7. Platform Operations — Head of Platform Ops Agent
- **Mission:** every agent healthy AND producing outcomes; incidents diagnosed, not just flagged; costs inside caps.
- **Specialists:** system-monitor (581 runs/30d), operations-guardian (568), monthly-usage-reset, scheduled-email-dispatch (shared outbox), usage caps layer, Agent Hub.
- **KPIs:** agent outcome-success (not just job-success), incident MTTR, cost per tenant vs cap, zero-output agents detected.
- **Head:** extend `operations-guardian` — its incident on past-customer-reengagement ("unclear root cause — needs human diagnosis") is the exact gap: it *flags* but cannot *diagnose*. Add outcome-aware checks (an agent that "succeeds" with zero output for N consecutive runs is DOWN), runbook-based diagnosis, and repeat-raise hygiene (same fix as threshold-alerts got today).
- **Gaps:** outcome-blindness; no runbooks; deploys human-only (fine); no error tracker (Sentry — later, optional).
- **Maturity: 3/5**

---

## D. Agent inventory (30-day production data)

Reliability = completed/total jobs, last 30 days. **Outcome flag** marks agents whose job success hides outcome failure.

| Agent | Dept | Trigger | Runs 30d | Job ok | Notes |
|---|---|---|---|---|---|
| scheduled-email-dispatch | Ops (shared) | hourly cron | 1752 | 100% | Outbox for all lifecycle email |
| speed-to-lead | CS runtime | event + hourly sweep | 1049 | 100% | Core product promise |
| notification-push / notifications | CS runtime | hourly | 2059 | 100% | App + owner notifications |
| drip-campaign | Sales | 30-min weekday cron | 901 | 100% | Wedge bug fixed 2026-07; self-heals |
| system-monitor | Platform Ops | 3-hourly | 581 | 100% | Dependency probes |
| operations-guardian | Platform Ops | 3-hourly | 568 | 100% | Flags but can't diagnose |
| reply-classification | Sales | 15-min cron | 528 | 100% | Feeds handoff + suggestions |
| prospecting-orchestrator | Sales | 3×/day | 84 | 100% | **Head of Sales skeleton** |
| platform-daily-digest | Exec | daily 6:30am | 73 | 100% | Becomes CoS input |
| onboarding-advance | Onboarding | daily 3am | 73 | 100% | **Head of Onboarding skeleton** |
| sales-nurture | Sales | daily 9am | 73 | 100% | Demo/trial cadences |
| review-request | CS runtime | daily 10am | 73 | 100% | |
| mercury-sync | Finance | daily 5am | 73 | 100% | Double-import gotcha documented |
| meeting-prep | Exec/Sales | 2×/day | 62 | 100% | |
| churn-risk-detector | CS | daily 8am | 60 | 100% | |
| threshold-alerts | Finance | daily 8:30am | 60 | 100% | Repeat-raise fixed 2026-07-24 |
| auto-outreach | Sales | 3×/day + Mon ramp | 54 | 100% | 11-gate autonomous sender |
| scoring / enrichment / follow-up | Sales/CS | weekday crons | 51 ea | 100% | Scoring starvation fixed 2026-07 |
| **prospecting** | Sales | daily 6am | 47 | **62%** | 13× missing ICP `target_states` (client tenant config); 3× Claude JSON parse |
| publisher | Marketing | weekday 9am | 45 | 100% | |
| facebook-prospecting | Sales | daily 2pm | 44 | 98% | |
| approval-queue | Marketing | weekday 1pm | 44 | 100% | |
| financial-dashboard | Finance | weekday 7am | 44 | 100% | |
| referral-request | CS runtime | daily 2pm | 43 | 100% | |
| outreach | Sales | daily 9am | 32 | 100% | Drafts only; personalization gate fixed |
| digest | CS/Exec | weekday 5pm | 22 | 100% | |
| commercial-discovery | Sales (923A) | daily | 19 | 100% | SAM.gov rate-limit rules apply |
| image-generation | Marketing | Mon/Thu | 13 | 100% | |
| partner-outreach | Sales channel | Tue/Thu + Mon | 13 | 100% | |
| **past-customer-reengagement** | Sales | Wed 9am | 12 | 100% | **`sent: 0` on every run ever — zero-output; fix or retire** |
| invoice-scan | Finance | Mon 7am | 12 | 100% | |
| clients-manager | CS | Mon 6am | 10 | 100% | |
| bookkeeping | Finance | Mon 6am | 8 | 100% | |
| account-management / client-health | CS | Mon | 6 ea | 100% | client-health = **Head of CS skeleton** |
| advertising | Marketing | Mon 7am | 6 | 100% | Angles generated, no spend loop |
| content-generation / content-plan | Marketing | weekly | 4 ea | 100% | Planner path live for FGA |
| reporting | CS | Fri 5pm | 4 | 100% | |
| billing / tax-prep / audit-dry-run / nexus-monitor / monthly-usage-reset | Finance/Ops | monthly/quarterly | 2 ea | 100% | |
| voice-receptionist | CS runtime | webhook (Vapi) | 1 | 100% | Event-driven; low call volume |
| inbound-sms-responder | CS runtime | webhook | 1 | 100% | |
| missed-call | CS runtime | webhook only | — | — | Removed from cron by design |
| conversation-responder | CS runtime | web chat event | — | — | Powers site chat |
| distribution | Marketing | unscheduled | — | — | Buffer cross-post made it optional |
| targeted-campaign | Sales | idle by default | — | — | Wakes only with active campaign |
| chief-of-staff (existing) | Exec (inbox arm) | 3×/day weekdays | — | — | Per-tenant briefing/email agent — NOT the company CoS |
| dfy-website-build / app-asset-pipeline | Onboarding | onboarding events | — | — | Fire during 7-day pipeline |
| content-screenshot / content-visual-regenerate | Marketing | on-demand | — | — | |
| outreach-cadence | Sales | 3×/day | — | 100% | Multi-touch cadence engine |
| commercial-finder | Sales (923A) | on-demand | — | — | |
| referral-partner-finder | Sales channel | on-demand | — | — | |

---

## E. Gap analysis (cross-department)

| # | Gap | Dept | Severity | Fix type | Depends on |
|---|---|---|---|---|---|
| G1 | Reply rate 0.6% (1/177) — copy doesn't convert | Sales | **Critical** | Process + prompt (approved diffs) | Draft-score analysis (done, awaiting approval) |
| G2 | No department heads: nobody owns a number | All | **Critical** | Agent (supervisory layer) | G3 |
| G3 | No department scorecard data layer | Exec/BI | **High** | Data (views + reports table) | — |
| G4 | Job-success ≠ outcome-success (zero-output agents invisible) | Platform Ops | **High** | Agent (outcome-aware guardian) | — |
| G5 | Client-tenant config validation (ICP missing → 13 silent fails) | Sales/Ops | **High** | Guard + config | — |
| G6 | No consolidated exec brief / decision queue | Exec | **High** | Agent (CoS) | G2, G3 |
| G7 | past-customer-reengagement never sends | Sales | High | Agent fix or retire | — |
| G8 | Closed-won → onboarding trigger is manual | Sales→Onb | Medium | Process + small trigger | — |
| G9 | Support inbox has no agent owner | CS | Medium | Agent (triage) | — |
| G10 | No demo-booking automation (Cal.com unwired) | Sales | Medium | Tooling | — |
| G11 | Health playbooks don't fire actions | CS | Medium | Agent wiring | — |
| G12 | No per-client monthly value report | CS | Medium | Agent + template | — |
| G13 | No case-study engine | Marketing | Medium | Process + agent | 30-60d client data |
| G14 | Content performance loop missing | Marketing | Low | Data + agent | Buffer analytics |
| G15 | No error tracker (Sentry-class) | Platform Ops | Low | Tooling (later) | — |
| G16 | Onboarding stuck-step SLA alerts | Onboarding | Medium | Agent wiring | — |
| G17 | **No paid-ads capability** — angles only; no Meta Marketing API, no Google Ads, no placement-spec creatives, no spend controls | Marketing | **High** | Tooling + agent + in-house creative pipeline | G18; owner budget decision |
| G18 | Google conversion tracking absent from site (gtag); Meta CAPI env vars unverified on Railway | Marketing | Medium | Tooling (small, do early — data accrues) | — |

---

## F. Tech stack additions

**Nothing new is required for Phases 0–2** (the leadership layer is reads, reports, and coordination on existing infrastructure). **Paid advertising is the exception** — corrected 2026-07-24 after owner review: the original claim understated Marketing. The `advertising` agent only writes ad *angles*; there is no ad-platform integration anywhere in the codebase.

**Paid-ads reality check (verified in code + live site):**
- ✅ Meta Pixel — LIVE on firstgenautomate.com (ID substituted in prod build; audiences accruing now)
- ✅ Meta CAPI — `integrations/meta-capi.js` wired to Stripe purchase events (needs `META_PIXEL_ID` + `META_CAPI_TOKEN` on Railway — verify)
- ❌ Meta Marketing API — no campaign/adset/ad creation, no audience mgmt, no budget control. Buffer is organic-only
- ❌ Google Ads — nothing: no account integration, no API, and **zero `gtag`/conversion tracking on the site**
- ❌ Placement-spec ad creatives — no 1:1/4:5/9:16/1.91:1 renders, no RSA text limits (15 headlines ≤30 chars, 4 descriptions ≤90)
- ❌ Spend safety layer — no budget caps, kill switch, or approval gate for money

| Addition | Category | When | Why |
|---|---|---|---|
| `department_reports` table + scorecard SQL views | Data layer (build in-house) | **Phase 1** | Heads need somewhere durable to write daily/weekly reports; CoS reads it |
| Goal/KPI registry (`tenant_config` or small table) | Data layer | Phase 2 | CoS tracks targets vs. actuals |
| Cal.com (free tier) | Scheduling | Phase 1-2 | Demo booking without email ping-pong; already in the GTM plan |
| **Google tag + conversion tracking on the site** | Ads infra | **Phase 1-2 (early — data accrues)** | Without conversion signal, Google Ads can never optimize; install long before spending |
| **Meta Business Manager + Marketing API** | Ads infra | Phase 5 | Create/manage FB+IG campaigns programmatically; Pixel is live but nothing can *place* ads |
| **Google Ads account + API (or Editor to start)** | Ads infra | Phase 5 | Search intent ("missed call text back", "answering service") is the highest-intent channel FGA has no presence on |
| **Ad-creative pipeline at placement specs** | Build in-house | Phase 5 | Extend the existing sharp compositor + safe-area gate + AI-vision scorer to ad sizes and text limits — the machinery exists, the ad shapes don't |
| **Spend safety layer** (budget caps, kill switch, approval gate) | Build in-house | **Before first paid campaign** | Money is the one thing no agent touches autonomously; reuse the auto-outreach gate pattern |
| Ad performance pull (spend/CPC/CPA → Head of Marketing) | Integration | Phase 5 | Heads report outcomes; ads without a readback loop are outcome-blind |
| Buffer analytics pull | Integration | Phase 5 | Close the organic content performance loop |
| Sentry (or Railway log alerts) | Observability | Later, optional | ops-guardian polling covers today's scale |
| Vector/memory store | AI infra | **Not yet** | No current workload needs it; revisit with support KB |
| External BI tool | Analytics | **No** | Command Center IS the BI surface; keep it that way |

---

## G. Phased roadmap — one department at a time

**Phase 0 — Sales hygiene (days).** Fix client-tenant ICP config + add config validation guard (G5); fix or retire past-customer-reengagement (G7); work the 95-draft Review Queue down; run the approved-diff copy experiment for reply rate (G1). *Success: reply rate ≥2% on next 100 sends; zero silent agent failures.*

**Phase 1 — Head of Sales (1-2 weeks).** Extend prospecting-orchestrator: owns KPIs, daily report to `department_reports`, escalation rules, config watching. Wire Cal.com. *Success: Patrick touches sales only via Review Queue + calls; one daily sales report; stalls escalate themselves.*

**Phase 2 — Chief of Staff (1-2 weeks).** New FGA-internal supervisory agent: reads department_reports + attention_queue + Information Center; produces ONE morning brief with decision queue; tracks goals; routes escalations with SLA. Existing chief-of-staff.js becomes the inbox arm. *Success: Patrick starts the day from one brief; nothing critical is ownerless.*

**Phase 3 — Head of Onboarding.** Auto-trigger from closed-won (G8), stuck-step SLA (G16), TestFlight scheduling prompts. *Success: signed→live ≤7 days without Patrick remembering anything.*

**Phase 4 — Head of Client Success.** Health playbooks fire actions (G11), support triage (G9), monthly value report per client (G12). *Success: churn risks get plays before Patrick hears about them; support SLA tracked.*

**Phase 5 — Head of Marketing.** Chain-completeness watching, case-study engine (G13) once 923A has 30-60d data, content performance loop (G14), and **stand up paid ads** (G17): Meta Business Manager + Marketing API, Google Ads account + conversion tracking (install gtag in Phase 1-2 so data accrues first), placement-spec creative pipeline on the existing compositor, spend safety layer before the first dollar. Agents draft campaigns and creatives; **Patrick approves every budget and every campaign launch.** *Success: weekly content ships itself; first case study live; first ad campaign live with conversion tracking proving CPA.*

**Phase 6 — Head of Finance.** Weekly close report, margin per client, close checklist. *Success: monthly close is a 15-minute review.*

**Phase 7 — Head of Platform Ops.** Outcome-aware monitoring (G4), diagnosis runbooks, incident MTTR tracking. *Success: a zero-output agent is detected in ≤2 runs, with a diagnosis attached.*

**Standing constraint for every phase:** heads coordinate and report first; they earn write-actions gradually, each new autonomy gated behind the same pattern as auto-outreach (explicit config flag + caps + kill switch + audit trail).

---

## Design rules for Department Head agents (apply to all)

1. **Never send, never spend** in v1 — read, coordinate, report, escalate. Autonomy is earned per-action behind config flags.
2. **Outcome KPIs, not run counts.** A head reports "0 replies this week against target 5", never "34 jobs completed".
3. **Escalate by exception with a deadline and a deep link** — every escalation lands somewhere Patrick can act (the Review Queue pattern, not the Growth-Engine-dead-link pattern).
4. **One open condition = one alert** (threshold-alerts repeat-raise rule, 2026-07-24).
5. **All state in Supabase** (department_reports, attention_queue, tenant_config) — no side-channel memory.
6. **Tenant scope discipline** — heads are FGA-internal; client data flows only through the already-approved summary surfaces.
