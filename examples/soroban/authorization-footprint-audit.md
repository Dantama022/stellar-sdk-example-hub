# Soroban Authorization Footprint and Credential Expiration Audit

[`src/examples/265-authorization-footprint-audit.ts`](../../src/examples/265-authorization-footprint-audit.ts) simulates a contract invocation, decodes every `SorobanAuthorizationEntry` it requires with the SDK, and reports who must authorize what, whether that matches what you expected, and when address signatures expire. **It never signs, verifies signatures or submits**, and it never prints argument values or signature bytes.

## Setup and run

```bash
npm install
CONTRACT_ID=C... METHOD=swap SOURCE_ACCOUNT=G... \
npm run run-example -- 265-authorization-footprint-audit

# Optional
ARGS_JSON='["GABC...", 100]'          # arguments, converted with nativeToScVal
EXPECTED_CONTRACTS=C...,C...          # contracts allowed anywhere in the auth trees
EXPECTED_FUNCTIONS=swap,transfer      # function names allowed anywhere in the auth trees
EXPECTED_PATHS='C...:swap > C...:transfer'   # exact root-to-leaf paths (comma-separated)
EXPIRY_WARNING_LEDGERS=100            # warn below this many ledgers (~5 s each)
STRICT=1                              # unexpected requirements fail instead of warn
JSON=1                                # structured output
npm test -- tests/authorization-footprint-audit.test.ts
```

The network and RPC come from `STELLAR_NETWORK` / `SOROBAN_RPC_URL` (`60-network-configuration`). The exit code is non-zero when the audit fails.

To audit entries you already have (for example from a prepared transaction), call `decodeAuthEntries(base64[])` and pass the result to `auditAuthorizationEntries(entries, context, rules)`; malformed XDR is reported as a failure.

## What is checked

| Check | Behaviour |
|---|---|
| Credential type | `source-account` (authorizer is the transaction source) or `address` (account `G...` or contract `C...`). |
| Invocation tree | Contract and function at every level, flattened into `C...:fn > C...:fn` paths. Contract-creation authorizations are flagged. |
| Expected footprint | Contracts, functions and exact paths outside the configured rules are listed under *Unexpected*. Warnings by default, failures with `STRICT=1`. Repeated identical requirements for the same authorizer are flagged. |
| Expiration | Only for address credentials: `signatureExpirationLedger` compared with the simulation's latest ledger → `expired` (fail), `expiring-soon` (warn), `valid`, or `unset` (0, not signed yet). |
| Simulation | Errors become a failed audit with the first line of the error. |

### Expiration models

- **Address credentials** carry `signatureExpirationLedger`. It is `0` until the signer signs and picks a ledger; the network rejects the entry after that ledger.
- **Source-account credentials** have no expiry field. They are covered by the transaction signature, so their validity follows the transaction's time bounds and sequence number. The report says so instead of inventing a value.

### What cannot be established locally

- Signatures are never verified: that needs the network-bound payload and the signer's key. A present signature is reported as `present-unverified`.
- Contract accounts (`C...` authorizers) decide validity in their own `__check_auth`, which cannot be evaluated here.
- Without the current ledger, a set expiration cannot be evaluated (`expiration-unknown`).

## Sample output

```text
Authorization audit: PASS-WITH-WARNINGS
  Network:          Test SDF Network ; September 2015
  Source account:   GCQJVJPUPJTVTABP7FK7RXBNFIKKLSM5EO7JP6DECJ77SOBUKWSPB64N
  Contract:         CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526
  Current ledger:   512000
  Auth entries:     2
  Credential types: source-account, address:account
  [0] source-account by GCQJVJPUPJTVTABP7FK7RXBNFIKKLSM5EO7JP6DECJ77SOBUKWSPB64N (account); signature not-applicable; expiration transaction-bound
      CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526:swap > CABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAFNSZ:transfer
  [1] address by GDHMW6QZOL73SHKG2JA3YHXFDHM46SS5ZRWEYF5BCYHX2C5TVO6KZBYL (account); signature absent; expiration ledger 512060 (expiring-soon)
      CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526:swap > CABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGCK3:approve
  Unexpected:       CABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGCK3:approve
  Findings:
    [INFO] expiration-unavailable: Entry 0 uses source-account credentials: validity follows the transaction's time bounds and sequence, not an entry field
    [WARN] unexpected-contract: Entry 1 authorizes calls to unexpected contract CABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGCK3
    [WARN] unexpected-function: Entry 1 authorizes unexpected function approve on CABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGCK3
    [WARN] expiring-authorization: Entry 1: signature expires in 60 ledger(s)
  Structural checks only: nothing was signed, verified or submitted.
```

## Limitations

- Simulation shows the authorization needed for the state at that ledger; different arguments or later state can change it.
- Footprint rules are allow-lists you supply; with none configured the comparison is skipped and reported.
- Structural checks only. Review the entries before signing, and sign and submit with your own reviewed tooling.
