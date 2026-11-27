# 262 — Soroban Contract Deployment Verification and Configuration Audit

Verifies that an existing Soroban deployment matches a local manifest. The
example confirms the contract exists on the expected network, references the
expected executable, exposes the expected Wasm hash where applicable, and
publishes the expected interface.

The audit is **read-only**. It calls only `getNetwork`, `getLatestLedger` and
`getLedgerEntries`. It never builds, signs, simulates or submits a transaction,
and it never deploys or upgrades a contract.

## What is checked

| Check                 | Source                                               | Failure classification                   |
| --------------------- | ---------------------------------------------------- | ---------------------------------------- |
| Manifest shape        | Local validation                                     | `INVALID_MANIFEST` (no RPC call is made) |
| Network passphrase    | `getNetwork`                                         | mismatch / unavailable                   |
| Contract availability | `getLedgerEntries` on the instance key               | `not_found` / inconclusive on RPC error  |
| Executable type       | `ScContractInstance.executable`                      | mismatch / inconclusive                  |
| Wasm hash             | Wasm executable hash vs manifest                     | mismatch / inconclusive                  |
| Interface             | `contractspecv0` custom section of the deployed Wasm | mismatch / unavailable                   |

A matching contract address, a metadata file, or matching metadata alone never
establish that two deployments are equivalent — the executable hash and the
interface are verified separately.

`unavailable`, `not_applicable` and other incomplete checks are reported as
**inconclusive**, never as a pass. For example, an interface that could not be
retrieved is not the same thing as an incompatible interface.

## Setup

```bash
npm install
npm test -- --runInBand tests/soroban-deployment-verification.test.ts
```

No credentials, secret keys or funded accounts are required: every call is a
read against a public Soroban RPC endpoint.

## Usage

Run the bundled Testnet sample (the built-in Stellar Asset Contract, which
demonstrates the non-Wasm executable path):

```bash
npm run run-example 281-soroban-deployment-verification
```

Audit your own deployment with a manifest file:

```bash
MANIFEST_FILE=./manifests/testnet.json \
  npm run run-example 281-soroban-deployment-verification
```

Emit machine-readable output:

```bash
MANIFEST_FILE=./manifests/production.json JSON_OUTPUT=true \
  npm run run-example 281-soroban-deployment-verification
```

### Environment variables

| Variable           | Purpose                                      |
| ------------------ | -------------------------------------------- |
| `MANIFEST_FILE`    | Path to a deployment manifest JSON file      |
| `MANIFEST_ENV`     | Select a bundled sample manifest (`testnet`) |
| `CONTRACT_ID`      | Override the manifest contract address       |
| `SOROBAN_RPC_URL`  | Override the manifest RPC endpoint           |
| `JSON_OUTPUT=true` | Print the structured report as JSON          |

Command-line overrides are applied before validation, so an invalid override is
reported without any network request.

## Manifest format

```json
{
  "environment": "testnet",
  "contractId": "C...",
  "network": {
    "name": "testnet",
    "passphrase": "Test SDF Network ; September 2015",
    "rpcUrl": "https://soroban-testnet.stellar.org"
  },
  "executable": {
    "type": "wasm",
    "wasmHash": "64-hex-character-sha256-of-the-uploaded-wasm"
  },
  "interface": {
    "functions": [
      { "name": "balance", "inputs": [{ "name": "id", "type": "address" }], "outputs": ["i128"] },
      {
        "name": "transfer",
        "inputs": [
          { "name": "from", "type": "address" },
          { "name": "to", "type": "address" },
          { "name": "amount", "type": "i128" }
        ],
        "outputs": []
      }
    ],
    "allowAdditionalFunctions": false
  },
  "metadata": { "release": "v1.2.3", "commit": "abc1234" }
}
```

- `executable.type` is `"wasm"` or `"builtin"`. A Wasm manifest must declare
  `wasmHash`; a built-in executable (such as the Stellar Asset Contract) has no
  hash to compare.
- `interface.functions[].inputs` and `outputs` are optional. When provided, the
  argument and return types are compared in order using the names reported by the
  contract spec (`address`, `i128`, `Vec<symbol>`, `void`, …).
- Functions prefixed with `__` (for example `__constructor`) are internal spec
  entries and are ignored by the comparison.
- `metadata` is informational only and never affects the verdict.
- Keep one manifest per environment and point `MANIFEST_FILE` at the right file,
  or select a bundled sample with `MANIFEST_ENV`.

## Output

The text report contains:

1. Contract address, environment, network and the verified passphrase.
2. Availability: latest ledger, instance `lastModifiedLedgerSeq` and TTL.
3. Executable: expected/retrieved type and expected/retrieved Wasm hash.
4. Interface: expected and retrieved function sets, missing/unexpected functions
   and signature mismatches.
5. Configuration audit: mismatches, warnings and inconclusive checks.
6. An overall verdict: `VERIFIED`, `FAILED` or `INCONCLUSIVE`.

`JSON_OUTPUT=true` returns the same information as a single JSON object.

## Limitations

- Contract availability requires the instance entry to be live. Archived entries
  surface as an inconclusive RPC error; restoring them is out of scope.
- The interface is read from the `contractspecv0` custom section of the deployed
  Wasm. Contracts deployed without that section publish no specification, and
  built-in executables have no Wasm to inspect: both cases are reported as
  unavailable rather than incompatible.
- Only exported function names, argument/return types and the presence of extra
  functions are compared; documentation, error enums and struct layouts are not
  audited.
- URIs in the manifest are validated syntactically. Whether an endpoint is the
  intended deployment is decided by the passphrase check and the ledger entries
  it returns.
