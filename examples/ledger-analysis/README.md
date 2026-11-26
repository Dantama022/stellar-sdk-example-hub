# #571 — Ledger close times and transaction inclusion timestamps

Read-only illustration of Horizon ledger and transaction pagination with a resumable ledger checkpoint.

## Run

```sh
npx ts-node examples/ledger-analysis/index.ts testnet 100000 100005
# If previous run printed checkpoint {"lastCompletedLedger":100002}, resume:
npx ts-node examples/ledger-analysis/index.ts testnet 100000 100005 100002
```

Use a ledger range that actually exists on the target network. Range is intentionally capped to 100 ledgers per invocation and each Horizon page to 200 transactions. For application use, pass `horizon` in `retrieveTransactionTimestamps` and supply a mock client in tests.

## Interpretation

- `closed_at` on `GET /ledgers/:sequence` is the time when the network closed/included the ledger; the transaction `created_at` is inclusion metadata, **not** the wallet's original submission time.
- Transactions retrieved via `GET /ledgers/:sequence/transactions` are paginated to exhaustion, and duplicate hashes are ignored.
- A checkpoint represents the **last fully retrieved ledger**. The module throws `RetrievalInterruptedError` with that checkpoint if a request fails. Save it durably in your application and re-run from the next ledger. Do **not** advance a checkpoint after a partial page.
- Average interval is based only on consecutive, complete ledger observations and is a sample statistic, not a protocol guarantee. ISO UTC is the default; use `formatLocalTime(timestamp, tz)` for display.
- An empty transaction page does not imply no ledger existed: the ledger metadata must have been fetched successfully first.

## Fixture output

```json
{
  "transactionCount": 2,
  "checkpoint": {"lastCompletedLedger": 11},
  "timing": {
    "earliestCloseUtc": "2026-01-01T00:00:10.000Z",
    "latestCloseUtc": "2026-01-01T00:00:15.000Z",
    "intervalsSeconds": [5],
    "averageIntervalSeconds": "5.000"
  }
}
```

Run the focused mock test: `npx jest --runInBand tests/ledger-close-time.test.ts --coverage=false`.

Sources: [Horizon ledgers](https://developers.stellar.org/docs/data/apis/horizon/api-reference/resources/ledgers), [Horizon transactions](https://developers.stellar.org/docs/data/apis/horizon/api-reference/resources/transactions).
