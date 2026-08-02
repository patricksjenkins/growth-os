# Email-Confirmation Signature Workflow

Legally-binding alternative to DocuSign for First Gen Automate LLC's first batch of clients (friends-and-family, complimentary tenants, and early paying clients before signature volume justifies a paid e-signature SaaS).

## Legal basis (so you can answer if asked)

Email-based electronic signatures are valid and enforceable under:

- **Federal E-SIGN Act** — 15 U.S.C. § 7001 (2000)
- **Georgia Uniform Electronic Transactions Act (UETA)** — O.C.G.A. § 10-12-1 et seq.

Both statutes recognize an electronic signature as "an electronic sound, symbol, or process attached to or logically associated with a record and executed or adopted by a person with the intent to sign the record." A name typed at the bottom of an email, sent with clear intent to be bound by the attached documents, qualifies.

**What matters:** intent to sign + identifiable signer + reference to the documents + a retained record. The workflow below covers all four.

## Workflow

### Step 1 — Prepare the documents

1. Open the MSA template: `growth-os/docs/business/legal/service-agreement-template.md`
2. Fill the `[BRACKETS]` for this specific client (legal name, address, effective date, your EIN)
3. Open the SOW template: `growth-os/docs/business/legal/scope-of-work-template.md`
4. Fill it for this specific deal (tier, modules, fees, etc.)
5. Export both as PDFs:
   - Easiest: open the `.md` files in a Markdown previewer (Typora, VS Code preview, or paste into Google Docs) → File → Export PDF
   - Name them clearly: `FGA-MSA-[ClientName]-[YYYYMMDD].pdf` and `FGA-SOW-[ClientName]-[YYYYMMDD].pdf`
6. Save both PDFs to a private "FGA Legal" folder (iCloud Drive or Google Drive — NOT in any git repo)

### Step 2 — Send the email

Copy this template into a new email from `patrick@firstgenautomate.com`. Replace the `[BRACKETS]`.

```
To:       [client_email]
Cc:       info@firstgenautomate.com
Subject:  First Gen Automate — Service Agreement + Scope of Work for [Client Business Name]
Attach:   FGA-MSA-[ClientName]-[YYYYMMDD].pdf
          FGA-SOW-[ClientName]-[YYYYMMDD].pdf
```

```
Hi [Client First Name],

Attached are the two documents that formalize First Gen Automate's
engagement with [Client Business Legal Name]:

  1. Master Services Agreement (MSA) — the umbrella contract
  2. Scope of Work (SOW) — your specific tier, modules, and timeline

Please review both. Once you're ready to proceed, reply to this email
with the exact text below (you can copy it directly), filling in your
name, title, business name, and today's date:

──────────── COPY EVERYTHING BETWEEN THESE LINES ────────────
I, [YOUR FULL LEGAL NAME], in my capacity as [YOUR TITLE] of [YOUR
BUSINESS LEGAL NAME], hereby agree to and accept the terms of the
Master Services Agreement and the Scope of Work attached to your
email dated [DATE OF MY EMAIL TO YOU].

By replying to this email and submitting this electronic confirmation,
I intend this reply to constitute my electronic signature on the
above-referenced documents under the federal E-SIGN Act (15 U.S.C.
§ 7001) and the Georgia Uniform Electronic Transactions Act
(O.C.G.A. § 10-12-1 et seq.).

Signed: [YOUR FULL LEGAL NAME]
Title:  [YOUR TITLE]
Entity: [YOUR BUSINESS LEGAL NAME]
Date:   [TODAY'S DATE]
──────────── END OF COPY BLOCK ────────────

After you reply, First Gen Automate will counter-sign electronically
and send you a confirmation email with both fully-executed PDFs
attached. We'll then start your branded mobile app build and begin
the 7-day onboarding sequence.

If you have any questions before signing, just reply to this email or
call (404) 496-7983.

Looking forward to working with you,

Patrick Jenkins
Founder, First Gen Automate LLC
patrick@firstgenautomate.com
(404) 496-7983
firstgenautomate.com

Automate the Overhead, Focus on the Work.
```

### Step 3 — Client replies (you wait)

Client replies with the filled-in copy block. Their reply, sent from their own email account, is their legally-binding electronic signature.

### Step 4 — Counter-sign + confirm

Once their reply lands in your inbox:

1. Reply-all to their confirmation with this template:

```
Subject: ✓ Executed — First Gen Automate × [Client Business Name]

Hi [Client First Name],

Confirming receipt of your electronic signature on the MSA and SOW
dated [Date]. First Gen Automate LLC accepts and counter-signs as
follows:

──────────── COUNTER-SIGNATURE ────────────
I, Patrick Jenkins, in my capacity as Founder of First Gen Automate
LLC (Georgia, EIN on file), accept and counter-sign the Master
Services Agreement and Scope of Work confirmed by your reply dated
[Date Of Their Reply].

This reply constitutes First Gen Automate LLC's electronic signature
on the above-referenced documents under the federal E-SIGN Act
(15 U.S.C. § 7001) and the Georgia Uniform Electronic Transactions
Act (O.C.G.A. § 10-12-1 et seq.).

Signed: Patrick Jenkins
Title:  Founder
Entity: First Gen Automate LLC
Date:   [Today]
──────────── END ────────────

Both documents are now fully executed. Attached for your records.

Next: I'll trigger your onboarding flow. You'll get a welcome email
within the next few minutes with a link to your branded mobile app +
web portal. The 7-day setup begins today.

Talk soon,
Patrick
```

2. Re-attach the SAME unmodified MSA + SOW PDFs that were attached to your original email. (Don't generate new PDFs — the executed version is the original ones referenced in both signatures.)

### Step 5 — File the executed contract

The executed contract = three pieces, retained together:

1. The original MSA + SOW PDFs (exactly as sent)
2. Your original email sending them (full headers + body)
3. The client's reply containing their electronic signature
4. Your counter-signature reply

Save all four to a folder in iCloud Drive / Google Drive named:
```
FGA Legal/Clients/[YYYY-MM-DD] [Client Business Name]/
  ├── 01-MSA.pdf
  ├── 02-SOW.pdf
  ├── 03-email-original-from-Patrick.pdf      (export as PDF from your email client)
  ├── 04-client-signature-reply.pdf            (export the client's reply)
  └── 05-counter-signature-reply.pdf           (export your counter-signature)
```

**Naming convention** keeps them chronologically sortable AND obvious which client.

### Step 6 — Trigger onboarding

Open the platform admin → `/admin/onboard` → fill in the client's info → submit. This:

1. Creates the tenant record
2. Sends the welcome email with magic-link to the onboarding wizard
3. Provisions the Telnyx number
4. Kicks off the asset-generation pipeline

---

## When to switch to a real e-signature service

Move to DocuSign / SignNow / HelloSign when **any** of the following hits:

- You exceed **5 signed contracts in a calendar month** (manual workflow takes ~20 min per client; 5+/month = ~1.5+ hours of pure overhead you can't bill)
- A specific client requests "send via DocuSign" (some larger SMBs expect it)
- You're consistently waiting on clients to figure out the copy block (DocuSign's button is just easier for some)
- You want signed-doc archival + audit trail in one searchable place

At that point, **SignNow Business at $8/mo annual ($96/yr) or DocuSign Personal at $15-20/mo** become worth the spend. Both have free trials.

## Common questions clients ask

**"Is an email reply really legally binding?"**
Yes. Federal E-SIGN Act (2000) and Georgia UETA both treat a typed name in an email — sent with clear intent to be bound by the referenced documents — as a valid signature. Courts have consistently upheld this. The copy block above explicitly states intent, which is the legal gold standard.

**"Can I just print, sign, and email it back?"**
Yes, that also works. Wet ink + scan / photo is fine too. The copy-block version is faster and equally enforceable.

**"What if I want to change something in the contract?"**
Reply with the change requested *before* the signature block. We'll send a revised version with a new date and start over. Don't modify the attached PDF directly — that breaks the "original document referenced in the signature" chain.

---

*Workflow document last updated: 2026-05-23. Cross-references the MSA / SOW / AUP templates in this same `legal/` folder.*
