# Soroban Resource & Cost Analysis

Estimate what a Soroban contract invocation needs (CPU instructions, read/write bytes, ledger entries) and what it will roughly cost, **before** submitting it. The example is read-only: it builds an unsigned transaction, simulates it over RPC, and reports. It never signs and never submits (the RPC client interface has no `sendTransaction`).

Verified against `@stellar/stellar-sdk` **13.3.0**.

## Workflow

| Step | File | What happens |
| --- | --- | --- |
| 1. Configure & validate | `invocation.ts` | Network, RPC URL, contract `C...`, source `G...`, function name, typed args. Integers are parsed as `bigint` and range-checked. |
| 2. Prepare | `invocation.ts` | `Contract.call()` inside a `TransactionBuilder` (fee = SDK `BASE_FEE` unless overridden). Unsigned; no Soroban data yet. |
| 3. Simulate | `simulation.ts` | `server.simulateTransaction`. The response is classified: success, failed, restore required, missing resource info, or unexpected shape. |
| 4. Analyse resources | `resource-analysis.ts` | Simulated resources vs. per-transaction limits read from the network's `ConfigSetting` ledger entries (`getLedgerEntries`). |
| 5. Estimate fee | `fee-estimation.ts` | `inclusion fee + minResourceFee`, cross-checked against `rpc.assembleTransaction`. Optional market context from `getFeeStats`. |
| 6. Report | `report.ts` | Structured `CostReport` plus a readable rendering and an overall assessment. |

`index.ts` wires the steps together (`analyzeInvocation`) and provides the CLI.

## Setup & usage

```bash
npm install
npm test            # mocked RPC, no network needed
npm run typecheck

# Analyse a call (testnet has a default RPC; mainnet needs --rpc-url)
npx ts-node index.ts \
  --network testnet \
  --contract C... \
  --function transfer \
  --source G... \
  --arg address:G... --arg address:G... --arg i128:10000000
```

Options: `--network testnet|mainnet|futurenet`, `--rpc-url`, `--inclusion-fee <stroops>`, `--arg type:value` (repeatable; types: `bool u32 i32 u64 i64 u128 i128 u256 i256 string symbol address bytes`), `--json`.
The source account must exist on the selected network (its sequence number is loaded). Only the **public** key is needed; no secret key is read, stored or accepted.

Exit code: `0` for `ok`/`caution`, `1` for `do_not_submit`/`inconclusive`, `2` for input or RPC errors.

### Programmatic use

```ts
import { analyzeInvocation, formatReport } from './index';
const report = await analyzeInvocation({ network: 'testnet', contractId, functionName, sourceAccount, args });
console.log(formatReport(report));
```

## What the report contains

Network (name, passphrase, RPC), contract, function, simulation status, simulated resources and footprint, network limits (when readable), per-resource usage/limit/percent/status, fee estimate, diagnostics summary, warnings, notes, and an assessment:

- `ok`: simulation succeeded, resources are comfortably under limits, fee estimated.
- `caution`: succeeded but with warnings (near a limit, limits unreadable, fee-market warning).
- `do_not_submit`: simulation failed, archived state needs restoring, or a resource exceeds a network limit.
- `inconclusive`: unexpected/incomplete response or fee estimation failure; no reliable figures.

A failed or unusable simulation produces **no** resources and **no** fee estimate in the report.

## Resource usage vs. limits

- The `resources` in a simulation response are what the RPC proposes the transaction **declare**; they become the transaction's own resource limits. The response does not separate a raw "measured" meter reading from these declared values, so this example doesn't claim to.
- **Network limits** are different: per-transaction caps (`txMaxInstructions`, `txMaxReadBytes`, `txMaxWriteBytes`, `txMaxReadLedgerEntries`, `txMaxWriteLedgerEntries`) stored in `ConfigSetting` ledger entries and changeable by validator vote. They are fetched live, never hardcoded. If they can't be read, usage is shown as `unknown`, not as "fine".
- The warning threshold (default 80%, `warnRatio`) is this example's own policy, not a network rule.
- Memory (`txMemoryLimit`) is a network limit, but the SDK 13.3.0 simulation response does not expose a memory figure, so it isn't analysed.

## Fees

`fee = inclusion fee bid + minResourceFee`. `minResourceFee` is computed by the RPC from the **current** fee schedule and ledger state; this example does not recompute it from constants. The result is an **estimate of the maximum**, not the final charge:

- The inclusion fee charged depends on network surge pricing and is never more than the bid.
- Part of the resource fee is refundable (e.g. rent, events) if not fully used.
- Ledger state can change between simulation and inclusion, shifting both resources and fees.

## Limitations

- Simulation is a prediction against current state, not a guarantee of identical on-chain execution.
- Failure classification (`missing_function`, `invalid_arguments`, `out_of_resources`) is a heuristic over free-text host errors; unmatched errors are reported verbatim as `other`.
- If simulation says archived entries must be restored, the report stops there; restore costs aren't analysed.
- Only a single `invokeHostFunction` call is analysed; auth entries are not signed or inspected.
- `getFeeStats` context is optional and informational.
