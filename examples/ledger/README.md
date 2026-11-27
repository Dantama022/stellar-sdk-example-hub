# Ledger Metadata and Protocol Version Inspector

A read-only example that inspects a Stellar ledger (by sequence or latest), compares it with its
predecessor, detects protocol version changes, checks application compatibility, and analyzes ledger
close intervals.

## What it does

- Extracts sequence, hash, previous hash, close time, transaction/operation counts, successful
  transaction count, protocol version and base fee from Horizon ledger records.
- Reports fields that are unavailable from the endpoint as `null` instead of fabricating values.
- Compares consecutive ledgers and labels a protocol change as upgrade/downgrade without claiming
  that a version difference alone proves an incompatibility.
- Checks optional minimum and maximum supported protocol versions.
- Calculates close intervals with configurable thresholds and reports missing/invalid timestamps.
- Handles invalid sequence input, missing ledgers, and network failures as report errors.

## Usage

```sh
npx ts-node examples/ledger/ledger-metadata-inspector.ts --sequence 12345 \
  --min-protocol 20 --max-protocol 22 --json

npx ts-node examples/ledger/ledger-metadata-inspector.ts --latest \
  --min-interval-ms 1000 --max-interval-ms 20000
```

Use `--fail-on-error` to exit non-zero when retrieval fails. Programmatic use:

```ts
import { inspectLedger, loadLedgerFromHorizon } from './examples/ledger/ledger-metadata-inspector';
```

## Example output

```text
Ledger metadata inspection report
Network:            Testnet Global Stellar Network ; September 2015
Sequence:           12345
Hash:               abc...
Closed at:          2026-11-25T10:00:00Z
Transactions:       12
Operations:         34
Protocol version:   22
Missing fields:     successfulTransactionCount
Compatibility:      ok: Ledger protocol 22 satisfies the declared compatibility range
Close interval:     normal: Close interval 5000 ms is within the configured thresholds
Protocol change:    upgrade: Protocol version changed from 21 to 22 (upgrade); ...
```

## Tests

```sh
npm test -- --runTestsByPath tests/ledger-metadata-inspector.test.ts
```

Tests use mocked ledger records and deterministic timestamps; no network access is required.

## Limitations

- Horizon and RPC endpoints do not expose identical ledger metadata; absent fields stay `null`.
- A protocol version change is observed at a single ledger and is not proof of a network-wide
  upgrade or of application incompatibility.
- Close intervals are observations, not guarantees about network performance.
