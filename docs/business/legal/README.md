# Legal Templates

Internal-use templates for First Gen Automate LLC. Not finished signable contracts — fill in the `[BRACKETS]` and have a Georgia business attorney review before binding the LLC to anything material (especially the first 1-2 paying clients).

## Files

| File | Purpose | When used |
|---|---|---|
| `service-agreement-template.md` | Master Services Agreement (MSA) — the umbrella contract clients sign before onboarding | Once per Client at signup |
| `acceptable-use-policy.md` | What Clients can / can't do with the System | Linked from the MSA; updated as carrier policies evolve |
| `scope-of-work-template.md` | Per-Client deal specifics — tier, modules, fees, timeline | Once per Client (or once per renewal/expansion) |
| `email-signature-workflow.md` | Step-by-step playbook for sending + receiving electronic signatures via email reply (legal under E-SIGN Act + Georgia UETA) | Every Client signing until volume justifies paying for DocuSign / SignNow / HelloSign |

## Public-facing pages (deployed)

These live in the marketing-site repo and are accessible at firstgenautomate.com:

| Page | Source |
|---|---|
| Terms of Service | `/Users/patrickjenkins/Desktop/FGA/marketing-site/src/pages/Terms.tsx` |
| Privacy Policy | `/Users/patrickjenkins/Desktop/FGA/marketing-site/src/pages/Privacy.tsx` |

## Important entity facts (kept here so they're in one place)

| | |
|---|---|
| Legal Entity Name | First Gen Automate LLC |
| State of Formation | Georgia |
| Formation Date | 2026-05-22 |
| Principal Address | 120 Ralph McGill Blvd #413, Atlanta, GA 30308 |
| EIN | *Stored privately; not in source. Fill into SOW + MSA at signing.* |
| Authorized Signer | Patrick Jenkins, Founder |
| Notice Email | info@firstgenautomate.com |
| Governing Law | State of Georgia |
| Venue | Fulton County, Georgia (state or federal) |

## Workflow when signing a new Client

1. Open `service-agreement-template.md`, fill the Client section, signature dates
2. Open `scope-of-work-template.md`, fill the Client section + tier + modules + add-ons
3. Combine into a single PDF (Pages, Word, or DocuSign)
4. Send for e-signature (DocuSign free tier, PandaDoc, or HelloSign)
5. Once signed, file the executed copy in a private location (NOT this repo)
6. Mark the Client as signed in the platform admin UI; setup fee charged via Stripe; onboarding begins
7. The Client receives the welcome email and the onboarding wizard starts

## What to do BEFORE the first paying Client signs

- [ ] Have a Georgia business attorney review the MSA template (cost: ~$300-800 one-time)
- [ ] Decide on e-signature tool (DocuSign Personal: $10/mo, free tier limited)
- [ ] Set up a private folder structure for executed contracts (e.g. iCloud / Google Drive in a "FGA Legal" folder)
- [ ] Decide on insurance: General Liability + E&O / Professional Liability — important once paying revenue starts. Hiscox and Next Insurance write SaaS policies for ~$50-150/mo

## Decision log

When any template here is materially revised, write a note in `growth-os/docs/business/decisions/YYYY-MM-DD-legal-template-X-updated.md` describing what changed and why. Templates are checked into git so the history is visible, but the decisions log captures the *intent*.

---

*Last updated: 2026-05-22 (LLC formation day).*
