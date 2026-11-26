# #572 — Historical transaction fee analysis

Read-only Horizon analysis of **actual fees charged**, separately from **maximum fees bid**.

## Run

```sh
npx ts-node examples/fee-analytics/index.ts testnet 100000 100005
```

Uses `GET /ledgers/:sequence/transactions` with complete pagination (up to 500 ledgers per request), reading `fee_charged` and optional `max_fee`. Both fields are in **stroops** (10,000,000 stroops per XLM). Validates integer fee amounts; unsafe JS numeric fee values are rejected. The output is JSON-safe strings rather than bigint values.

The report includes `totalStroops`, `totalXlm`, count, min, max, median, average, bucket counts, and per-ledger totals/counts/change from previous observed ledger. Means/medians use integer arithmetic with exact fractional representations. Buckets can be supplied to `analyzeFees`; buckets must be disjoint and cover all nonnegative fees.

## Example (deterministic fixture, not live data)

Three transactions with actual fees 100, 200 and 300 stroops, maximum bid of 300 stroops each:

```json
{
  "statistics": {
    "count": 3,
    "totalStroops": "600",
    "totalXlm": "0.0000600",
    "averageStroops": "200.0000",
    "medianStroops": "200",
    "minStroops": "100",
    "maxStroops": "300"
  }
}
```

The fee bid is **not** assumed to equal the charged fee. An increase in a ledger's aggregate fees may reflect transaction volume, mix, and network pricing; it is not by itself evidence of congestion. A missing historical page aborts the analysis rather than silently omitting it. No signing keys or transaction submissions are used.

Run: `npx jest --runInBand tests/fee-analytics.test.ts --coverage=false`.

Sources: [Stellar fee model](https://developers.stellar.org/docs/learn/fundamentals/fees-resource-limits-metering), [Horizon transaction fields](https://developers.stellar.org/docs/data/apis/horizon/api-reference/resources/transactions).
