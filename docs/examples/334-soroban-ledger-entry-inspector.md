# ISSUE-334 — Soroban RPC Ledger Entry Inspector

Read-only inspection of Soroban `LedgerKey` / `LedgerEntryData` using the repository's `@stellar/stellar-sdk` 13.x dependency. No funded account, signing key, deployment, simulation, restoration or TTL extension required.

## Run

From the repository root, with existing Node dependencies:

```bash
# PowerShell: $env:CONTRACT_ID='C...'; $env:STORAGE_KEYS='COUNTER,Admin'
# Bash: export CONTRACT_ID=C... STORAGE_KEYS=COUNTER,Admin
npx ts-node src/examples/334-soroban-ledger-entry-inspector.ts
```

Defaults: `STELLAR_NETWORK=testnet`, `SOROBAN_RPC_URL=https://soroban-testnet.stellar.org`, `CONTRACT_ID=<network-native XLM contract>`, `STORAGE_KEYS=COUNTER`, `RPC_TIMEOUT_MS=8000`. For mainnet explicitly set `STELLAR_NETWORK=mainnet` and `SOROBAN_RPC_URL` to your trusted endpoint; optional `NETWORK_PASSPHRASE` must match the selected network. The service must support `getLedgerEntries` and have the entry in its retention window.

## Example output (illustrative and sanitized)

```json
{"network":"Test SDF Network ; September 2015","contract":"C…","entries":[{"key":"contract instance","status":"found","details":"contract instance; executable=contractExecutableWasm; storage pairs=0 (schema-dependent)"},{"key":"COUNTER (persistent)","status":"missing","details":"not present, expired, archived or inaccessible"}]}
```

## What is and is not decoded

`LedgerKey` identifies an entry; a response returns its `LedgerEntryData` value and ledger metadata. Contract instance information is different from persistent and temporary data under a named `ScVal` key. An instance contains an executable reference and optional instance-scoped storage. Persistent and temporary keys exist in independent durability namespaces. A known primitive SCVal can be rendered for illustration, but complex data types need contract-specific schema knowledge. Missing data is not interpreted as zero, nor does its absence prove the contract lacks other storage keys. RPC cannot enumerate arbitrary contract keys; supply keys learned from ABI/source. Archival/retention can hide historical state. Never mistake raw XDR decoding for semantic reconstruction.

Timeout, malformed responses, invalid contract IDs, unknown keys and unavailable RPC endpoints are reported separately where distinguishable. The endpoint is never used to submit or simulate any transaction. Live endpoint behavior needs an accessible Soroban RPC; automated tests use mocks.

References: https://developers.stellar.org/docs/data/apis/rpc/api-reference/methods/getLedgerEntries ; https://stellar.github.io/js-stellar-sdk/reference/network-rpc/
