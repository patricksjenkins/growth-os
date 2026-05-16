# FGA Decision Log

Cross-cutting business + product decisions, one file per decision.
Format: `YYYY-MM-DD-short-title.md`.

A decision belongs here if it:
- Sets the policy on something that will recur (pricing, modules, T&Cs)
- Changes the customer experience in a way someone will ask "why?" about later
- Picks one technical path over another with material trade-offs
- Affects ops, billing, or legal posture

A decision does NOT belong here if it's:
- A bug fix or routine engineering change (git history is enough)
- A trivial copy edit
- An exploration that didn't lead to action

## Decision file template

```markdown
# <Title>

**Date:** YYYY-MM-DD
**Status:** decided | superseded
**Decided by:** Patrick / Patrick + Claude / etc.

## Context

What's the situation that forces a decision?

## Options considered

1. **Option A** — what it is, pros, cons
2. **Option B** — what it is, pros, cons
3. **Option C** — ...

## Decision

What we chose and why in one sentence.

## Consequences

What changes as a result. Forward links to files / commits / docs
that implement the decision.

## Revisit when

What signal would prompt re-opening this decision.
```

## Index

| Date | Title | Status |
|---|---|---|
| 2026-05-13 | Eight content formats borrowing WellMor's structural variety | decided |
| 2026-05-15 | Drop Email Chief of Staff from public 15-module catalog | decided |
| 2026-05-15 | Two-path Apple Developer delivery: managed vs owned | decided |
| 2026-05-15 | Onboarding intake moves entirely into the FGA mobile app + web wizard | decided |
| 2026-05-15 | Dual-platform module-aware wizard (mobile + web parity) | decided |
| 2026-05-15 | Manual admin onboarding for friends-and-family | decided |
| 2026-05-15 | Reply-to-email scheduling instead of Cal.com | decided |
| 2026-05-15 | URLs migrate to www subdomain (apex 307s break Universal Links) | decided |
