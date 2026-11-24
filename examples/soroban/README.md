# Soroban Contract State Snapshot and Upgrade Regression Comparison

This example (ISSUE-417) demonstrates how to capture Soroban contract state at a point in time, persist it as a versioned JSON snapshot, and compare two snapshots to identify what changed between ledger positions — including during an upgrade review.

## Files

| File | Purpose |
|---|---|
| `src/examples/262-contract-state-snapshot.ts` | Retrieve ledger entries, build snapshots, persist to JSON |
| `src/examples/263-state-snapshot-diff.ts` | Compare two snapshots, generate a diff report |
| `tests/contract-state-snapshot.test.ts` | Full test suite (76 tests, offline / mocked RPC) |

## Concepts

### Snapshots

A snapshot captures the contract instance entry, the WASM code entry (when the contract uses a WASM executable), and any extra ledger keys you supply.  Each snapshot is a versioned JSON file with:

- `contractId` and `network` — used to reject comparisons between incompatible snapshots.
- `ledgerSequence` and `capturedAt` — record when the snapshot was taken.
- `fingerprint` — a SHA-256 over the stable-serialised entries array.  Two snapshots with identical state produce the same fingerprint.
- `entries` — one `SnapshotEntry` per queried ledger key, sorted by key for determinism.

Each entry carries:

- `ledgerKey` — canonical base64-encoded XDR `LedgerKey`.
- `role` — `instance`, `code`, `storage`, or `other`.
- `durability` — `persistent`, `temporary`, or `unknown`.
- `status` — `found` or `unavailable`.
- `fingerprint` — SHA-256 of the entry's key and value XDR.  Unchanged between snapshots when neither the key nor the value changed.
- `unavailableReason` — set when the entry could not be retrieved (not found, archived, expired, RPC error).

### Fingerprints

Fingerprints are deterministic SHA-256 digests calculated over stable JSON (keys sorted at every depth).  A TTL-only bump does not change the entry fingerprint because TTL metadata (`liveUntilLedgerSeq`) is excluded from the fingerprint input.

### Comparison

`diffSnapshots` matches entries by their `ledgerKey` and classifies each pair:

| Kind | Meaning |
|---|---|
| `created` | Present in the comparison snapshot but not the baseline |
| `removed` | Present in the baseline but not the comparison |
| `modified` | Present in both; fingerprints differ |
| `unchanged` | Present in both; fingerprints match |
| `unverifiable` | Unavailable in both snapshots; cannot be compared |

### Upgrade review mode

Pass `upgradeReview: true` to `diffSnapshots` to enable additional analysis:

- Whether the `instance` or `code` entry changed.
- An optional `allowlist` of ledger keys whose changes are expected.  Any modification or removal outside the allowlist is flagged as unexpected.

**Important:** a detected state change does not by itself establish that a contract upgrade caused it.  State can change from normal contract invocations or other operations entirely unrelated to an upgrade.  This tool reports observations only.

## Usage

### Capture a snapshot

```typescript
import { captureSnapshot } from './src/examples/262-contract-state-snapshot';

const snapshot = await captureSnapshot({
  rpcUrl: 'https://soroban-testnet.stellar.org',
  contractId: 'C…',
  network: 'testnet',
  outputFile: 'snapshots/before.json',
});
```

Supply `extraLedgerKeys` (base64 XDR `LedgerKey` values) to include additional storage entries in the snapshot.

### Compare two snapshots

```typescript
import { compareSnapshotFiles } from './src/examples/263-state-snapshot-diff';

const report = compareSnapshotFiles('snapshots/before.json', 'snapshots/after.json', {
  upgradeReview: true,
  allowlist: ['<expected-key-xdr>'],
  outputFile: 'snapshots/diff-report.json',
});

console.log(report.status);              // 'identical' | 'changed'
console.log(report.modified.length);     // number of modified entries
console.log(report.upgradeReview?.unexpectedModifications);
```

### Render a human-readable report

```typescript
import { renderReport } from './src/examples/263-state-snapshot-diff';

console.log(renderReport(report));
```

## Snapshot format

```jsonc
{
  "version": 1,
  "snapshotId": "a1b2c3d4e5f6a7b8",
  "contractId": "C…",
  "network": "testnet",
  "ledgerSequence": 123456,
  "capturedAt": "2024-01-01T00:00:00.000Z",
  "fingerprint": "<sha256-hex>",
  "entries": [
    {
      "ledgerKey": "<base64-xdr>",
      "entryType": "contractData",
      "durability": "persistent",
      "role": "instance",
      "status": "found",
      "keySize": 76,
      "valueSize": 148,
      "fingerprint": "<sha256-hex>",
      "lastModifiedLedgerSeq": "123400",
      "liveUntilLedgerSeq": "223456",
      "valueXdr": "<base64-xdr>"
    }
  ]
}
```

The format is versioned (`version: 1`).  `compareSnapshotFiles` rejects files with a missing, mismatched, or unsupported version field.

## Limitations

- **No historical state retrieval.**  Both snapshots are captured from the live current ledger of whatever RPC endpoint is queried.  RPC providers are not required to serve arbitrary historical ledger states, and this example does not assume they can.
- **Arbitrary storage keys.**  Only the keys you explicitly supply via `extraLedgerKeys` are included in the snapshot.  There is no general mechanism to enumerate all storage keys for a contract from the RPC layer alone.
- **Unavailable entries.**  Archived or expired entries are recorded with `status: 'unavailable'` and classified as `unverifiable` in a diff.  The example reports this clearly rather than silently skipping the entry.

## Running the tests

```bash
npx jest tests/contract-state-snapshot.test.ts
```

All 76 tests run offline using mocked RPC responses and deterministic XDR fixtures.  No live network connection is required.
