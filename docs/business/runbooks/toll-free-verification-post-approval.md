# Toll-Free Verification — Post-Approval Rewire Runbook

**Created:** 2026-05-24 (toll-free verification SUBMITTED + IN_REVIEW at Twilio)
**Trigger:** Twilio sends an email titled "Your toll-free verification has been approved"
**Estimated time to fully cut over:** ~10 minutes

## What's currently in place

- **Submitted:** 2026-05-23. Verification SID `HH6968f25503e2e977b8fb276322ba8e6c`. Status: `IN_REVIEW`.
- **Numbers involved:**
  - `+18449171256` — toll-free, currently in review
  - `+14706907537` — local 10DLC, A2P registration still pending (separate parallel track)
- **Tenant config today:** FGA tenant's `tenant_integrations.twilio.config.phone_number = '+14706907537'`. All SMS that would go out from FGA today gets carrier-filtered because A2P 10DLC isn't approved yet.
- **Push notification fallback is live** — voice + SMS push notifications shipped 2026-05-23 to keep Patrick informed during the SMS deliverability gap.

## When the approval email arrives

### Step 1 — Verify approval status via Twilio API (~30s)

```bash
cd ~/growth-os
node -e "
require('dotenv').config();
const twilio = require('twilio');
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
client.messaging.v1.tollfreeVerifications('HH6968f25503e2e977b8fb276322ba8e6c').fetch().then(v => {
  console.log('Status:', v.status);
  if (v.status === 'TWILIO_APPROVED' || v.status === 'CARRIER_APPROVED' || v.status === 'APPROVED') {
    console.log('✓ Approved. Proceed with rewire.');
  } else {
    console.log('Not yet — current state:', v.status);
    if (v.rejectionReason) console.log('Rejection reason:', v.rejectionReason);
  }
});
"
```

Twilio sometimes shows two-step approval — `TWILIO_APPROVED` first, then `CARRIER_APPROVED` once carriers sign off. SMS deliverability only kicks in at `CARRIER_APPROVED` (or just `APPROVED`).

### Step 2 — Confirm deliverability with a single test send (~30s)

```bash
cd ~/growth-os
node -e "
require('dotenv').config();
const twilio = require('twilio');
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
client.messages.create({
  from: '+18449171256',
  to: '+16788009913',
  body: 'Test from FGA toll-free post-approval. If you got this — we are live.'
}).then(m => console.log('Sent. SID:', m.sid));
"
```

Wait 30 sec, then check `m.status` via the same fetch pattern. If `delivered`, you're live.

### Step 3 — Swap the FGA tenant's outbound number (~10s)

```bash
cd ~/growth-os
node -e "
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const tenantId = '30566ed6-026a-45e1-9502-029e6219df31';
sb.from('tenant_integrations').select('config').eq('tenant_id', tenantId).eq('service', 'twilio').single().then(({ data }) => {
  const newConfig = { ...data.config, phone_number: '+18449171256' };
  return sb.from('tenant_integrations').update({ config: newConfig }).eq('tenant_id', tenantId).eq('service', 'twilio').select().single();
}).then(({ data, error }) => {
  if (error) console.error(error.message);
  else console.log('Updated FGA twilio phone_number to:', data.config.phone_number);
});
"
```

### Step 4 — Point inbound webhooks at the toll-free number (~3 min)

In Twilio Console → Phone Numbers → Manage → Active numbers → click **+18449171256**:

- **Voice Configuration → A CALL COMES IN**: webhook (HTTP POST) → `https://growth-os-production-22b3.up.railway.app/webhooks/voice-receptionist`
- **Messaging Configuration → A MESSAGE COMES IN**: webhook (HTTP POST) → `https://growth-os-production-22b3.up.railway.app/webhooks/twilio/sms`
- **Status callback URL**: `https://growth-os-production-22b3.up.railway.app/webhooks/twilio/status`

Save. Twilio doesn't restart anything — webhook routing is live immediately.

### Step 5 — End-to-end test (~2 min)

From a phone other than +16788009913:

1. **Send a text** to `+18449171256` ("test, do you offer hubspot integration") → expect:
   - Push notification on Patrick's iPhone within ~2 sec
   - AI auto-reply via SMS within ~5-10 sec
2. **Place a call** to `+18449171256` → expect:
   - Push notification on Patrick's iPhone within ~1 sec
   - Phone rings on `+16788009913` for ~10 sec, then either Patrick answers OR call lands on Vapi AI receptionist
   - If AI receptionist takes it → push + email + SMS to Patrick when AI completes the call

Verify both work, then mark the launch-checklist item `done`.

### Step 6 — Update the launch checklist (~30s)

In `~/Desktop/FGA/dashboards/launch-checklist.html`, find the toll-free entry and flip:
- `s: 'blocking'` → `s: 'done'`
- `e: 'wait Twilio approval (submitted, in review)'` → `e: 'shipped YYYY-MM-DD'`
- `d: true` added

## What this doesn't change

- A2P 10DLC for `+14706907537` keeps going through its independent registration process. When it clears (1-3 weeks from submission), you have a choice:
  - **Stay on toll-free** indefinitely — many SaaS platforms do this
  - **Switch back to the local 470** — slightly better customer perception for SMB service businesses ("hey, that's a Georgia number, they're local")
- The mobile app, web admin, all the agents, all the existing webhooks — none of them change. The only field that flips is the FGA tenant's outbound `from` number.
- Push notifications keep working regardless of which number is active.

## If verification gets rejected

Twilio will email a rejection reason. Most common reasons + fixes:
- **"Sample messages too promotional"** → resubmit with examples that read more like customer service (transactional/notification language)
- **"Opt-in flow unclear"** → reference the SMS opt-in checkbox on /contact directly with the exact consent language
- **"Volume estimate doesn't match use case"** → drop estimate to 100/mo and resubmit
- **"Business not registered"** → re-upload LLC formation + EIN docs (you already have these)

Resubmit via Twilio Console → Phone Numbers → Manage → Active numbers → +18449171256 → toll-free verification — Twilio reopens the form with prior answers prefilled.
