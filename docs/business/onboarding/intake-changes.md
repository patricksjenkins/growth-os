# Intake Form Changes for Two-Path Delivery (v1, 2026-05-15)

What needs to ship in the marketing-site `OnboardingPortal.tsx` to
capture the customer's delivery-path choice (Path A "Quick Start" vs
Path B "Full Ownership").

Backend (`api/routes/onboarding.js`) already accepts the new fields
as of commit on 2026-05-15:
- `delivery_path` ∈ `{ managed, owned }`
- `legal_entity_name` (Path B only)
- `duns_number` (Path B only)

All three are persisted to `tenant_config`.

---

## Where to Add the Path Choice UI

Add a new section at the **bottom of Step 1 (Business Information)**
in `marketing-site/src/pages/onboarding/OnboardingPortal.tsx`, between
the "Key Services" textarea and the "Next: Branding" button. The
fields shown depend on the selected path.

```tsx
{/* App Delivery Path */}
<div className="border-t border-white/10 pt-8 mt-4">
  <label className="block text-sm font-medium text-slate-300 mb-3">
    How would you like your branded app published?
  </label>

  <div className="space-y-3">
    <label className="flex items-start gap-3 p-4 bg-white/5 border border-white/10 rounded-xl cursor-pointer hover:bg-white/10">
      <input
        type="radio"
        name="delivery_path"
        value="managed"
        defaultChecked
        className="mt-1 accent-signal-green"
        onChange={() => setDeliveryPath('managed')}
      />
      <div>
        <p className="text-white font-semibold">Quick Start <span className="text-signal-green text-xs ml-2">RECOMMENDED</span></p>
        <p className="text-slate-400 text-sm mt-1">
          We publish your app under our Apple developer account.
          Live in 3–5 days. Zero Apple paperwork on your end.
        </p>
      </div>
    </label>

    <label className="flex items-start gap-3 p-4 bg-white/5 border border-white/10 rounded-xl cursor-pointer hover:bg-white/10">
      <input
        type="radio"
        name="delivery_path"
        value="owned"
        className="mt-1 accent-signal-green"
        onChange={() => setDeliveryPath('owned')}
      />
      <div>
        <p className="text-white font-semibold">Full Ownership</p>
        <p className="text-slate-400 text-sm mt-1">
          Your app is published in your own Apple developer account.
          You own it forever, even if you ever leave. Live in 5–7 days.
          One 25-minute call with us on Day 1 to get Apple's enrollment done.
          Your $99 annual Apple fee is included in your setup fee.
        </p>
      </div>
    </label>
  </div>

  {deliveryPath === 'owned' && (
    <div className="mt-6 space-y-4 p-4 bg-signal-green/5 border border-signal-green/30 rounded-xl">
      <p className="text-sm text-signal-green font-medium">
        A few details we'll need for Apple's enrollment form
      </p>
      <InputField
        name="legal_entity_name"
        label="Legal Business Name *"
        required
        placeholder="The exact name on your LLC / DBA paperwork"
      />
      <div>
        <label className="block text-sm font-medium text-slate-300 mb-2">
          D-U-N-S Number
        </label>
        <input
          type="text"
          name="duns_number"
          className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-signal-green"
          placeholder="Leave blank if you don't have one — Apple will issue one for free"
        />
        <p className="text-xs text-slate-500 mt-1">
          Most small businesses don't have one. If blank, we'll request one during your enrollment call.
        </p>
      </div>
    </div>
  )}
</div>
```

## State Hook Addition

At the top of the `OnboardingPortal` component (or wherever local
state lives for Step 1), add:

```tsx
const [deliveryPath, setDeliveryPath] = useState<'managed' | 'owned'>('managed')
```

`deliveryPath` controls whether the Path-B-only fields render.
Default is `'managed'` (Quick Start) — matches the radio default and
the backend default.

## What the form submit needs

No code change to the submit handler itself — the new fields
(`delivery_path`, `legal_entity_name`, `duns_number`) are standard
form fields that ride along in the multipart POST. The backend
`onboarding.js` route picks them up via the `GENERAL_FIELDS` list,
already updated.

## Optional: Conditional Validation

If you want strict validation on submit:
- Require `legal_entity_name` only when `delivery_path === 'owned'`
- `duns_number` is always optional

Most small businesses won't have a DUNS, so requiring it would lose
customers. Leaving it optional is correct.

---

## Mobile Wizard (Surface C) — Wait Until Later

The in-app onboarding wizard (`mobile-onboarding-flow.md`) doesn't
need to handle path choice — by the time the customer opens the
TestFlight build, the path has already been chosen, and the wizard
just continues with the rest of the intake (logo, photo seed, voice).

If a customer changes their mind, they go back to the marketing site
intake form (or contact support) and the choice is updated there.

---

## Marketing Site Pages That Reference "How It Works"

Look for any text on the marketing site that promises "you'll get
your own App Store app" and consider whether to mention the two-path
choice up-front (vs. surfacing it only at onboarding time). Default
recommendation: **don't** mention it on the marketing site — let it
be a delightful Day 0 detail. Most customers will pick "Quick Start"
without thinking about it.

Pages to spot-check:
- `marketing-site/src/pages/Home.tsx`
- `marketing-site/src/pages/HowItWorks.tsx`
- `marketing-site/src/data/modules.ts` (Branded Mobile App entry)
