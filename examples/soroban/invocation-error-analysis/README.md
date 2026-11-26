# Soroban invocation error classification and recovery guidance

Classify what went wrong in a Soroban invocation, say which stage failed, extract diagnostics, and suggest safe next steps. **Analysis only:** it reads an error or RPC response you already have. It never retries, signs or submits anything, and its reports are redacted. Tests use mocked SDK errors and representative RPC response fixtures, so no network is needed.

## Stages of an invocation

1. **Input validation**: your arguments and addresses
2. **Transaction construction**: building the transaction
3. **Simulation** (`simulateTransaction`): the node dry-runs the call and reports contract errors
4. **Resource estimation**: CPU, memory and ledger footprint, fees
5. **Authorization**: signatures and authorization entries
6. **Submission** (`sendTransaction`): the network accepts or rejects it
7. **Execution**: the transaction is in a ledger and succeeded or failed there
8. **Status retrieval** (`getTransaction`): polling for the final outcome

Pass `stage` when you capture a failure; it is the only reliable signal. When it is missing the classifier infers it from the shape of the RPC response and otherwise reports `unknown` rather than guessing.

## Categories

`invalid-input`, `contract-not-found`, `authorization`, `contract-execution`, `resource-limit`, `fee-or-configuration`, `network-connectivity`, `transaction-rejected`, `transaction-pending`, `unknown`.

## How diagnostics are extracted

Structured signals win over message text:

| Source | Used for |
|---|---|
| `sendTransaction` status (`PENDING`, `DUPLICATE`, `TRY_AGAIN_LATER`, `ERROR`) and `getTransaction` status (`NOT_FOUND`, `FAILED`) | pending / rejected |
| `TransactionResult` XDR (`errorResult`, `errorResultXdr`, `resultXdr`): transaction codes such as `txBadSeq`, `txInsufficientFee`, `txBadAuth`, and operation codes such as `invokeHostFunctionTrapped`, `invokeHostFunctionResourceLimitExceeded` | fee, authorization, resource, execution |
| Host error notation in simulation text: `Error(Contract, #12)`, `Error(Budget, ExceededLimit)`, `Error(Auth, ...)` (types from `ScErrorType`) | execution, resource, authorization |
| Diagnostic events (XDR objects or base64) | decoded topics/data (capped, redacted) |
| `error.code` (`ECONNREFUSED`, `ETIMEDOUT`, ...) and HTTP status (429, 502, 503, 504) | connectivity |
| Message text patterns | last resort, always **low** confidence |

Providers differ: nothing here assumes every RPC returns every field. Missing metadata is reported (`metadataAvailable: false`), not invented.

## Confidence

`high` (a documented code), `medium` (a recognised pattern in text), `low` (a loose heuristic), `none` (unknown). Uncertain results stay `unknown` or low, and the guidance says so.

## Unresolved transaction status

`PENDING`, `DUPLICATE`, `NOT_FOUND`, or a connection that dropped while submitting do **not** mean the transaction failed. It may still be applied, or may already have been. Resubmitting blindly can double-spend an intent or conflict on sequence numbers. The report sets `submissionStatus` (`unknown`, `pending`, ...) and `retrySafety: "check-status-first"`: poll `getTransaction` with the hash (or compute it from your signed envelope) before doing anything else.

Retry safety values: `check-status-first`, `after-fix` (change something and re-simulate), `after-backoff` (transient, reads only), `not-recommended` (identical retry will fail the same way).

## Setup

```bash
cd examples/soroban/invocation-error-analysis
npm install
npm run typecheck
npm test
npm start      # prints reports for a few sample failures
```

Uses `@stellar/stellar-sdk` 13.x (`rpc.Api`, `xdr`). Result code names and RPC status values were taken from the installed SDK.

## Usage

```ts
import { analyzeInvocationError, formatReport } from './index';

try {
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    const { report } = analyzeInvocationError({ stage: 'simulation', response: sim, context: { contractAddress, functionName } });
    console.log(formatReport(report));
  }
} catch (error) {
  const { report } = analyzeInvocationError({ stage: 'simulation', error });
}

// After sendTransaction:
analyzeInvocationError({ stage: 'submission', response: sendResponse, transactionHash: sendResponse.hash });
```

`analyzeInvocationError` returns `{ report, classification, diagnostics, guidance, original }`. The `report` is redacted and safe to log or store. `original` is the untouched input for debugging; do not log it.

## Redaction

Secret keys (`S...`), `Bearer`/`Basic` tokens, `api_key`/`token` URL parameters, long base64 blobs (envelopes with signatures or authorization entries), and any object key resembling `secret`, `private`, `seed`, `password`, `token`, `authorization`, `signature`... are replaced before anything reaches the report. Contract addresses and transaction hashes are public and kept.

## Design

| File | Responsibility |
|---|---|
| `diagnostics.ts` | Extraction (messages, codes, result XDR, events) and redaction |
| `error-classifier.ts` | Stage identification and category/confidence |
| `recovery-guidance.ts` | Category-specific recommendations and retry safety |
| `report.ts` | Structured report |
