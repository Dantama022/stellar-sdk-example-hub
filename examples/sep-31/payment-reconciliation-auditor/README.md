# SEP-31 Payment Reconciliation Auditor (issue #410)

Read-only audit of a SEP-31 cross-border payment: requested vs reported amounts,
fees, exchange rate, and Stellar settlement.

## Run

```bash
SEP31_ANCHOR_URL=https://anchor.example \
SEP31_TRANSACTION_ID=sep31-123 \
SEP31_AUTH_TOKEN=<jwt> \
npm run run-example -- 410-sep-31-payment-reconciliation-auditor
```

Add `JSON_OUTPUT=true` for machine-readable output. `HORIZON_URL` selects the
network used for on-chain verification. No payment is submitted or modified.

## What it reports

- Assets and requested / reported sending and receiving amounts (kept distinct).
- Available fee components (fixed, percentage, reported total) with an
  effective fee only when the data supports it.
- Discrepancies calculated with scaled integer (`bigint`) arithmetic.
- On-chain transaction verification for payment operations matching asset and
  amount, explicitly separate from anchor-reported delivery.
- `matched`, `mismatch`, `pending`, or `incomplete` status; missing data is never
  treated as zero.

## Sample output

```text
SEP-31 transaction: sep31-123
Status: completed
Requested sending amount: 100.0000000
Reported sending amount: 100.0000000
Reported delivered amount: 95.0000000
On-chain: verified - A matching Stellar payment operation was found on-chain.
Reconciliation status: incomplete
```

## Limitations

Anchors do not expose identical fee fields. Percentage fees cannot be resolved
without the anchor's base and rate. On-chain settlement is not proof of an
external bank payout. Authentication tokens and customer data are never logged.

See https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0031.md
and https://developers.stellar.org/docs/data/horizon/api-reference.
