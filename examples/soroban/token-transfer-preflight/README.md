# Soroban Token Transfer with Preflight Validation

Prepares, authorizes, validates and (only if everything checks out) submits a Soroban token
`transfer`. Preparation, authorization, signing and submission are separate steps, and
submission is impossible while any preflight check is failing.

Verified against `@stellar/stellar-sdk` **13.3.0**. APIs used: `Contract#call`,
`TransactionBuilder`, `rpc.Server#simulateTransaction`, `rpc.assembleTransaction`,
`authorizeEntry`, `rpc.Server#sendTransaction`, `rpc.Server#getTransaction`.

> **A successful simulation does not guarantee a successful transfer.** Simulation runs against
> the ledger as it is *now*. Between simulation and inclusion the balance can be spent, an
> allowance can change, or a contract can be upgraded. Treat simulation as a strong prediction and
> always confirm the final status.

## The workflow

```
validate request ─▶ build tx (unsigned) ─▶ simulate ─▶ inspect + sign auth entries
      transfer.ts           transfer.ts    simulation.ts     authorization.ts
                                                                  │
       submit + confirm ◀─ preflight report ◀─ sign envelope ◀─ re-simulate + assemble
         submit.ts          preflight.ts                          simulation.ts
```

`workflow.ts` runs these in order. Each stage is also usable on its own.

1. **Validate** (`transfer.ts`). The token must be a `C...` contract; sender and recipient `G...`
   or `C...`; the amount a positive integer ≤ i128 max, given as a string or `bigint`. A JS
   `number` is rejected because it silently loses precision above 2^53. The **network must be named
   explicitly**: there is no default, so a transfer is never sent to the wrong chain by omission.
2. **Build** (`transfer.ts`). Calls the SEP-41 interface
   `transfer(from: Address, to: Address, amount: i128)` through `Contract#call`. The amount is
   encoded with `nativeToScVal(amount, { type: 'i128' })`, which takes a `bigint` directly. The
   transaction is unsigned and has no resource data yet.
3. **Simulate** (`simulation.ts`). Failures are classified: insufficient balance, out of
   resources, archived state needing restoration (`RESTORE_REQUIRED`), or a generic failure. The
   summary exposes the auth entries, minimum resource fee, CPU/read/write estimates and the
   diagnostic event count. The classification is a heuristic on host error text.
4. **Authorize** (`authorization.ts`), see below.
5. **Assemble** (`simulation.ts`). `rpc.assembleTransaction` applies the footprint and
   `minResourceFee`. It keeps auth already on the operation, which is why signed entries are
   attached *before* assembling.
6. **Sign the envelope** with the source account, a separate signature from step 4.
7. **Preflight** (`preflight.ts`) returns a `PreflightReport` of pass/fail checks.
8. **Submit and confirm** (`submit.ts`), only when `report.ok`.

## Authorization: why and how

`transfer` calls `from.require_auth()`, so the sender must approve this exact invocation. The
simulation returns the required `SorobanAuthorizationEntry` list. There are two credential types
and the example handles each differently:

| Situation | Credentials in the entry | What you sign |
|---|---|---|
| Sender is the transaction source | `sourceAccount` | Nothing extra: the **envelope signature** covers it |
| Sender differs from the source (e.g. a fee payer) | `address` (sender) | The entry itself, via `authorizeEntry`, **and** the envelope with the source key |
| Sender is a contract account (`C...`) | `address` (contract) | Defined by the account contract's `__check_auth`. **Refused** here rather than guessed |

Auth-entry signatures and envelope signatures sign different payloads (the former a
`HashIdPreimage` of network + nonce + expiration ledger + invocation, the latter the transaction
hash). Neither is valid in place of the other. Hence two signer abstractions: `AuthSigner`
(`authorization.ts`) and the envelope `Keypair`.

Safeguards in `signAuthEntries`:

- It signs only an entry that is exactly `token.transfer(sender, recipient, amount)` with no nested
  invocations, so a malicious or buggy RPC cannot get a broader authorization signed.
- It signs only entries addressed to the signer; others stay unsigned and fail preflight.
- Signatures expire after `authValidityLedgers` (default 100, about 8 minutes).
- After signing with an address credential, the transaction is **re-simulated** with the signed
  entries attached. The first simulation ran in "recording" mode and under-measures the cost of
  signature verification. The second one is enforcing, so it also rejects bad signatures.

## Preflight report

| Check | Passes when |
|---|---|
| `network` | RPC reports the selected passphrase, and the transaction was built with it |
| `sender` / `recipient` / `token` | Valid StrKey of the expected type |
| `amount` | The **decoded transaction** is `token.transfer(sender, recipient, amount)` with a positive amount equal to the request, not just the config that built it |
| `simulation` | Simulation succeeded (not an error, no restore needed) |
| `authorization` | Every entry matches the transfer, address entries are signed and unexpired, and the sender is covered |
| `envelope-signature` | A valid signature from the source account is on the transaction |
| `resources-and-fee` | Soroban data present; fee ≥ base + `minResourceFee`; fee ≤ your `maxFeeStroops` |

```
PASS  Transaction and RPC target the selected network
      Both use the testnet passphrase
...
FAIL  Required authorization has been provided
      G...: authorization is unsigned
Preflight: FAILED - not submitting
```

`submitTransaction` also takes the report and throws `PREFLIGHT_FAILED` if it is not clean, so the
gate holds even for callers that skip `workflow.ts`.

## Submission and confirmation

`sendTransaction` only queues the transaction. Outcomes (`SubmissionResult.outcome`):

| Outcome | Meaning | Tokens moved? |
|---|---|---|
| `success` | In a ledger, executed | Yes |
| `failed` | In a ledger, execution failed (fee charged) | No |
| `rejected` | Refused at submission (`errorResult` code, e.g. `txBadSeq`) | No |
| `not_accepted` | `TRY_AGAIN_LATER`: not queued | No |
| `pending` | Accepted but not seen in a ledger when polling stopped | **Unknown** |
| `unknown` | The submit request itself errored | **Unknown** |

The hash is computed locally and always returned. `pending` and `unknown` are not failures: look
the hash up with `getTransaction` before doing anything else. **There is no automatic retry.**
Blindly rebuilding and resending can double-pay or collide on the sequence number. Re-sending the
identical signed transaction is idempotent, but check its status first.

## Error codes

`NETWORK_REQUIRED`, `INVALID_NETWORK`, `INVALID_SENDER`, `INVALID_RECIPIENT`,
`INVALID_TOKEN_CONTRACT`, `INVALID_AMOUNT`, `INVALID_SOURCE` (input validation, thrown);
`RPC_UNAVAILABLE`, `SIMULATION_FAILED`, `INSUFFICIENT_BALANCE`, `INSUFFICIENT_RESOURCES`,
`RESTORE_REQUIRED`, `UNSUPPORTED_AUTHORIZATION`, `AUTH_SIGNING_FAILED`, `INVALID_SIGNATURE`
(stage failures, reported in `outcome.error` plus a failing report); `PREFLIGHT_FAILED`
(submission refused). `MISSING_AUTHORIZATION` is not a code: missing auth shows up as the failed
`authorization` check.

## Setup and running

```bash
cd examples/soroban/token-transfer-preflight
npm install
npm test            # mocked RPC and signers, no network access
npm run typecheck
```

CLI on **Testnet**. Use a throwaway Testnet account (fund it with Friendbot), never a real key:

```bash
export SENDER_SECRET=S...           # environment only: never pass secrets as arguments
# optional: SOURCE_SECRET=S... for a separate fee-paying account

# Dry run (default): everything except sending
npx ts-node index.ts --network testnet --token C... --sender G... --recipient G... --amount 10000000

# Same, but submit if preflight passes
npx ts-node index.ts --network testnet --token C... --sender G... --recipient G... --amount 10000000 --submit
```

`--amount` is in the token's smallest unit (7 decimals: `10000000` = 1.0). Mainnet needs
`--rpc-url`/`SOROBAN_RPC_URL` for your own provider. Use `--source G...` with `SOURCE_SECRET` for
a separate fee payer. Exit code: `0` on success or a clean dry run, `1` on failure, `2` on bad input.

Library use:

```ts
const outcome = await executeTransfer(
  { network: 'testnet', token, sender, recipient, amount: '10000000' },
  { client: createRpcClient(url), authSigner: keypairAuthSigner(kp), envelopeSigner: kp },
  { submit: false }
);
console.log(formatReport(outcome.report));
```

For hardware or remote signing, implement `AuthSigner` (`publicKey`, `sign(preimage)`) instead of
using a local keypair.

## Limitations

- Contract-account senders (`C...`) are detected and refused, not signed.
- Archived-entry restoration is reported (`RESTORE_REQUIRED`) but not performed.
- Simulation error classification matches host error text and may need adjusting for tokens with
  custom error codes. Tokens are assumed to implement SEP-41 `transfer`; some token contracts also
  support muxed recipients via different signatures, which this example does not cover.
- The simulated fee is not padded. On a busy network consider a safety margin on resources.

## Files

| File | Role |
|---|---|
| `transfer.ts` | Request validation, `transfer` invocation, transaction construction |
| `simulation.ts` | Simulation, error classification, assembly |
| `authorization.ts` | Auth-entry inspection and signing |
| `preflight.ts` | Structured preflight report |
| `submit.ts` | Gated submission, polling, outcome classification |
| `workflow.ts` | Stage orchestration |
| `rpc.ts` | Mockable RPC interface |
| `index.ts` | CLI and exports |
| `transfer.test.ts` | Tests with mocked RPC and signers |
