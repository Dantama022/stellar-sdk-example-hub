# Soroban Contract Upgrade Preflight

[`src/examples/264-contract-upgrade-preflight.ts`](../../src/examples/264-contract-upgrade-preflight.ts) audits a proposed contract upgrade before anyone signs it. It inspects the deployed contract, validates the replacement WASM, finds the contract's own upgrade entry point, builds the invocation and simulates it, then reports readiness. **It never submits a transaction** and never prints authorization payloads or keys.

## Setup and run

```bash
npm install
CONTRACT_ID=C... \
REPLACEMENT_WASM=./target/wasm32-unknown-unknown/release/my_contract.wasm \
SOURCE_ACCOUNT=G... \
npm run run-example -- 264-contract-upgrade-preflight

# Optional
UPGRADE_FUNCTION=upgrade        # the contract's own entry point (otherwise inferred from its spec)
EXPECTED_ADMIN=G...             # who you expect to authorize upgrades, from the contract source
EXPECTED_WASM_SHA256=<hex>      # release hash the artifact must match
JSON=1                          # structured output
npm test -- tests/contract-upgrade-preflight.test.ts
```

The network and RPC come from `STELLAR_NETWORK` / `SOROBAN_RPC_URL` (`60-network-configuration`). The exit code is non-zero when the upgrade is blocked.

## Steps

| Step | What happens |
|---|---|
| Network | RPC `getNetwork` passphrase must match the configured network. |
| Deployed contract | The contract instance ledger entry gives the current WASM hash. A missing instance and Stellar Asset Contracts (no replaceable WASM) block the upgrade. The deployed WASM's `contractspecv0` spec is loaded when available. |
| Replacement WASM | File read, Wasm magic/version checked, `WebAssembly.validate`, SHA-256 computed and optionally compared with `EXPECTED_WASM_SHA256`. Its spec is read, and the code is checked to be **installed on-ledger**: an upgrade can only point at WASM that has already been uploaded. |
| Entry point | Contract-specific, never assumed. A given `UPGRADE_FUNCTION` is verified in the deployed spec, and must take a `BytesN<32>` hash. Otherwise it is *inferred* only if exactly one function takes a `BytesN<32>`, and flagged for confirmation. Other inputs must be passed as `extraArgs`. |
| Transaction | The invocation is built with the source account and the replacement hash. |
| Simulation | `simulateTransaction` only. Errors are reported, with authorization failures recognised. On success: resource fee, instructions, read/write bytes, restore requirements, and the **addresses in the auth entries**, compared with `EXPECTED_ADMIN`. |

The report separates what was verified (spec contents, simulated authorizers) from what was assumed or unavailable (an inferred entry point, missing metadata). Readiness is `blocked` if any finding is high severity or simulation did not succeed, `ready-with-warnings` if any is medium, otherwise `ready`.

## Sample output

```text
Upgrade preflight: READY-WITH-WARNINGS
  Contract:           CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR
  Network:            Test SDF Network ; September 2015 (RPC matches)
  Current WASM:       a94408ff6b389f9eaaf8afa03cdcdc5c4446a6bbe25c26b2c0e3bed6ffeba77f
  Replacement WASM:   af70e5d05f64ec6c42a23f83636d21a7bec40f9897b124caab31b88da2c07971 (valid, installed)
  Entry point:        upgrade [inferred-from-spec]
  Authorization:      require_auth by GCQJVJPUPJTVTABP7FK7RXBNFIKKLSM5EO7JP6DECJ77SOBUKWSPB64N (observed in simulation); expected admin GCQJVJPUPJTVTABP7FK7RXBNFIKKLSM5EO7JP6DECJ77SOBUKWSPB64N
  Simulation:         succeeded
  Resources:          fee 45678 stroops, 1500000 instructions, 2048 B read, 512 B written
  Findings:
    [MEDIUM] entry-point-inferred: Assuming "upgrade" is the upgrade function (only function taking a BytesN<32>); confirm in the contract source
    [INFO] separate-signer: GCQJVJPUPJTVTABP7FK7RXBNFIKKLSM5EO7JP6DECJ77SOBUKWSPB64N must sign an authorization entry in addition to the source account
    [INFO] simulation-not-guarantee: A successful simulation does not guarantee execution: state, fees and authorization can change before submission
  No transaction was submitted.
```

## Limitations and unresolved risks

- **Simulation is not execution.** State, fees and authorization can change between simulation and submission.
- **Authorization comes from what simulation observes**, not from reading the contract's storage. Without `EXPECTED_ADMIN`, the report says who must sign, not whether that is the right party.
- An inferred entry point is a guess from the spec; confirm it in the contract source. Contracts whose upgrade takes extra arguments need those values passed in.
- The replacement spec is checked only for keeping the upgrade function. Storage-layout and data-migration compatibility between versions cannot be checked from WASM and needs review and testing.
- No submission: upload the WASM, sign the authorization entries and submit with your own reviewed tooling.
- This example also fixes `src/utils/spec-parser.ts` `specFromWasm`, which required an SDK subpath (`lib/contract/utils`) that SDK 13's package exports block, so it always returned `null`.
