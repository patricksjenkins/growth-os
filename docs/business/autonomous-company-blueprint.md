# Autonomous FGA Company Blueprint — v2 (evidence-based rebuild)

**Date:** 2026-07-24 · **Status:** Planning baseline · no new autonomy activated
**Primary deliverable:** `~/Desktop/FGA/dashboards/fga-operating-map.html` — interactive operating map (zoomable org chart, per-department and per-agent drilldowns, 10 views). This doc is the text record.
**v1 verdict:** superseded. v1 equated *an agent existing / a cron firing / a job returning success* with *the company having an autonomous capability*. The rebuild scores outcomes, not activity.

---

## 1. Which v1 claims were overstated (and the corrected verdicts)

| v1 claim | Verdict | Evidence |
|---|---|---|
| "FGA is already an agentic company at the specialist layer" | **Overstated** | Only **13 of 66** audited items are true AI agents (LLM doing open-ended work central to the job). 39+ are deterministic automations, workers, monitors, dispatchers, integrations, report generators, and surfaces. FGA is a well-automated **task layer** with thin AI — not an agentic org. |
| "Finance is 4/5" | **Wrong → Level 2** | The department's core product is *accurate numbers*, and owner-facing numbers were repeatedly wrong: incorrect MRR, broken period filters (forced the Financials rebuild), the concentration alert counting **1 paying client when 2 tenants had income** (prod query 07-24), Mercury double-import booking deposits as income. v1 graded run-reliability; data accuracy is the job. |
| "Client Success is 3.5/5" | **Overstated → Level 2** | v1 ignored two safety/quality incidents: the **cross-tenant email identity bleed** (P0) and repeated **923A inbound routing failures** (project messages failing to populate → full routing rebuild 07-21). Support is 100% manual. |
| "prospecting-orchestrator / client-health / financial-dashboard / operations-guardian are department-head skeletons" | **Reclassified** | Against the 13-duty head standard they perform 0–4 duties. Orchestrator = strongest *component* (snapshot, next-actions, supersession, invariants — never assigns work, manages capacity, enforces SLAs, or resolves exceptions). client-health = calculator. financial-dashboard = report generator. operations-guardian = monitor whose literal output on a broken agent was *"unclear root cause — needs human diagnosis."* |
| "~9,700 successful runs indicate readiness" | **Category error** | Outcomes over the same period: **0 demos ever booked, 0 interested leads ever, 1 reply from 177 sends, 47% of content rejected by the owner (15 posted / 15 rejected), a month-long silent drip outage, 13 silent prospecting failures, a zero-output agent reporting success on 100% of runs.** |

## 2. Reclassification summary (66 items)

**True AI agents (13):** outreach, prospecting, enrichment, reply-classification, targeted-campaign, invoice-scan, content-plan, content-generation, inbound-sms-responder, voice-receptionist (Vapi), conversation-responder, meeting-prep, advertising.
**Orchestration (2):** auto-outreach (11-gate engine + LLM judge — genuinely good), prospecting-orchestrator.
**Deterministic automations (~20), workers (5), monitors (7), dispatchers (3), integrations (5), report generators (5), user-facing surfaces (5), human-owned workflows (3).**
**Inactive / to retire (2):** past-customer-reengagement (sent:0 on every run in its life), distribution (superseded by Buffer cross-posting).
Full per-item audit — purpose, trigger, owns, runs, outcome truth, safety history, human dependency, verdict (keep/improve/merge/retire/build), confidence, evidence — lives in the interactive matrix (View 4).

## 3. Maturity (integer rubric; L0 missing → L5 autonomous)

| Department | Overall | Exec | Outcome | Data | Quality | Safety | Obs | Autonomy | Why |
|---|---|---|---|---|---|---|---|---|---|
| Sales | **L1** | 3 | **0** | 2 | 2 | 3 | 2 | 2 | 0 demos ever; weeks at 0 sends unnoticed; copy converts at 0.6% |
| Marketing | **L1** | 3 | 1 | 1 | 2 | 3 | 1 | 2 | 47% owner rejection; zero performance measurement; paid ads = L0 |
| Client Delivery & Success | **L2** | 4 | 2 | 3 | 3 | **2** | 2 | 3 | Runtime truly reliable (1,049/2,059/1,752 runs @100%) but email-bleed P0 + routing failures + manual support |
| Onboarding | **L2** | 3 | 3 | 3 | 3 | 3 | 2 | 2 | Two real go-lives; scheduler gotcha bit in prod; human steps by design |
| Finance & Back Office | **L2** | 4 | 3 | **2** | 3 | 3 | 2 | 2 | Executes reliably; data accuracy repeatedly failed in owner-facing surfaces (now test-pinned) |
| Platform Ops | **L1** | 4 | **1** | 2 | 2 | 2 | 2 | 1 | Missed the month-long wedge, the zero-output agent, 13 silent fails; guardian stacks duplicate incidents |
| Executive Office | **L1** | 2 | 1 | 2 | 2 | 3 | 2 | 1 | Digests are dumps; the escalation surface was 102 rows of noise until 07-24 |
| Product & Platform Dev (human-led) | **L3** | 4 | 4 | 3 | 3 | 3 | 3 | 2 | The unacknowledged strongest department: built everything; 341 tests + 3 guards; bus factor 1 |

**No department is above Level 2 in agent-run operation. No department heads exist. No Chief of Staff exists.**

## 4. Real current-state readiness — the honest one-liner

FGA has a **reliable execution substrate** (queueing, cron, caps, gates, tests, monitoring plumbing) and a **failing outcome layer** where it matters most (revenue), with a history of silent failures and data-accuracy defects that v1's run-counting missed. That substrate is genuinely valuable — it is what the leadership layer will stand on — but nothing about it is autonomous today.

## 5. Missing capabilities → owners (no new departments)

Revenue Operations → Head of Sales + CoS · AI Quality & Evaluation → Platform Ops (judge/vision-scorer are seeds) · Knowledge Mgmt → CoS (memory + runbooks are seeds) · Data Governance → Head of Finance (reconciliation tests are seeds) · Security/Privacy/Tenant Isolation → Platform Ops (post-incident guardrails are seeds; needs standing audit cadence) · Compliance/Legal → Patrick · Cross-dept Handoff Mgmt → CoS.

## 6. Revised organization

Patrick → **Chief of Staff Agent** (missing, Phase 2) → 6 AI department heads (all missing; build to the **13-duty standard**) + Product Dev (human-led by design) → 66 classified components. Heads launch **read-only** (coordinate, report, escalate); every write-action is earned individually behind config flags + caps + kill switches (the auto-outreach pattern). Full operating model per department — mission, outcomes, KPIs, decision authority (autonomous / CoS / Patrick), handoffs in/out, SLAs, blockers, tools, activation gates — is in the interactive map's department drilldowns.

## 7. Activation roadmap (entry-gated)

- **Phase 0 — stop the bleeding (days):** ICP config fix + validation guard · retire/repair the 2 zero-output items · work the 95-draft queue · copy-experiment v1 (pre-approved diffs) · one-open-condition rule applied to operations-guardian · zero-output detection v1.
- **Phase 1 — Head of Sales** (first true head; entry: Phase 0 done + `department_reports` table). Wire Cal.com.
- **Phase 2 — Chief of Staff** (entry: Head of Sales reporting ≥1 week).
- **Phase 3 — Head of Onboarding** (entry: a closed-won lead exists to onboard).
- **Phase 4 — Head of Client Success** (entry: 3+ active clients).
- **Phase 5 — Head of Marketing + paid ads** (entry: case-study material + Patrick's budget decision; gtag installed back in Phase 1 so conversion data accrues).
- **Phase 6 — Head of Finance** (entry: data-accuracy test coverage complete).
- **Phase 7 — Head of Platform Ops** (ongoing; entry: runbooks written from the real incidents).

## 8. Workflow changes requiring approval (recommendations only — nothing changed)

1. Retire `past-customer-reengagement` from the schedule (or approve a candidate-pool fix).
2. Retire `distribution` (already unscheduled; remove the file after sign-off).
3. Fix client-tenant ICP config + add config validation at agent start.
4. Apply the one-open-condition rule to operations-guardian (same fix threshold-alerts received 07-24).
5. Zero-output detection: N consecutive success-with-empty-output runs = DOWN.
6. Cold-email copy experiment (every prompt diff shown to Patrick first).
7. `department_reports` table + Head of Sales build (Phase 1 kickoff).

**Recommended first department: Sales** — it is the constraint on everything else, it is one repaired layer away from measurable (the machine sends; the copy doesn't convert), and every other phase's entry gate depends on it producing a customer.
