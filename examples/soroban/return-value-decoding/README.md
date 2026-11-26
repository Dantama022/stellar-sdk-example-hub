# Soroban return value decoder and type validator

Decode a contract's return value into something readable, then check it against the expected return type. **Read-only:** it inspects a value you already have (for example the `retval` of a simulation) and never builds, signs or submits a transaction. The test suite uses fixed `ScVal` fixtures and needs no network.

## How return values are represented

A Soroban function returns one `ScVal`, a tagged union (`scvBool`, `scvU32`, `scvI128`, `scvSymbol`, `scvAddress`, `scvVec`, `scvMap`, `scvVoid`, ...). Over RPC it travels as **XDR** (binary), usually base64 encoded. A function that returns nothing returns `scvVoid`; having no return value at all means something went wrong upstream.

Custom types have no wire tag of their own:

- a `#[contracttype]` **struct** is an `scvMap` with symbol keys (one per field)
- an integer **enum** is an `scvU32`
- a **union** enum is an `scvVec` whose first element is the case name as a symbol

So the bytes alone cannot tell you "this is an `Account`". You need the expected type.

## Decoding is not validation

| Step | Question | Module | Failure shows up as |
|---|---|---|---|
| Decoding | What is this value? | `decoder.ts` | `decoding.errors` (`MALFORMED_XDR`, `UNSUPPORTED_TYPE`, `MISSING_RETURN_VALUE`, ...) |
| Validation | Is it the shape I expected? | `type-validator.ts` | `validation.mismatches` |

They are reported separately. A value that could not be decoded is `inconclusive`, never a type mismatch. If no expected type is available the result is also `inconclusive`: the value is still decoded and shown.

## Setup

```bash
cd examples/soroban/return-value-decoding
npm install
npm run typecheck
npm test
npm start
```

Uses `@stellar/stellar-sdk` 13.x (`xdr.ScVal`, `scValToBigInt`, `Address`). APIs were checked against the installed version.

## Usage

```ts
import { inspectReturnValue, formatReport } from './index';

const report = inspectReturnValue({
  functionName: 'get_account',
  contractAddress: 'CARZ...',
  returnValue: simulation.result.retval,        // xdr.ScVal, base64 XDR string, or XDR bytes
  expectedType: {                               // or: specEntries: [...]
    kind: 'struct',
    name: 'Account',
    fields: [
      { name: 'balance', type: { kind: 'i128' } },
      { name: 'owner', type: { kind: 'address' } },
    ],
  },
});
console.log(formatReport(report));
```

The report contains the contract address, function, expected type and where it came from, decoding status and errors, the decoded value, the **raw `ScVal` type and base64 XDR**, the validation result, specification errors and warnings.

### Inspecting raw vs decoded values

`report.raw.xdrBase64` is the original value; `report.decoded` is the readable form. Integers are `bigint` internally and shown as decimal strings in the report, so a `u128` such as `340282366920938463463374607431768211455` keeps every digit. Bytes are shown as hex, maps as `{key, value}` lists in wire order. Anything the example does not decode (`scvError`, contract instances, ledger keys) keeps its raw XDR (`unsupportedRaw`) and the rest of the value is still decoded (`partial`).

### Contract specification

Pass `specEntries` (base64 `ScSpecEntry` values from the contract's `contractspecv0` section) and the function's declared output is resolved, including referenced structs and enums. A function with no outputs returns `void`. A `Result<T, E>` output is checked as `T`: a successful call returns the `Ok` value directly, while an `Err` aborts the call with a contract error. When the specification is malformed, the function or a type is missing, or a type is unsupported, `specificationErrors` explains it and validation is `inconclusive`.

## Design

| File | Responsibility |
|---|---|
| `types.ts` | Expected type model and checks for hand-written types |
| `decoder.ts` | ScVal to a node tree; preserves raw XDR for unsupported parts |
| `type-validator.ts` | Structural validation: wire type, integer range, struct fields, enum cases, union shape |
| `specification.ts` | Spec entries to return type |
| `report.ts` | Structured report |

## Why successful decoding is not enough

A value can decode cleanly, pass structural validation, and still be wrong for your application: a balance that is a valid `i128` but belongs to another account, a price from a stale oracle, a status code your code misinterprets. Validation here is **structural only**. Check meaning in application code.
