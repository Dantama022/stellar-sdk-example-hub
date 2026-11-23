# #573 — Account data entry change history and audit trail

This **read-only** example combines the *current* account `data` map from Horizon with **historical `data_created`, `data_updated`, and `data_removed` effects** retrieved via `GET /accounts/:id/effects`. It never claims the current account response supplies the history.

## Run

```sh
npx ts-node examples/account-data/index.ts testnet <G_ACCOUNT> 100000 100005
```

Use a real account, valid network, and retained ledger range. The default account effect query starts from the earliest Horizon-retained cursor and traverses until exhausted; it fails explicitly if the 10,000-effect safety cap is exceeded. For long-lived accounts, a retained archival source and externally persisted checkpoints are preferable. The example resolves ledger sequence by following each effect's operation link to its transaction and using the transaction's `ledger` field. Missing transaction metadata is marked as incomplete, never assigned a fictional ledger.

## Semantics and limitations

- Horizon `data_*` effects document **observable** creation/update/removal events, not every possible earlier ledger state; service history may be pruned.
- Account data values are base64-encoded arbitrary bytes. `valueBase64` preserves the original representation. `valueUtf8` is null when bytes cannot be decoded as strict UTF-8.
- Previous values are only trustworthy if a verified starting snapshot is supplied. `buildAudit` can receive `initialState: Record<string,string>` where values are base64. This must be the state **immediately before** the first event included in the analysis, not the present-day state.
- The reconstructed state is provisional unless `history.complete=true` has been independently verified by an archival process and the initial state is known. `retrieveDataHistory` always sets `complete=false`: a Horizon response alone cannot certify unbroken historical coverage.
- `filter` can select by key, event type, ledger sub-range or transaction hash; reconstruction still processes all supplied changes before filtering output.
- Missing metadata, malformed values, duplicates and unavailable network requests produce explicit errors/warnings. A complete exhaustive archive (for example ledger-close metadata ingestion) is required for a formal/auditable record.

## Example timeline (mock fixture)

```json
{
  "accountId": "<G_ACCOUNT>",
  "counts": {"examined": 3, "created": 1, "updated": 1, "removed": 1},
  "timeline": [
    {"ledger": 10, "key": "app", "type": "create", "valueBase64": "b25l"},
    {"ledger": 11, "key": "app", "type": "update", "valueBase64": "dHdv"},
    {"ledger": 12, "key": "app", "type": "remove", "valueBase64": null}
  ],
  "complete": false,
  "currentComparison": "inconclusive"
}
```

Run: `npx jest --runInBand tests/data-entry-history.test.ts --coverage=false`.

Sources: [Horizon account effects](https://developers.stellar.org/docs/data/apis/horizon/api-reference/list-effects-for-account), [account data](https://developers.stellar.org/docs/data/apis/horizon/api-reference/resources/accounts), [Stellar ingestion ledger changes](https://developers.stellar.org/docs/data/indexers/build-your-own/ingest-sdk/examples/changes).
