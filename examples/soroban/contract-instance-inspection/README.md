# Soroban Contract Instance Inspection

A read-only TypeScript example that fetches a Soroban contract's **instance ledger entry**, decodes the `ScVal` values in its instance storage, and reports which executable (Wasm hash or built-in asset code) the instance points to.

Nothing is signed or submitted. Only two RPC methods are called: `getNetwork` (to check the endpoint matches the requested network) and `getLedgerEntries`.

## Concepts

### Instance storage
Every contract has exactly one **instance entry**: a `ContractData` ledger entry with

- key: the special ScVal `scvLedgerKeyContractInstance`
- durability: `persistent`
- value: an `scvContractInstance` holding an `executable` and an optional `storage` map.

The `storage` map is *instance storage*: a small key/value map that is loaded and expires together with the instance (typically used for configuration such as admin or metadata). It is **not** the same as the contract's separate `persistent` or `temporary` data entries, which are individual ledger entries with their own keys and TTLs. This example does not read those.

### Instance vs. executable code
The instance only contains a *reference* to code:

| Executable | Meaning |
| --- | --- |
| `contractExecutableWasm` | a 32-byte hash of the Wasm. The bytecode lives in a separate `contractCode` ledger entry keyed by that hash. |
| `contractExecutableStellarAsset` | a Stellar Asset Contract; code is built into the host, no Wasm exists. |

Retrieving the instance never retrieves the Wasm. Many instances can share one hash. This example reports the hash and leaves fetching `contractCode` out on purpose (see `examples/wasm-*` in this repo for Wasm analysis).

### ScVal in XDR
All Soroban values are `ScVal`, an XDR union discriminated by type (`scvBool`, `scvU32`, `scvI128`, `scvSymbol`, `scvVec`, `scvMap`, `scvAddress`, ...). RPC returns ledger entries as base64 XDR. `decoder.ts` turns each arm into a JSON-safe form:

| ScVal | Output `value` |
| --- | --- |
| bool, void, u32, i32 | boolean / `null` / number |
| u64, i64, u128, i128, u256, i256, timepoint, duration | exact decimal **string** (no precision loss) |
| bytes | hex string |
| string, symbol | text (strings that are not valid UTF-8 are flagged and shown as hex) |
| address | `G...` / `C...` strkey |
| vec, map | arrays of decoded values / `{key, value}` pairs |
| error, nested instance/ledger-key values, anything unknown | not decoded: `supported: false` and the original base64 `xdr` is kept |

Decoding never throws; one bad value does not abort the inspection.

## Files

| File | Role |
| --- | --- |
| `inspector.ts` | address validation, networks, instance key construction, RPC retrieval, result assembly |
| `decoder.ts` | pure XDR → readable decoding (no network) |
| `types.ts` | result and error types |
| `index.ts` | CLI |
| `inspection.test.ts` | tests with mocked RPC and hand-built XDR |

## Setup and usage

Requires Node 18+.

```bash
cd examples/soroban/contract-instance-inspection
npm install

# testnet (default)
npx ts-node index.ts CA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUWDA

# mainnet, with your own RPC provider
npx ts-node index.ts <CONTRACT> --network mainnet --rpc-url https://your-provider.example
# or: SOROBAN_RPC_URL=... npx ts-node index.ts <CONTRACT> --network mainnet
```

Options: `--network testnet|mainnet`, `--rpc-url URL`, `--include-xdr` (attach XDR to every value), `--no-values` (print only types, not decoded values or raw XDR, for logs that may be shared). Exit code is `0` on success, `1` if the inspection failed, `2` for bad arguments.

Networks are selected explicitly. The tool compares the endpoint's passphrase with the requested network and fails with `NETWORK_MISMATCH` rather than querying the wrong chain. The default mainnet URL is a community endpoint; use your own provider for anything important, and keep API keys out of the repo (pass them via `--rpc-url` or the environment).

Programmatic use:

```ts
import { inspectContractInstance } from './inspector';
const result = await inspectContractInstance(address, { network: 'testnet' });
```

### Result shape

```jsonc
{
  "status": "ok",                     // "ok" | "not_found" | "error"
  "contractAddress": "C...",
  "network": "testnet",
  "networkPassphrase": "...",
  "instance": {
    "executable": { "type": "wasm", "wasmHash": "ab12..." },
    "storageEntryCount": 2,
    "lastModifiedLedgerSeq": 400,
    "liveUntilLedgerSeq": 900,
    "latestLedger": 500,
    "entryXdr": "AAAA..."             // original LedgerEntryData
  },
  "storage": [
    { "index": 0, "key": { "type": "scvSymbol", "supported": true, "value": "Admin" },
                  "value": { "type": "scvAddress", "supported": true, "value": "G..." } }
  ],
  "warnings": [],
  "error": { "code": "INSTANCE_NOT_FOUND", "message": "..." }   // only when not ok
}
```

Error codes: `INVALID_ADDRESS`, `NETWORK_MISMATCH`, `RPC_UNAVAILABLE`, `INSTANCE_NOT_FOUND`, `INVALID_LEDGER_ENTRY`, `XDR_DECODE_FAILED`. A missing instance can also mean the entry has **expired** and been archived; it would need a restore operation, which this read-only example never performs.

## Tests

```bash
npm test          # jest, mocked RPC, deterministic
npm run typecheck
```

Tests cover address validation, instance retrieval, missing instance, RPC failure, network mismatch, bool/number/string/symbol/bytes/vec/map/address decoding, unsupported values, malformed XDR, and executable inspection.

## Limitations

- **Unknown storage layouts.** Keys are contract-defined. A symbol key like `Admin` is a convention, not a guarantee, and many contracts use enum-shaped keys (vectors such as `["Balance", <address>]`). Without the contract spec (its `contractspecv0` Wasm section), values are shown as decoded data, never as named application fields.
- Only the instance's storage map is inspected, not separate persistent/temporary data entries.
- Wasm bytecode and the contract spec are not fetched.
- Values may contain sensitive application data; use `--no-values` before sharing output.
- `getLedgerEntries` returns only live entries; archived instances appear as not found.
- Verified against `@stellar/stellar-sdk` 13.3.0. The raw-response helper `_getLedgerEntries` is used so the original XDR is available; the public `getLedgerEntries` returns already-parsed XDR objects instead.
