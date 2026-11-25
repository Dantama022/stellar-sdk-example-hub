# Soroban Cross-Network Compatibility Checker

**Example 262 — ISSUE-432**

Demonstrates how to test whether a Soroban contract can be inspected and invoked consistently across multiple Stellar network environments. The example is entirely read-only: it never signs or submits transactions.

---

## What it does

1. **Validates network configuration** — checks that each RPC endpoint is reachable and returns the configured network passphrase.
2. **Checks contract availability** — queries each network independently to determine whether the contract instance exists.
3. **Inspects contract interfaces** — retrieves the contract WASM, parses the embedded `contractspecv0` spec section, and extracts function signatures for comparison.
4. **Simulates read-only invocations** — builds an unsigned transaction and runs it through `simulateTransaction` on each network without submitting.
5. **Compares results** — identifies differences in availability, interface compatibility, return values, and resource usage.
6. **Generates a report** — produces a structured `CompatibilityReport` summarising every finding.

---

## Configuration

| Environment variable          | Default                                | Description                                |
|-------------------------------|----------------------------------------|--------------------------------------------|
| `TESTNET_RPC_URL`             | `https://soroban-testnet.stellar.org`  | Soroban RPC URL for the first network      |
| `TESTNET_CONTRACT_ADDRESS`    | SAC hello-world contract address       | Contract to inspect on the first network   |
| `TESTNET_ALT_RPC_URL`         | `https://soroban-testnet.stellar.org`  | Soroban RPC URL for the second network     |
| `TESTNET_ALT_CONTRACT_ADDRESS`| same as above                          | Contract to inspect on the second network  |
| `CONTRACT_FUNCTION`           | `hello`                                | Contract function to simulate              |

You can also supply `NetworkConfig[]` and `functionName` directly when calling `run()` from TypeScript.

---

## Running the example

```bash
# From the workspace root
ts-node src/examples/262-cross-network-compatibility.ts

# With environment variables
TESTNET_CONTRACT_ADDRESS=CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC \
TESTNET_ALT_CONTRACT_ADDRESS=CDVSGPL3HFBGJ6ZEYQUAVE3OH3XE2ZE5ZT2GWPA3LKOYVD4UBPQJ2VHB \
CONTRACT_FUNCTION=hello \
  ts-node src/examples/262-cross-network-compatibility.ts
```

---

## Running the tests

```bash
npx jest tests/cross-network-compatibility.test.ts
```

All tests use mocked RPC clients. No live network access is required.

---

## Exported API

| Export | Purpose |
|---|---|
| `validateRpcUrl(url)` | Throw if the URL is not http(s) |
| `isValidContractAddress(address)` | Return `true` for valid 56-char C-addresses |
| `validateNetworkConfig(config)` | Throw on invalid network config |
| `checkNetworkPassphrases(configs, makeServer)` | Validate passphrase per network |
| `checkContractAvailability(configs, makeServer)` | Check contract existence per network |
| `inspectContractInterface(configs, makeServer)` | Parse function signatures per network |
| `simulateAcrossNetworks(configs, fn, args, makeServer)` | Simulate a function call per network |
| `compareInterfaces(results)` | Identify missing/incompatible functions |
| `compareSimulationResults(results)` | Compare return values and resource metrics |
| `buildCompatibilityReport(params)` | Assemble the final structured report |

---

## Implementation notes

- **No transaction submission.** `simulateTransaction` is used exclusively; transactions are never signed or submitted.
- **Network isolation.** Each network is queried independently. A failure on one network does not prevent results from being collected from others.
- **Contract addresses are independent.** The same address on two networks does not imply the same contract code.
- **Inconclusive results are explicit.** When spec data is unavailable or only one network returns a result, the comparison reports `inconclusive` rather than a false positive.
- **Passphrase validation is a safety check.** Connecting a client to the wrong network passphrase is caught before any further queries run.
