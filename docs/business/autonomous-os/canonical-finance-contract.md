# Canonical Finance Calculation and Reconciliation Contract

Status: calculation foundation only; no production route or close-month behavior is wired.

The Phase 1 finance foundation lives in
`core/finance/canonical-calculation.js`. It is pure and tenant-agnostic: a
tenant-scoped caller must load the inputs, then pass them to the contract. The
module performs no database, Stripe, banking, lock, or notification action.

## Money representation

All calculations use safe integer minor units. For USD, `"12.34"` becomes
`1234`. Major-unit values are parsed as base-10 text, not added as JavaScript
floating-point values. Non-zero precision beyond the currency exponent is
rejected rather than rounded. Values outside JavaScript's safe integer range
are rejected.

Callers should pass database `numeric` values as strings. A caller may instead
provide an integer `amountMinor`. The result reports only integer minor units.

## Entry input

Each ledger entry requires:

- `id`: durable, unique identity.
- `kind` (or legacy `entry_type`): `income`, `expense`,
  `owner_contribution`, `owner_draw`, `sales_tax_collected`, or
  `sales_tax_paid`.
- `amount` in major units, or `amountMinor` in integer minor units.
- `currency`: defaults to the calculation currency but must match it.
- `authority`: `authoritative`, `provisional`, or `unknown`. Missing values
  become `unknown`; they never become authoritative implicitly.
- `attribution`: `attributed`, `unattributed`, or `unknown`. Missing values
  become `unknown`.

Authority and attribution are independent. An amount may be authoritative but
still unattributed, or attributed but still provisional. The output preserves
both dimensions and separately totals ledger, authoritative, unattributed,
unverified, and unknown-attribution amounts.

Owner equity and sales-tax pass-through entries are reported in their own
buckets and do not affect operating net income.

An empty entry set is blocked as missing ledger evidence unless the caller
supplies `zeroActivityAttested: true`. That attestation means the tenant-scoped
adapter positively established that the period had no ledger activity; an
empty query result caused by a failed or skipped read must not use it.

## Reconciliation input

Each reconciliation check requires:

- `id` and `currency`.
- `evidenceStatus: "available"` before it can be evaluated.
- `authoritativeAmount` or `authoritativeAmountMinor`.
- `ledgerAmount` or `ledgerAmountMinor`.

The signed difference is `ledger - authoritative`; the unreconciled amount is
the sum of absolute differences across checks. If any evidence is unavailable
or invalid, `unreconciledMinor` is `null`, not zero. The known subtotal remains
available as `knownUnreconciledMinor` but cannot be presented as complete.

## Close and signoff gate

`controls.canClose` and `controls.canSignOff` are true only when:

1. every entry is valid and uniquely identified;
2. every entry is explicitly authoritative and attributed;
3. at least one reconciliation check has available evidence; and
4. every reconciliation difference is exactly zero minor units; and
5. an empty period has an explicit zero-activity attestation.

Any invalid input, missing evidence, unknown authority, unresolved attribution,
currency mismatch, duplicate identity, or one-minor-unit difference blocks both
actions. `health.isGreen` is true only for that verified state. This prevents a
missing bank feed, skipped row, or unavailable comparison from appearing as a
zero difference or a healthy close.

## Compatibility and activation plan

Existing finance routes continue to return their current major-unit number
fields and are unchanged by this foundation. Integration should be additive:

1. Build a tenant-scoped adapter that selects explicit finance columns and
   converts database `numeric` values to strings.
2. Map legacy authority and attribution evidence explicitly. Unmapped rows
   remain `unknown`; do not infer green status.
3. Run the canonical result in shadow mode beside existing summaries and store
   differences as evidence without changing client-visible totals.
4. Reconcile Stripe gross receipts, processing fees, bank/payout evidence, and
   the tenant ledger with durable source identifiers.
5. Add the canonical gate to a versioned close endpoint behind a
   disabled-by-default tenant allowlist. Keep the legacy endpoint unchanged
   until shadow evidence and rollback tests pass.
6. Only then route close/signoff through an atomic database operation that
   rechecks the evidence revision inside the lock transaction.

No production close, migration, or customer-visible behavior is activated by
this module.
