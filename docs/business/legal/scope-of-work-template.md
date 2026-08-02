# Scope of Work Template — First Gen Automate LLC

> **Internal template.** One SOW is executed per Client at signup. It
> attaches to the Master Services Agreement (MSA) and captures the
> specifics of what that Client gets, on what timeline, at what price.
>
> Fill in the `[BRACKETS]` before sending. Tier-specific defaults are
> pre-filled where possible.

---

# Scope of Work

**This Scope of Work ("SOW") is entered into pursuant to the Master Services Agreement dated [MSA EFFECTIVE DATE] between First Gen Automate LLC ("Provider") and [CLIENT LEGAL NAME] ("Client"). In the event of any conflict between this SOW and the MSA, the MSA controls.**

| | |
|---|---|
| **SOW Number** | [SOW-YYYY-NNN] |
| **SOW Effective Date** | [DATE] |
| **MSA Reference** | Master Services Agreement dated [MSA EFFECTIVE DATE] |
| **Client** | [Client Legal Name] |
| **Client Vertical** | [Tree Service / Plumbing / Benefits Consulting / etc.] |
| **Client Business Address** | [Address] |
| **Client Primary Contact** | [Name], [Email], [Phone] |

---

## 1. Services

### 1.1 Tier

Client subscribes to the following tier:

- ☐ **Growth** — $199 one-time setup + $249/month — any 7 of 15 modules
- ☐ **Scale** — $199 one-time setup + $399/month — all 15 modules
- ☐ **Complimentary** — friends/family or proof-of-concept tenant; no recurring fee. Internally flagged `tenant_config.is_complimentary = true`.

### 1.2 Modules Included

[Mark the modules Client is opting into. Growth picks 7. Scale gets all 15.]

| # | Module | Included? |
|---|---|---|
| 1 | Lead Capture & CRM | ☐ |
| 2 | Speed-to-Lead (instant SMS) | ☐ |
| 3 | Missed Call Text-Back | ☐ |
| 4 | Follow-Up Sequences | ☐ |
| 5 | Content Engine (AI post generation) | ☐ |
| 6 | Content Approval & Scheduling | ☐ |
| 7 | Review Requests | ☐ |
| 8 | Branded Mobile App + Web Portal | ☐ |
| 9 | AI Voice Receptionist *(Scale only)* | ☐ |
| 10 | Referral Engine | ☐ |
| 11 | Referral Partner Outreach | ☐ |
| 12 | Prospecting Engine | ☐ |
| 13 | Lead Scoring | ☐ |
| 14 | Done-For-You Website | ☐ |
| 15 | AI Chat Agent | ☐ |

### 1.3 Volume Limits

Client's tier-specific volume limits apply per https://firstgenautomate.com/volume-limits. Notable monthly caps for this Client's tier:

- SMS per month: [500 Growth / 1,000 Scale]
- Email sends per month: [500 Growth / 2,000 Scale]
- Telnyx voice minutes per month: [1,000 Growth / 2,000 Scale]
- Voice Receptionist minutes per month: [N/A Growth / 200 Scale]
- Automated social media posts per month: [15 Growth / 30 Scale]
- Gemini image generations per month: [50 Growth / 100 Scale]
- Anthropic Claude spend per month: [$10 Growth / $25 Scale]

---

## 2. Onboarding Path

Client's branded mobile app delivery path:

- ☐ **Quick Start (Managed)** — App published under First Gen Automate LLC's Apple Developer account. Live in 3-5 days.
- ☐ **Full Ownership (Owned)** — App published under Client's own Apple Developer account. FGA pays the $99/yr Apple fee from setup margin and enrolls as Admin on Client's account. Live in 5-7 days. Client commits to one 25-minute Day-1 enrollment call.

### 2.1 Timeline (7-day target)

| Day | Milestone |
|---|---|
| 0 | SOW + MSA signed; setup fee charged via Stripe; tenant provisioned; welcome email sent |
| 0-1 | Client completes onboarding wizard (mobile or web) |
| 1 | Day-1 modules go live (Lead Capture, Speed-to-Lead, etc.); branded app icon + listing generated |
| 1-3 | Provider builds + tests TestFlight version of the branded app |
| 4-5 | App Store submission; Day-5 onboarding video call (30 min) |
| 5-7 | App Store approval; app live in public store; tenant flips to `status='active'` |

---

## 3. Fees

### 3.1 Setup Fee

| Item | Amount |
|---|---|
| Platform setup fee | $199.00 |
| Other one-time charges | $[0.00] |
| **Total due at signing** | **$199.00** |

Charged immediately via Stripe upon signing this SOW.

### 3.2 Recurring Monthly Fee

| Item | Amount |
|---|---|
| [Tier] subscription | $[249.00 / 399.00] / month |
| Other recurring charges | $[0.00] |
| **Total recurring** | **$[249.00 / 399.00] / month** |

Billed on the same day of each month, starting on Day 15 (after the 14-day free trial expires) of the Effective Date.

### 3.3 Free Trial

The recurring monthly subscription includes a 14-day free trial beginning on the Effective Date. The setup fee is non-refundable once Provider has begun work. The recurring monthly fee is not billed during the trial period.

---

## 4. Vertical-Specific Configuration

### 4.1 Vertical Preset

Client's tenant will be configured with the following vertical preset:

[Tree Service / Plumbing / Benefits Consulting / Pressure Washing / etc.]

This preset informs default content templates, follow-up cadence, review-request copy, and AI Voice Receptionist greeting (if applicable).

### 4.2 Service Area

Client's service area for lead capture and content generation:

[List of cities, ZIP codes, or counties]

### 4.3 Brand Voice

Sample of Client's preferred brand voice / sample sentences from Client (collected during onboarding wizard Step 7):

[3 sample sentences]

---

## 5. Integration Details

### 5.1 Telnyx Phone Number

Provider will provision one Telnyx phone number for Client's exclusive use, of the following type:

- ☐ Local 10DLC (preferred for inbound customer communications)
- ☐ Toll-free (preferred for outbound at scale)

Phone number: [TO BE ASSIGNED] (provisioned Day 1)

### 5.2 Connected Channels

| Channel | Status |
|---|---|
| Google Business Profile | URL: [client gbp url] |
| Facebook Business Page | URL: [client fb url] |
| Instagram Business | URL: [client ig url] |
| Website (Client's existing or FGA-built) | URL: [client website url] |

---

## 6. Acceptance Criteria

This SOW is considered substantially performed once:

- (a) the branded mobile application has been published to the Apple App Store (or a TestFlight invitation has been provided to Client in the Quick Start path);
- (b) at least one inbound lead has been captured and the speed-to-lead automation has fired successfully; and
- (c) Client has approved or rejected at least one piece of content generated by the System.

---

## 7. Special Terms

[Any one-off agreements with this Client that deviate from the MSA defaults. Examples: extended free trial, custom pricing, additional onboarding sessions, etc. If none, write "None."]

---

## Signatures

**PROVIDER**

First Gen Automate LLC

By: ____________________________________
Name: Patrick Jenkins
Title: Founder
Date: __________________________________

**CLIENT**

[Client Legal Name]

By: ____________________________________
Name: __________________________________
Title: __________________________________
Date: __________________________________

---

*Template last updated: 2026-05-22.*
