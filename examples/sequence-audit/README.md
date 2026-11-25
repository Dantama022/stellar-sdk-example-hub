# #581 / ISSUE-401 — Account Sequence History & Ordering Audit

Read-only Horizon account-history example. It never submits, signs, or reserves sequence numbers.

## Run

```bash
node -r ts-node/register examples/sequence-audit/account-sequence-history.ts G_VALID_ACCOUNT_ID testnet
node -r ts-node/register examples/sequence-audit/account-sequence-history.ts G_VALID_ACCOUNT_ID testnet 100000 110000
```

Optional fourth/fifth arguments are inclusive ledger range filters; results are fetched from Horizon in ascending order with `limit=200` pages, then filtered by ledger. The programmatic `maxPages` option defaults to 10 and has a hard limit of 100. Increase it for longer histories; incomplete pagination is disclosed. This does not promise complete historical coverage when the requested range exceeds what Horizon serves.

## Method

Horizon `source_account_sequence` is the **account's consumed sequence**; `ledger` is a **network ledger number**. They are completely different fields. The audit sorts records by ledger then `paging_token` (ledger inclusion order), deduplicates by hash and assesses progression **independently by transaction source**. Repeated sequences, apparent gaps and non-increasing ordering are reported, as is retrieval/pagination disorder. Account's current `sequence` is compared with the largest confirmed sequence from the retrieved portion.

Illustrative history for the same source account: sequence `8, 9, 11, 11` produces one **apparent** gap (`10`) and one repeat (`11`). Current sequence `12` differs from the highest observed `11` by 1.

## Limitations

A jump is **not evidence of a failed or lost transaction**. `bump_sequence`, filtering, incomplete/purged history, fee bumps and unrelated account activity can affect observable progression. Transactions with other sources are analyzed in their own groups; they are not compared with the queried account's sequence. Locally prepared, reserved or unsubmitted transactions cannot be inferred from confirmed Horizon data. Reports include pagination completeness and confidence limitations.

Docs: https://developers.stellar.org/docs/data/apis/horizon/api-reference/resources/transactions/object and https://developers.stellar.org/docs/learn/fundamentals/transactions/operations-and-transactions

Example report fields (illustrative):

```json
{
  "recordsAnalyzed": 4,
  "highestConfirmedSequence": "11",
  "currentAccountSequence": "12",
  "currentMinusHighest": "1",
  "apparentGaps": [ { "source": "ACCOUNT", "from": "9", "to": "11", "missing": "1" } ],
  "paginationComplete": true,
  "confidence": "bounded-to-retrieved-history"
}
```
