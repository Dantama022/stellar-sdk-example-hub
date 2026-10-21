# ISSUE-344 — Incremental Horizon pagination with durable checkpoints

Run with existing project dependencies: `npm run run-example -- 344-horizon-resumable-pagination`. The default reads **public testnet** operations, never submits transactions and requires no private key. To select another collection, set `HORIZON_COLLECTION_URL=https://horizon-testnet.stellar.org/accounts/G.../operations` or a compatible Horizon `/transactions` collection. Optional `HORIZON_CHECKPOINT=.horizon-resume.json` stores progress locally. The scanner processes at most 20 records per demo run; adjust `maxRecords` for longer controlled scans. Exclude checkpoint files from commits; although only cursors and endpoint are written, collection URLs may carry account context.

Horizon HAL collections provide `_embedded.records` and `_links.next.href`. Each record includes `paging_token` for cursor continuation. Requests always use **ascending** order and follow the server's same-origin/same-collection `next` URL, rather than guessing which tokens to use. If no records remain, scanning stops. The utility can handle a large collection without accumulating previous pages in memory; it invokes an async callback one record at a time.

Checkpoint schema:

```json
{"version":1,"endpoint":"https://horizon-testnet.stellar.org/operations","order":"asc","cursor":"123456789"}
```

After **each successful callback**, `JsonFileCheckpoint.save()` writes a temporary JSON file and renames it over the checkpoint. On interruption, rerun with the same endpoint. A callback error never advances the checkpoint past that record. A stale or invalid checkpoint raises an actionable error; inspect it manually and reset deliberately instead of silently starting over.

**Delivery semantics: at least once**, not exactly once. If your callback completed a side effect but the checkpoint write failed, that record will be replayed on restart. Use stable IDs / paging tokens to make consumer side effects idempotent (for example, a unique record-key constraint). A single scanner should own a checkpoint file; atomic renaming is not a distributed lock.

HTTP 429 and 5xx plus transient network errors are retried with bounded exponential backoff (2 retries by default); non-retryable 4xx and invalid response shapes stop the scan. Consider Horizon retention and data availability: old cursor data may disappear on limited-retention endpoints. The utility requires the same collection and direction when resuming; account and network changes demand a new checkpoint. It only accepts HTTPS (or explicit localhost HTTP) and same-origin server-provided next links.

Representative output:

```text
Processed cursor 123456780
Processed cursor 123456781
Processed 2 records; checkpoint stored at .horizon-resume.json
```

References: [Horizon pagination](https://developers.stellar.org/docs/data/apis/horizon/api-reference/structure/pagination), [Horizon transaction resource](https://developers.stellar.org/docs/data/apis/horizon/api-reference/resources/transactions/object).
