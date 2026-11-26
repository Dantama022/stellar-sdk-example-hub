# Soroban function argument encoder and validator

Validate application inputs against a Soroban function's argument types, then encode them as `ScVal` (and XDR) ready for an invocation. **Read-only:** it never builds a transaction, signs, submits, or needs a network connection or keys.

## How arguments are represented

A Soroban function takes typed values. On the wire each one is an `ScVal` (a tagged union: `scvBool`, `scvU32`, `scvI128`, `scvSymbol`, `scvAddress`, `scvVec`, `scvMap`, ...), serialised as **XDR**, the binary format the network uses. `toXDR('base64')` is what ends up inside a transaction. Getting the *type* right matters: `u128` and `i128` are different wire types, and a `symbol` is not a `string`.

| Application value | Soroban type | ScVal |
|---|---|---|
| `true` | `bool` | `scvBool` |
| `number` (safe integer), `bigint`, decimal string | `u32` `i32` `u64` `i64` `u128` `i128` `u256` `i256` | `scvU32` ... `scvI256` |
| string | `string` / `symbol` | `scvString` / `scvSymbol` (1-32 chars `[A-Za-z0-9_]`) |
| `Uint8Array` or hex string | `bytes` / `bytesN` | `scvBytes` |
| `G...` / `C...` | `address` | `scvAddress` |
| array | `vec<T>` / tuple | `scvVec` |
| `Map`, `[k, v][]`, or object | `map<K, V>` | `scvMap` (keys sorted) |
| object | `#[contracttype]` struct | `scvMap` keyed by field-name symbols, sorted |
| name or number | integer `enum` | `scvU32` |
| `"Case"` or `{ tag, values }` | union enum | `scvVec([scvSymbol(tag), ...values])` |
| `null` / missing | `option<T>` | `scvVoid` |

**Large integers:** pass `bigint` or a decimal string. A JavaScript `number` above `2^53 - 1` has already lost precision before this code sees it, so it is rejected (`PRECISION_LOSS`) rather than silently rounded.

## Setup

```bash
cd examples/soroban/argument-encoding
npm install
npm run typecheck
npm test
npm start          # runs the demo in index.ts
```

Uses `@stellar/stellar-sdk` 13.x (`xdr`, `XdrLargeInt`, `Address`, `StrKey`). Constructors and XDR types were checked against the installed version; there are no custom SDK methods.

## Usage

```ts
import { prepareArguments, formatReport } from './index';

const { report, encoded } = prepareArguments({
  functionName: 'transfer',
  contractAddress: 'CARZ...',
  definition: {
    name: 'transfer',
    args: [
      { name: 'to', type: { kind: 'address' } },
      { name: 'amount', type: { kind: 'i128' } },
    ],
  },
  args: { to: 'G...', amount: '170141183460469231731687303715884105727' },
});

console.log(formatReport(report));
encoded[1].scVal;      // xdr.ScVal, pass to Contract#call(...)
encoded[1].xdrBase64;  // base64 XDR for inspection
```

### Using the contract specification

A contract embeds its specification (the `contractspecv0` WASM custom section) as a list of base64 `ScSpecEntry` values describing each function and each custom type. Pass them as `specEntries` instead of writing a schema by hand:

```ts
prepareArguments({ functionName: 'place', specEntries, args });
```

`specification.ts` extracts the function's argument names and types and resolves referenced structs, integer enums and union enums. It does not fetch anything. When the specification is malformed, a type is undefined or recursive, or a type is unsupported (`Val`, `Error`, `Result`, `Timepoint`, `Duration`), you get an explicit error and nothing is encoded. If you cannot get a specification, give an explicit `definition`.

## Design

| File | Responsibility |
|---|---|
| `schema.ts` | The type model, `formatType`, and checks that a hand-written definition is well formed |
| `validator.ts` | Pure input validation: missing/unexpected arguments, types, ranges, addresses |
| `encoder.ts` | ScVal construction (validation is a separate step; the encoder throws if given bad input) |
| `specification.ts` | Spec entries to `FunctionDefinition` |
| `report.ts` | Structured report |

Errors carry the argument path (`recipients[2].address`) and the expected type, for example `OUT_OF_RANGE`, `MISSING_ARGUMENT`, `UNEXPECTED_ARGUMENT`, `INVALID_ADDRESS`, `UNKNOWN_VARIANT`.

## Limits

- **Correct encoding does not guarantee the call will succeed.** Authorization, contract state, balances and business rules are only enforced on-chain. Simulate the call before submitting it.
- Map key order follows the documented rule (ints numerically, text and bytes lexicographically). Exotic key types fall back to XDR byte order.
- Custom types are never inferred: provide a specification or an explicit schema.
