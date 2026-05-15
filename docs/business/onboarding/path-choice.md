# Two-Path App Delivery — Customer Chooses (v1, 2026-05-15)

Every new client picks one of two paths for how their branded iOS app
is published. The product, price, and experience are identical once
the app is live — the difference is **who owns the Apple Developer
account** and **how much customer involvement** the first week
requires.

This document is the source of truth for what each path means, when
to recommend which, and the implementation differences across the
pipeline.

For 7-day timing and step-by-step, see `client-onboarding-runbook.md`.

---

## The Two Paths

### Path A — Managed (FGA Developer Account)

> **Customer-facing name:** "Quick Start — we handle everything"

The app is published under **First Gen Automate's** Apple Developer
account. The customer never touches Apple. FGA pays its single $99
annual fee (covers up to 200 apps total). Each app must be
materially differentiated from every other app under the FGA account
to clear Apple Review Guideline 4.2.6.

**Best for:**
- Owners who are not technically comfortable
- Owners with limited time / preference for "just make it happen"
- Older owners (think: Patrick's mom setting up A Kut Above)
- Anyone who'd rather pay for service than do their own paperwork

### Path B — Owned (Customer's Developer Account)

> **Customer-facing name:** "Full Ownership — your account, your app"

The app is published under the **customer's own** Apple Developer
account. FGA enrolls as Admin and does all the work after that. FGA
pays the customer's $99/yr Apple Developer fee out of setup-fee
margin.

**Best for:**
- Tech-comfortable owners who want infrastructure ownership
- Multi-location businesses with their own IT thinking
- Owners who want their developer account as a portable business asset
- Younger owners who live in their phone and aren't intimidated by
  Apple's UI

---

## Side-by-Side

| Aspect | Path A (Managed) | Path B (Owned) |
|---|---|---|
| Apple Developer account owner | FGA | Customer |
| Customer time required Day 1 | 0 minutes | ~25 minutes (Apple enrollment call) |
| Calendar time to first install | **3–5 days** | 5–7 days (adds Apple business verification wait) |
| Apple business-verification wait | None (FGA already verified) | 1–2 days |
| Day-1 enrollment call needed | No | Yes (founder personally walks customer through) |
| Customer ever logs into Apple | Never | Once on Day 1 + once on Day 2 (add FGA as Admin) |
| Customer owns the app if they leave | No — FGA controls binary | Yes — bundle stays in customer's account |
| Cancellation behavior | App removed from App Store, OR auth-gated to "subscription ended" screen | Auth-gated to "subscription ended" screen; binary stays in customer's account |
| 4.2.6 rejection risk | **Real — managed via differentiation audit** | Very low (one app per account = no template-service signal) |
| Per-customer Apple fee | $0 (covered by FGA's single $99) | $99/yr per customer (FGA pays from setup margin) |
| First-year COGS impact for FGA | None | -$99 |
| Sticky moat strength | Higher (FGA can pull app entirely) | Slightly lower (customer's account survives, just inert) |
| Bundle ID pattern | `com.firstgenautomate.<slug>` | `com.<customerco>.app` |

---

## Customer-Facing Choice

Presented inline in the Day 0 mobile intake form, after the customer
fills out basic business info. Decision is captured to
`tenant_config.delivery_path` ∈ `{ managed, owned }`.

### Recommended UI (mobile web)

```
┌─────────────────────────────────────────┐
│  Last question: how do you want         │
│  your app published?                    │
│  ─────────────────────────────────────  │
│                                         │
│  ● Quick Start                          │
│    (recommended for most)               │
│                                         │
│    We publish your app under our        │
│    Apple developer account. Live in     │
│    3–5 days. Zero Apple paperwork on    │
│    your end.                            │
│                                         │
│  ○ Full Ownership                       │
│                                         │
│    Your app lives in your own Apple     │
│    developer account — you own it       │
│    forever, even if you ever leave.     │
│    Live in 5–7 days. Takes one          │
│    25-minute call with us to get        │
│    Apple's enrollment done.             │
│    Your $99 annual Apple fee is         │
│    included in your setup fee.          │
│                                         │
│  [        Save my choice         ]      │
│                                         │
│  (You can change paths later — let us   │
│   know within 30 days.)                 │
└─────────────────────────────────────────┘
```

### Founder Recommendation Logic

Patrick should recommend a path on the close call based on signals
during the conversation:

| Signal | Recommend |
|---|---|
| Owner used the word "I'm not very techy" | Path A (Managed) |
| Owner is 60+ and Apple ID confusion comes up | Path A (Managed) |
| Owner currently uses a flip phone, prints emails, or asks how to attach a PDF | **Path A always** |
| Owner asks "do I get to keep the app if I leave?" | Path B (Owned) — they're already thinking ownership |
| Owner runs multiple businesses or has any kind of IT vendor | Path B (Owned) |
| Owner mentions their developer-friend or has worked in tech | Path B (Owned) |
| No clear signal | Default the form to Path A; let them switch on the intake page |

Don't push hard. Both paths produce the same outcome from the
customer's perspective: a real App Store app with their brand on it.
The choice is about how much paperwork they want to do.

---

## Path A — 4.2.6 Risk Management (CRITICAL)

Apple's Section 4.2.6 specifically targets "commercialized templates."
A single developer account submitting many similar apps is the exact
trigger. **Path A only works if we differentiate aggressively.**

### Mandatory differentiation per Path A submission

Every app submitted under FGA's developer account must pass these
checks **before** submission. The `audit-426-compliance.js` script
enforces them:

| Differentiator | Requirement |
|---|---|
| App icon | Generated uniquely per customer (Gemini, seeded with their brand + vertical) — hash must differ from every other FGA-account icon |
| App name | Customer's business name (NOT "FGA" or anything FGA-branded) |
| Bundle ID | `com.firstgenautomate.<tenant_slug>` — unique within FGA's account |
| Launch screen | Per-customer splash with their colors + logo |
| App Store screenshots | Generated from the real running app with the customer's own tenant data (not lorem ipsum) |
| Listing description | 500+ chars, mentions customer business name 2+ times, vertical 1+ times, service area 1+ times |
| Keywords | Vertical-specific (HVAC / plumbing / roofing / etc.) |
| Privacy URL | Resolves to a page that names the customer's business |
| Support URL | Resolves to a page that names the customer's business |
| Subtitle | Customer-specific (not generic) |

### Why customer-specific functionality already counts

Apple's reviewer launches the app and looks for "real functionality."
Each branded app on Path A shows the customer's own:
- Their actual leads in the pipeline
- Their actual job-site photos
- Their actual scheduled content
- Their actual review requests pending

That is **real customer-specific data** = functional differentiation
beyond just the wrapper. This is the main reason Path A is defensible
under 4.2.6: each app isn't a hollow template, it's a customer-data-
specific business app.

### Soft Path-A rules to reduce review risk

- Submit no more than 2 Path-A apps in any 48-hour window. Spacing
  reduces the appearance of a template factory.
- Vary the "What's New" text on each launch — don't ship 5 apps with
  identical changelog copy.
- If FGA's developer account ever receives a 4.2.6 rejection, stop
  submitting new apps until the cause is diagnosed and the audit
  script is updated.

### Path-A rejection scenario

If Apple does reject a Path-A app on 4.2.6 grounds:
1. Read the exact rejection text (Apple usually tells you what they
   want).
2. Fix the cited issues — typically: more screenshots, more unique
   listing copy, more differentiated icon.
3. Resubmit. Re-review is usually faster (12-24 hours).
4. If a second rejection comes on 4.2.6 for the same app, **switch
   that customer to Path B.** Don't keep fighting it.

This is why the customer-facing language describes Path A as "5 days"
not "1 day" — it gives breathing room for a rejection cycle.

---

## Path B — The Enrollment Call (CRITICAL)

The 25-minute Apple enrollment call is the one premium-feel moment of
the Owned path. It needs a script so every founder-led call runs
cleanly. The script is in `client-onboarding-runbook.md` under "Day 1
Track A."

### What Apple absolutely will not let FGA do

- Create the customer's Apple ID (they must do it themselves under their name)
- Sign the Apple Developer Program License Agreement (legal signatory only)
- Enter the customer's legal business information into the enrollment form
- Approve their D-U-N-S issuance

### What FGA can do during the call

- Walk customer screen-by-screen via screen-share
- Read out their pre-collected intake data (business name, address,
  EIN if provided) so they don't have to remember
- Pay the $99 enrollment fee using FGA's card (Apple's portal accepts
  any valid card from the person logged in)
- Stay on the line until the "Enrollment submitted" confirmation appears

### Post-approval (Day 2)

When Apple's approval email lands, an automated SMS goes to the
customer:

> Hi [Name] — Apple approved your developer account. Two quick taps
> to wrap this up:
> 1. Open this link → [App Store Connect Users page]
> 2. Tap "Add User," type `patricksj@hotmail.com`, role Admin. Done.
>
> 2 minutes max. Then I have everything I need to ship your app.

That's the only Apple touchpoint after Day 1. Patrick takes over the
build, the listing, the TestFlight invite, the App Store submission.

---

## Switching Paths Mid-Lifecycle

Customers can switch paths within **30 days of contract signing** at
no extra cost. Reasons it happens:

| Switch | Reason | What FGA does |
|---|---|---|
| Path A → Path B | Customer wants to own it after seeing the app live | Help them enroll their own developer account; transfer app via App Store Connect "Transfer App" feature (takes 1-3 days) |
| Path B → Path A | Customer is stuck on Apple enrollment, getting frustrated | Cancel their in-progress enrollment, re-submit app under FGA's account |

After 30 days, path switches are evaluated case-by-case (transfer is
real work, especially in either direction).

---

## Pipeline Script Behavior By Path

The three Phase 1 pipeline scripts (`scripts/app-pipeline/`) accept a
`--path managed|owned` flag (default: `owned` for backward compat).
Behavior differences:

### `generate-app-assets.js --path <managed|owned>`

| Aspect | Managed | Owned |
|---|---|---|
| Icon prompt | Same Gemini prompt — uniqueness is the goal regardless | Same |
| Listing copy | Same Claude prompt — customer-specific copy | Same |
| Hash uniqueness check | **Stricter** — must differ from all other FGA-account icons | Lighter — just must differ from FGA-internal icon |

### `patch-build-config.js --path <managed|owned>`

| Aspect | Managed | Owned |
|---|---|---|
| Bundle ID pattern | `com.firstgenautomate.<slug>` | `com.<slug>.app` |
| Team ID in build config | FGA team `6Y8873V85M` | Customer's team ID (from `tenant_secrets.apple_team_id`) |
| App backup file name | `app.json.fga-default` | Same |

### `audit-426-compliance.js --path <managed|owned>`

| Aspect | Managed | Owned |
|---|---|---|
| Icon hash uniqueness | **Hard fail** if matches any other tenant or FGA-internal | Soft warn if matches another tenant |
| Listing description differentiation | Stricter thresholds (longer, more specific) | Standard thresholds |
| "Sibling app" submission timing check | Warn if another Managed app was submitted within 48 hours | N/A |

---

## Pricing Decision (open question)

Both paths currently are the same $1,000 setup fee. Two arguments:

**Argument for same price:** keep the choice purely about preference.
Don't make customers pick the "cheap" path or feel they're "missing
out" on the premium path.

**Argument for Path B premium:** FGA bears -$99/yr COGS forever.
Maybe Path B = $1,099 to recover first year, $1,000 after — but
that's confusing.

**Recommendation:** keep both at $1,000. Bake the Path-B $99 into
margin. The mix shift (most customers pick Path A initially → Path B
penetration grows over time) is fine for unit economics.

Revisit after first 10 customers if Path B disproportionately
attracts higher-margin segments.

---

## Telemetry — What to Track After Launch

| Metric | Path A | Path B |
|---|---|---|
| Pick rate | % new customers who choose this path | (same) |
| Time-to-first-install | Days from contract to TestFlight install | (same) |
| Apple 4.2.6 rejection rate | Rejections / submissions | Expected: ~0 |
| Switch-out rate | % who switch path within 30 days | (same) |
| Retention at 6 months | Cohort retention | (same) — hypothesis: Path B retains slightly higher because of perceived ownership |

If 4.2.6 rejection rate on Path A exceeds **15%** of submissions, the
path becomes uneconomical (too much resubmission work) and should be
deprecated.
