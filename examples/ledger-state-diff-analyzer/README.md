# Ledger state snapshot and diff analyzer (#568)

Read-only comparison of two **observations** of Stellar ledger state. No live polling or historical index is introduced.

## Capture the *current* state via Stellar RPC

`getLedgerEntries` accepts **base64 XDR LedgerKey** values (`keys`, maximum 200). To obtain them, use the existing SDK XDR ledger-key constructors or Stellar Laboratory. Do **not** supply an account ID in place of the base64 ledger key.

```bash
npx ts-node examples/ledger-state-diff-analyzer/index.ts --rpc=https://soroban-testnet.stellar.org --keys=BASE64_LEDGER_KEY --json > snapshot-a.json
# At a later ledger (or from another machine):
npx ts-node examples/ledger-state-diff-analyzer/index.ts --rpc=https://soroban-testnet.stellar.org --keys=BASE64_LEDGER_KEY --json > snapshot-b.json
npx ts-node examples/ledger-state-diff-analyzer/index.ts --snapshot-a=snapshot-a.json --snapshot-b=snapshot-b.json
```

Or compare a saved snapshot to a freshly retrieved current snapshot using `--snapshot-a=... --rpc=... --keys=...`. Output is readable formatted JSON or compact JSON with `--json`.

**Important protocol limitation:** The documented RPC `getLedgerEntries` returns the **current** ledger value with `latestLedger`, not historical state at an arbitrary selected ledger number. This example does **not** send an unsupported historical-ledger parameter. For historical comparisons, obtain two snapshots at the desired times from an archival indexer or snapshots previously captured while those ledgers were current. If an older state is unavailable, report `unavailable` rather than a confirmed deletion.

## Input snapshot structure

```json
{
  "ledger": 120,
  "observedAt": "2026-11-22T10:00:00Z",
  "source": "offline-fixture",
  "entries": [
    { "id": "ledger-key-a", "type": "account", "status": "present", "value": { "balance": "12.0000000", "flags": { "authRequired": false } } },
    { "id": "ledger-key-b", "type": "contractData", "status": "unavailable" }
  ]
}
```

Supported state categories are distinguished by the XDR `LedgerEntryData` discriminant (account, trustline, offer, contractData, contractCode and others). Live RPC XDR is re-serialized canonically for **exact entry-level** comparisons, while supplied parsed `value` objects support **field-level** path changes. There is no claim to decode every XDR variant into a stable field-level JSON schema. The RPC's `xdrFormat=json` is deliberately avoided because its JSON schema is not guaranteed stable across protocol versions.

## Sample comparison

```json
{
  "fromLedger": 120, "toLedger": 122,
  "entries": [{ "id": "ledger-key-a", "type": "account", "status": "modified", "fields": [
    { "path": "$.value.balance", "before": "12.0000000", "after": "13.0000000" }
  ] }],
  "counts": { "added": 0, "modified": 1, "removed": 0, "unchanged": 0, "inconclusive": 0 }
}
```

IDs are deduplicated; absent (confirmed in captured current response), missing snapshot and unavailable are **different** states. Comparison results do not prove a complete history of every intermediate mutation. Malformed XDR, RPC errors and incomplete snapshots produce errors or warnings.

Official: [RPC getLedgerEntries](https://developers.stellar.org/docs/data/apis/rpc/api-reference/methods/getLedgerEntries), [Stellar XDR](https://developers.stellar.org/docs/learn/fundamentals/data-format/xdr).
