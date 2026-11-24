# SEP-6 Transaction Lifecycle Monitor (issue #411)

Polls deposit/withdrawal transaction status from a SEP-6 anchor and reports
change detection, stale pending states, and on-chain correlation.

## Run

```bash
SEP6_ANCHOR_URL=https://anchor.example \
SEP6_TRANSACTION_ID=tx-123 \
SEP6_AUTH_TOKEN=<jwt> \
SEP6_POLL_INTERVAL_MS=5000 SEP6_MAX_POLLS=10 SEP6_MAX_RETRIES=3 \
npm run run-example -- 411-sep-6-transaction-lifecycle-monitor
```

Add `JSON_OUTPUT=true` for machine-readable output. The example never initiates
a deposit, withdrawal, or any other financial transaction.

## What it reports

- Current and previous status, observation time, and time in the current status.
- Recognized SEP-6 statuses; unknown values are reported, never treated as success.
- Invalid transitions only where they conflict with lifecycle rules; terminal
  statuses (`completed`, `refunded`, `expired`, `error`) stop monitoring.
- Stale pending transactions, duplicate IDs, missing Stellar hashes, anchor/on-chain
  inconsistencies, and bounded API retry counts.

## Sample output

```text
Transaction: tx-123 (withdrawal)
Status: pending_anchor -> completed
On-chain: verified - A Stellar transaction was retrieved; external bank payout remains unverified.
Result: completed (monitoring stopped)
Anomalies: none
```

## Limitations

A pending transaction is not failed merely because it is slow. Anchor-reported
completion is not independent proof of on-chain settlement, and on-chain
settlement is not proof of external payout. Tests use injected timestamps, so no
real-time delay is required.

See https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0006.md.
