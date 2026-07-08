# Runbook — Capture invoices from a personal Gmail

**Why this runbook exists:** connecting `patricksjenkins@gmail.com` directly to the
weekly invoice scanner fails with **`Error 403: org_internal`**. That is not a bug,
a missing key, or a scope problem. It is a Google Cloud *project* setting.

---

## DECISION (2026-07-08): use forwarding, not a second OAuth app

Patrick chose **auto-forwarding** over standing up a second Google Cloud project.
Forwarding preserves attachments, so the existing scanner picks the invoices up
with **zero OAuth changes and zero Cloud Console work**.

**Setup — done once, in the PERSONAL Gmail account:**

1. Gmail → Settings (gear) → **See all settings** → **Forwarding and POP/IMAP**
2. **Add a forwarding address** → `patrick@firstgenautomate.com` → Next → Proceed
3. Google emails a confirmation code to `patrick@firstgenautomate.com`. Open it
   there and click the verification link. (Do NOT enable "Forward a copy of
   incoming mail to…" — that forwards *everything*. Leave it on "Disable
   forwarding"; the filter below does the selective forwarding.)
4. Back in the personal Gmail, paste this into the **search box**:
   ```
   has:attachment (invoice OR receipt OR billing OR statement OR subscription OR "payment received" OR "your order" OR "payment confirmation" OR "tax invoice")
   ```
5. Click the **filter icon** in the search bar (or "Show search options") — the
   query lands in **Has the words** — then **Create filter**.
6. Tick **Forward it to:** `patrick@firstgenautomate.com` → **Create filter**.

That's it. New invoices land in the work inbox and the Monday scan files them
under Needs Review.

**Known limits — state these plainly, do not oversell:**
- Gmail filters forward **new incoming mail only**. Invoices already sitting in
  the personal inbox are NOT forwarded retroactively (Gmail's "also apply to
  matching conversations" applies labels/archive, never forwarding). Forward the
  backlog by hand once, or upload those receipts directly.
- Vendors that email a **link** instead of an attachment (some Apple/Google
  receipts) are missed by design — the scanner requires `has:attachment`.
- A forwarded invoice that ALSO arrives directly at the work inbox produces a
  second draft, which the dedupe key (`vendor|doc#|date|total`) flags as a
  duplicate. Reject one; the books are never touched either way.

After the first invoice forwards through, hit **Expenses → Manage → Scan now**
rather than waiting for Monday.

---

## The rest of this document: the OAuth path (NOT taken, kept because the code exists)

The `oauth_client` column, the `GOOGLE_EXTERNAL_*` env vars, and the "+ Connect a
personal Gmail" button are all shipped and tested. They activate the moment those
env vars are set. If forwarding ever proves insufficient, everything below is the
route — no code changes needed.

---

## The constraint

The FGA Google Cloud project's OAuth consent screen has **User type = Internal**.
An Internal app accepts **only** accounts inside the `firstgenautomate.com`
Workspace org. A personal `@gmail.com` is refused before it ever sees a consent
screen.

**User type is per-project.** A single Cloud project cannot serve both Internal
and External users — the Audience setting lives on the project, and every OAuth
client inside it inherits that setting.

## Why we did NOT just flip the existing project to External

Because an External app whose **publishing status is "Testing"** is issued
refresh tokens that **expire after 7 days** for any Gmail scope:

> "A Google Cloud Platform project with an OAuth consent screen configured for an
> external user type and a publishing status of 'Testing' is issued a refresh
> token expiring in 7 days, unless the only OAuth scopes requested are a subset
> of name, email address, and user profile."
> — <https://developers.google.com/identity/protocols/oauth2#expiration>

The existing Internal project holds the token that powers the **drip outreach
reply-sync** (`patrick@firstgenautomate.com`). Flipping it to External would put
that on a weekly re-auth treadmill, and the failure is silent: replies stop
routing, bounces stop suppressing, and nothing errors loudly.

**So the Internal project stays exactly as it is. We add a second one.**

## Two facts that make this cheap

1. **Verification is not what grants long-lived tokens — publishing status is.**
   An External app in **"In production"** gets normal non-expiring refresh
   tokens *even while unverified*.
2. **Google's personal-use exemption covers restricted scopes.** Fewer than 100
   users, all known to you personally, means you never submit for verification
   or a CASA security assessment. The price is the "Google hasn't verified this
   app" interstitial and a 100-new-user cap.
   — <https://support.google.com/cloud/answer/13464323>

`gmail.readonly` is a **restricted** scope. The exemption still applies.

---

## Steps (Patrick does these — they require signing into Google)

Do this in the Google Cloud Console at <https://console.cloud.google.com>.

1. **Create a new project.** Name it something like `fga-personal-mailbox`.
   Same org is fine. (`Internal` is only *offered* to org projects; `External`
   is always available.)

2. **Enable the Gmail API** for the new project.
   APIs & Services → Library → "Gmail API" → Enable.

3. **Configure the consent screen** → **User type: External**.
   Required fields for a production external app: app name, user support email,
   developer contact email, and three reachable links:
   - Homepage: `https://www.firstgenautomate.com`
   - Privacy policy: `https://www.firstgenautomate.com/privacy`
   - Terms of service: `https://www.firstgenautomate.com/terms`

4. **Add the scope** `https://www.googleapis.com/auth/gmail.readonly`.

5. **Click "Publish App."** Status becomes **In production**.
   **Do NOT click "Prepare for Verification." Do not submit. Do not start CASA.**
   The console will warn that restricted scopes need verification. Ignore it —
   the personal-use exemption applies, and publishing is what you came for.

6. **Create an OAuth client** → Application type: **Web application**.
   Authorized redirect URI (exact, no trailing slash):
   ```
   https://growth-os-production-22b3.up.railway.app/api/drip/gmail/callback
   ```
   The same redirect URI already exists in the Internal project's client. That
   is fine — redirect URIs are matched per `client_id`, not globally.

7. **Copy the client ID and secret into Railway** as NEW variables. Do not
   overwrite the existing ones:
   ```
   GOOGLE_EXTERNAL_CLIENT_ID=<new client id>
   GOOGLE_EXTERNAL_CLIENT_SECRET=<new client secret>
   ```
   Leave `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` untouched — they still serve
   the Workspace inbox and the reply-sync.

8. Railway redeploys. Go to **Expenses → Manage**. A **"+ Connect a personal
   Gmail"** button appears. Click it, sign in as `patricksjenkins@gmail.com`.

9. At the **"Google hasn't verified this app"** screen: **Advanced** →
   **Go to First Gen Automate (unsafe)**. This is expected — it is your own app.

10. Done. The mailbox appears with a **Personal** badge and is scanned every
    Monday at 7am ET alongside the work inbox.

---

## How the code handles two clients

`email_connections.oauth_client` is `'internal' | 'external'` (migration 064).

A refresh token is **bound to the client_id that minted it** — Google rejects a
refresh presented with a different client's secret. So:

- The client kind is signed into the OAuth `state` (HMAC, 10-min TTL), and the
  callback exchanges the code against that same client.
- `ensureValidToken()` reads `conn.oauth_client` and refreshes with **that**
  client's credentials, never the ambient `GOOGLE_CLIENT_ID`.
- `oauthCreds()` **throws** rather than falling back to the other client. A
  silent fallback would surface days later as an opaque `invalid_client` inside
  a cron run.

With `GOOGLE_EXTERNAL_CLIENT_ID` unset, behavior is identical to before this
change: one client, one project, no personal-Gmail button.

## Gotchas

- **Workspace admin blocking.** If the *work* account's Workspace admin blocks
  unverified third-party apps, the External client gets a hard `access_denied`
  with no "Advanced" escape hatch. Doesn't apply to a personal Gmail.
- **100-new-user cap** on unverified apps. Irrelevant at one user; a hard wall if
  this ever ships to customers. If it does, the personal-use exemption
  evaporates and you owe Google verification + a CASA Tier 2 assessment.
- **Gmail-scope tokens die on account password change** — in *every*
  configuration, including today's Internal one. The mailbox panel shows a
  **Reconnect** badge when a refresh token goes missing, and `invoice-scan`
  raises an amber attention item when a mailbox's token stops refreshing.
- The **primary** mailbox cannot be disconnected from the UI: it is also the
  inbox the outreach reply-sync polls.

## Alternative if you'd rather not create a second project

Have the personal Gmail **auto-forward** invoice mail to
`patrick@firstgenautomate.com`. Forwarding preserves attachments, so the existing
scanner picks them up with zero OAuth changes. Costs you a Gmail filter and one
forwarding-address confirmation click; costs you nothing in Google Cloud.
