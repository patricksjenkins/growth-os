# FGA Support Playbook

Canned responses + escalation rules for the most common client
support inbound. Goal: 24-hour Growth tier SLA / 4-hour Scale tier
SLA (business hours) without Patrick reinventing the wheel each
time.

## Trust + tone defaults

- Plain-spoken. Owner-to-owner. Not corporate.
- Acknowledge the issue in the first sentence.
- Give a real timeline if you're waiting on something external.
- Sign off with first name. No "Best regards" boilerplate.

## Common issues + canned responses

### "My welcome email magic link expired"

> Hi [Name],
>
> Reply received. Fresh login link incoming — should land in your
> inbox in a minute. The previous one timed out (Supabase magic
> links last 7 days).
>
> If you don't see it in 5 minutes, check your spam folder. I'll
> stay on this until it lands.
>
> -Patrick

**Action:** Hit the admin "Resend welcome email" button
(`POST /api/admin/clients/:tenantId/resend-welcome`). Confirm with
the customer when sent.

### "My branded app isn't in the App Store yet"

> Hi [Name],
>
> The App Store review usually takes 24-48 hours, sometimes up to
> 3 days for first-time submissions. Your submission went in on
> [date] — I'll send you the live App Store link the moment Apple
> approves.
>
> Meanwhile you can keep using the shared FGA app on your phone
> with the same login. All your data is there.
>
> -Patrick

**Action:** Check Apple's review status in App Store Connect. If
it's been > 72 hours, escalate via Apple's contact-us form.

### "I don't have a Facebook Page set up for the business"

> Hi [Name],
>
> No problem — it takes about 10 minutes. Step-by-step:
>
> 1. Open Facebook on your phone
> 2. Tap the menu (☰ or your profile pic) → "Pages"
> 3. Tap "Create New Page"
> 4. Pick "Business or Brand"
> 5. Page name: your business name
> 6. Category: pick the closest match to your trade
> 7. Tap "Create Page"
>
> Once that's done, reply with the Page URL (or screenshot) and
> I'll connect it to your content publishing.
>
> If you want me to walk through this on a 5-minute call instead,
> just say when works.
>
> -Patrick

**Action:** Add to your follow-up reminder list. Once they send the
URL, save to `tenant_config.facebook_url` (via admin Clients edit).

### "How do I claim my Google Business Profile?"

> Hi [Name],
>
> Two minutes:
>
> 1. Go to https://business.google.com
> 2. Search for your business name + city
> 3. If it appears, click "Claim this business" → pick verification
>    method (phone or postcard)
> 4. If it doesn't appear, click "Add your business" and fill the form
>
> Verification by phone is instant. Postcard takes 5-7 days.
>
> Once verified, send me the "Share review link" from your Google
> Business profile (Maps → your business → Share → Copy review
> link) and I'll wire it into your review module.
>
> -Patrick

**Action:** When they send the URL, save to
`tenant_config.google_review_url`. The review-request module
auto-picks it up next cron tick.

### "I'd like to cancel"

> Hi [Name],
>
> Got it. Before I process the cancellation, mind sharing what's
> not working? I'd rather fix the underlying issue than lose you,
> and the answer often helps other clients too. No pressure
> either way.
>
> If you'd still like to cancel after that, just reply "yes,
> cancel" and I'll wrap it up the same day. Your business data
> stays in our system for 90 days in case you reactivate.
>
> -Patrick

**Action:** If they confirm cancel, process via Stripe dashboard.
The `customer.subscription.deleted` webhook auto-flips the tenant
status and shows the cancellation auth-gate screen on their next
app launch.

### "My monthly fee charged but I haven't gotten any leads"

**This is a high-priority. Same-day response, not 24h.**

> Hi [Name],
>
> Looking into this now. Three things I want to check:
>
> 1. Is your phone forwarding set up so missed calls hit your
>    Twilio number?
> 2. Are your social posts going live, or sitting in the approval
>    queue waiting on you?
> 3. Has your Google Business Profile got recent reviews driving
>    foot traffic?
>
> I'll dig into your account on my side and we'll get on a quick
> call this afternoon if needed.
>
> -Patrick

**Action:** Check the admin Clients page for this tenant:
- Pipeline tab: lead count over last 30 days
- Content tab: any drafts pending approval > 7 days?
- Activity log: any agent failures?

If genuine system gap, offer 1-month credit + investigate.

### "Can I add a module I didn't pick at signup?"

> Hi [Name],
>
> Absolutely. The Scale tier ($499/mo) includes all 15 modules; if
> you're on Growth ($299/mo for 7 of 15), I can either:
>
> 1. Add the one module you need à la carte (rare — I usually only
>    do this for friends/family)
> 2. Upgrade you to Scale for the full 15
>
> Which sounds right? Happy to make the switch the moment you say
> the word.
>
> -Patrick

**Action:** Use admin Clients edit to update modules + tier in
`tenant_config`. Stripe subscription update happens manually for now
(pre-launch).

## Escalation rules

| Issue | Response time | Escalate to |
|---|---|---|
| Auth / login problem | 4 hours business hours | Patrick personally |
| Billing / refund | Same day | Patrick personally |
| Bug in core flow | Same day | Patrick + engineering session |
| Feature request | 24h ack, defer rollout to roadmap | Patrick decides |
| Content quality complaint | 24h, generate fresh draft + apologize | Auto-handle via regenerate-with-feedback flow |
| Anything legal / safety | Within 1 hour | Patrick personally |

## SLA reminder

- **Growth tier ($299/mo):** 24h response, business hours
- **Scale tier ($499/mo):** 4h response, business hours
- **Complimentary (friends-family):** best-effort, no SLA

Business hours for SLA purposes: Mon-Fri 9am-6pm ET. Inbound on
weekends or evenings is acknowledged within the next business day's
SLA window. Add a clear "I work Microsoft Mon-Fri so I respond
fastest evenings + weekends" sign-off when relevant.
