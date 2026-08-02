# Client Negotiation Playbook

**Internal-only.** What to say when a client pushes back on the MSA, SOW, or pricing. Each section has: the objection, the honest answer, the negotiating range (what to concede if pushed), and the red line (where to walk away).

This isn't a "win every negotiation" doc. It's "know in advance what's worth flexing on, what's not, so you don't accidentally give away the company in a moment of weakness on a 30-minute call."

---

## 1. Pricing — "$249/$399 is too expensive"

**Objection:** *"That's a lot for software. Can you do it for cheaper?"*

**Honest answer:**

> "I hear you — and I want to be straight: the price is calibrated to what it actually costs us to install and run the system end-to-end for you. We're not just selling software, we're installing and operating a system that runs your marketing, your follow-ups, your reviews, your social posting. That's the equivalent of a part-time hire at $4-6k/month, automated. At Growth, that's about $8/day. At Scale, $13/day. If $249 is a stretch I'd rather not start than start poorly — but most people who say that change their mind once they see one missed-call text-back close a job they would have lost."

**Negotiating range:**
- ✓ First-month free trial extension to 30 days (instead of 14) for friends-and-family / case-study customers
- ✓ One-time 50% off month 1 for early customers willing to give a written testimonial after 60 days
- ✓ Complimentary tier (no recurring fee) for A Kut Above, WellMor, and 1-2 strategic POC tenants — already marked `is_complimentary=true` in tenant config
- ✗ Permanent discount on the monthly tier
- ✗ Cutting the $199 setup fee (it covers real provisioning cost)

**Red line:** $200/month or below for paying clients. Below that the COGS (Telnyx, Anthropic, Buffer, Supabase, infra per tenant) eats the margin.

---

## 2. Tier modules — "Can I swap one of my 7 Growth modules for a Scale-only one?"

**Objection:** *"I want the Voice Receptionist but I don't need [X module]. Can you just swap them?"*

**Honest answer:**

> "Voice Receptionist is Scale-only — it's the one differentiator between the two tiers, so we can't bundle it into Growth. But Scale unlocks all 15 modules plus higher volume caps. The price gap is $150/month — usually pays for itself if the Voice Receptionist saves you one missed customer call per week."

**Negotiating range:**
- ✓ Offer 30-day Scale trial — they get Voice Receptionist + everything for 30 days, then choose to stay on Scale or drop to Growth (without Voice Receptionist) at day 30
- ✗ "Growth + Voice Receptionist only" as a custom tier — kills the module catalog clarity for future clients

**Red line:** No custom à-la-carte. If they want Voice Receptionist they upgrade to Scale.

---

## 3. Free trial length — "Can I have 30 days free instead of 14?"

**Objection:** *"14 days isn't enough to see results."*

**Honest answer:**

> "Fair. The 14 days is enough to see the system functioning — leads getting responded to, content getting drafted, reviews getting asked for. But you're right that ROI in dollars usually shows up around days 21-30. Let me extend you to 30 days — that buys you confidence."

**Negotiating range:**
- ✓ Extend trial to 30 days for any client who asks (give once, before they have to push hard)
- ✓ Extend trial to 60 days for case-study candidates (in exchange for a written quote at day 60)
- ✗ Free trial longer than 60 days
- ✗ "Pay nothing until results show" (creates undefined-success-criteria disputes)

**Red line:** Setup fee always charges Day 1 — non-negotiable. Trial only applies to the recurring monthly fee.

---

## 4. Liability cap — "6 months of fees is too low"

**Objection (from larger client / their lawyer):** *"Your liability is capped at 6 months of fees. We need at least 12 months, or no cap."*

**Honest answer:**

> "Standard SaaS contracts cap liability at 3-12 months of fees — we're in the middle of that range. We're an LLC with bootstrap capital, not a Fortune 500 — uncapped liability would mean one bad incident bankrupts the company and you lose your platform. Capped liability protects both of us — you get a working business, we stay in business."

**Negotiating range:**
- ✓ Move from 6 months → 12 months of fees for Scale-tier clients (~$4,800 cap)
- ✓ Carve-out: NO cap on gross negligence, willful misconduct, IP infringement claims, or breach of confidentiality (these are usually carved out in commercial software contracts anyway)
- ✗ Uncapped liability for normal service failures
- ✗ Indemnification of the client's downstream damages (their customers)

**Red line:** No uncapped liability for general service issues. If they walk over this, they walk.

---

## 5. Indemnification — "Why am I indemnifying you?"

**Objection:** *"You want ME to indemnify YOU?"*

**Honest answer:**

> "The indemnification in the MSA is narrow — you indemnify us only for (a) your violation of the contract, (b) content you provided that turns out to infringe someone else's rights, (c) your use of the system in violation of law, and (d) customer data you provided that wasn't lawfully obtained. We can't be on the hook for what happens because of your business's actions. We indemnify YOU for our own failures — that's reciprocal and reasonable."

**Negotiating range:**
- ✓ Add mutual indemnification — FGA indemnifies the client for FGA's IP infringement / breach of the MSA. This is standard.
- ✓ Cap the client's indemnification obligation at the same liability cap (6-12 months of fees)
- ✗ Remove client indemnification entirely (would leave FGA exposed to TCPA / CAN-SPAM violations the client caused)

**Red line:** Client indemnification on TCPA / customer-data lawfulness must stay. That's the whole point — FGA is the SMS sender at carrier level, but the client decides who gets messaged.

---

## 6. IP / aggregated data — "You can't use my data to train your models"

**Objection:** *"I don't want you using my customer data to improve your system."*

**Honest answer:**

> "Fair — and to be precise: we don't use your customer data to train AI models. The aggregated-data clause in §4.4 is about *de-identified, aggregated platform metrics* — things like 'on average, follow-up SMS sent at 4pm convert 12% better than 11am.' That's how we improve the product for everyone. We will absolutely not feed your customer list, your lead names, or any PII into model training. I'm happy to add that as an explicit exclusion in writing."

**Negotiating range:**
- ✓ Add to §4.4: "Provider shall not use personally identifiable information, customer contact data, or Client-specific business performance data for model training purposes."
- ✓ Offer to delete aggregated platform metrics on request post-termination (in addition to the 90-day Client data deletion)
- ✗ Remove aggregated metrics entirely (kills our ability to improve scheduling, copy templates, etc.)

**Red line:** None — the aggregated-data clause matters less than the contract overall. If a client insists on full removal, agree.

---

## 7. Auto-renewal — "I want to be able to cancel anytime"

**Objection:** *"What if I want to cancel? Am I locked in?"*

**Honest answer:**

> "Cancel anytime, no penalty. There's no contract length — you're month-to-month after the trial. The MSA auto-renews each month until you cancel via the cancellation flow in your app, or by emailing us. Cancellation takes effect at the end of your current billing period. After cancellation, you have 90 days to export your data before it's permanently deleted."

**Negotiating range:**
- ✓ All as stated above — already client-friendly
- ✗ "I can stop paying mid-month and get a refund for the partial month" — no pro-rated refunds (standard SaaS)

**Red line:** No early-termination penalty (it's already month-to-month). If they want pro-rated refunds, that's a no.

---

## 8. Exclusivity / non-compete — "Will you work with my competitors?"

**Objection:** *"If I sign with you, will you sell the same thing to my competitor down the street?"*

**Honest answer:**

> "Yes — we sell to any small service business that fits the 1-10 employee profile, regardless of where they are. We're a horizontal platform, not a vertical agency. That said, each tenant is fully isolated — your customer data, your brand, your content stays in your tenant. Your competitor never sees anything of yours. If you want geographic exclusivity in your specific market, that's a different conversation, but I'd be honest: I'm not in a position to give exclusivity in a $249/month deal."

**Negotiating range:**
- ✓ Confidentiality clause (MSA §5) already covers their proprietary information
- ✓ Geographic exclusivity — only if they're willing to pay a meaningful premium (e.g. $5,000/month all-in for an exclusivity grant in their city/zip set) AND they sign a longer-term commitment (12 months)
- ✗ Geographic exclusivity at standard pricing
- ✗ Industry exclusivity (e.g. "no other tree service companies in Georgia") — too restrictive

**Red line:** No free exclusivity. It has to be priced.

---

## 9. SLA / uptime — "What if your system goes down?"

**Objection:** *"What guarantees do you offer if the system breaks?"*

**Honest answer:**

> "We don't offer a contractual uptime SLA at our current price point — most SMB SaaS doesn't. What we do offer: monitoring (Sentry), redundant hosting (Railway + Supabase), and a real human (me) who responds to outages personally. If the system is down for more than 4 hours in a billing month, I'll credit that month's fee. That's not in the MSA right now but I'm happy to add it as an addendum if it matters to you."

**Negotiating range:**
- ✓ 99.5% monthly uptime credit promise (~3.5 hour cap per month) — add as SOW addendum
- ✓ 24-hour business-hours support response time (already in MSA §7.X equivalent — see growth-os docs for actual SLA structure)
- ✗ 99.99% "four nines" uptime guarantee
- ✗ Penalty clauses beyond pro-rated monthly fee credit

**Red line:** No hard-dollar penalty clauses beyond fee credits. The platform's COGS can't absorb arbitrary damage penalties.

---

## 10. White-labeling / branding — "Can I sell this as my own product?"

**Objection (rare, from agency-style clients):** *"This is great — can I white-label it and sell it to my own clients as my product?"*

**Honest answer:**

> "Each tenant gets a branded mobile app + portal — it's branded as your business, runs as your business. But you can't resell the system as your own SaaS — that would put you in competition with us using our infrastructure. If you want to be a referral partner, that's different: we have a referral program (work in progress) where you earn a percentage on every business you bring us."

**Negotiating range:**
- ✓ Referral commission (TBD percentage when the program ships)
- ✓ Co-branded marketing materials if they refer 5+ clients
- ✗ Reseller / white-label rights at any price point currently — kills the direct-customer relationship

**Red line:** No reselling, no API-as-a-service to their downstream customers. Direct customer relationships only.

---

## 11. Custom development — "Can you build me a custom feature?"

**Objection:** *"I need a feature that's not in the 15 modules. Can you build it for me?"*

**Honest answer:**

> "Sometimes yes — but I'm intentionally cautious about custom work because it slows the whole platform down. The way I think about it: if your feature would also help 5+ other small service businesses, I'd consider building it as a new module and you'd get early access. If it's truly unique to your business, I'd quote it as one-off consulting work separate from the subscription — probably $150-200/hour."

**Negotiating range:**
- ✓ "I'll consider adding this to the roadmap" — non-committal but listens
- ✓ Quote one-off custom work at $150-200/hour, paid upfront, separate from the MSA
- ✗ "Yes, included with your subscription" — burns time on bespoke work
- ✗ Free custom development as a sales concession

**Red line:** No free custom dev. Even one exception sets a bad precedent.

---

## 12. Termination & data export — "What happens to my data if I leave?"

**Objection:** *"If I cancel, can I take my customer list with me?"*

**Honest answer:**

> "Yes — that's actually in the MSA §6.4. You get 90 days after cancellation to export your data (leads, customers, content history, photos) via the platform's export tools. After 90 days, everything's permanently deleted from our systems and backups. The data is yours, always has been."

**Negotiating range:**
- ✓ All as stated
- ✓ Offer to extend export window to 120 days on request

**Red line:** None on this — it's already client-favorable.

---

## Universal closing line when negotiations get long

> "I want to find a deal that works for both of us, but I also need to be honest about what I can and can't do at this stage of the company. If we can't get there, that's okay — I'd rather not start than start with terms that don't work for either of us. What's the one thing that would tip this from a no to a yes for you?"

That last question forces them to prioritize. Usually you find out they only really care about ONE of the things they've been pushing on — and that one thing is often within your concession range.

---

## When to walk away (the rare cases)

- They demand a refund clause not tied to FGA's actual fault (e.g. "I want my money back if my business doesn't grow")
- They want uncapped liability for ordinary service failures
- They insist on white-labeling / reselling
- They refuse to sign the AUP (TCPA / carrier compliance is non-negotiable)
- They want you to indemnify them for THEIR customers' actions (e.g., spam claims arising from their own bad data)

Walking away costs you one sale. Signing a bad contract costs you the company.

---

*Last updated: 2026-05-23. Cross-references MSA / SOW / AUP templates in this `legal/` folder.*
