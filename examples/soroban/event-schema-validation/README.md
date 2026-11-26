# Soroban Contract Event Schema Validation

A TypeScript example that retrieves Soroban contract events from an RPC
endpoint, decodes their topics and data payloads, validates the decoded
structures against typed schemas, and produces a human-readable diagnostic
report.

---

## How Soroban contract events are structured

Each Soroban contract event carries:

| Field | Description |
|---|---|
| `id` | Unique event identifier (ledger sequence + event index) |
| `type` | `"contract"`, `"system"`, or `"diagnostic"` |
| `ledger` | Ledger sequence in which the transaction was included |
| `ledgerClosedAt` | ISO 8601 timestamp of ledger close |
| `txHash` | Transaction hash that produced the event |
| `contractId` | Strkey address of the contract that emitted the event |
| `topic` | Array of `ScVal` values (indexed, filterable server-side) |
| `value` | Single `ScVal` data payload (not indexed) |
| `inSuccessfulContractCall` | Whether the innermost call frame succeeded |
| `pagingToken` | Cursor for the next page of results |

### Event topics vs. event data

**Topics** are ordered `ScVal` values. By convention the first topic is a
`scvSymbol` naming the event (e.g. `"transfer"`). Topics are indexed by the
RPC server and can be filtered in queries. The remaining topics typically
carry addresses, asset identifiers, or other discriminators.

**Event data** (the `value` field) is a single `ScVal` that is not indexed.
It carries the event's payload: a raw integer, a map of named fields, a
vector, or any other XDR-representable structure. The server does not filter
on this field.

---

## How ScVal values are decoded

Stellar uses XDR-encoded types (`ScVal`) for all contract values. This
example uses `scValToNative` from `@stellar/stellar-sdk` to convert each
`ScVal` into a TypeScript primitive or object.

| ScVal type | Native representation |
|---|---|
| `scvSymbol` | `string` |
| `scvString` | `string` |
| `scvAddress` | account or contract strkey `string` |
| `scvI128` / `scvU128` / `scvI64` / `scvU64` | `bigint` → serialised as `string` |
| `scvBool` | `boolean` |
| `scvVec` | `Array` |
| `scvMap` | `object` |
| `scvBytes` | `Uint8Array` → serialised as hex `"0x..."` |
| `scvVoid` | `null` |
| `scvContractInstanceWasm` | raw XDR preserved, `decoded: false` |

BigInts are converted to strings by `formatNativeValue` so the output is
always JSON-safe.

When `scValToNative` does not support a type, the raw base64 XDR is
preserved in the `rawXdr` field and `decoded` is set to `false`.

---

## How event schemas are defined

An `EventSchema` describes the structural expectations for one event type:

```typescript
import { EventSchema } from './schema';

const MY_TRANSFER_SCHEMA: EventSchema = {
  id: 'transfer',
  description: 'Token transfer event',
  eventName: 'transfer',      // matches the first symbol topic
  topicCount: 3,              // exact number of topics expected
  topics: [
    { index: 0, xdrType: 'scvSymbol',  label: 'event name' },
    { index: 1, xdrType: 'scvAddress', label: 'from address' },
    { index: 2, xdrType: 'scvAddress', label: 'to address' },
  ],
  payloadType: 'scvI128',     // expected XDR type of the data payload
};
```

For map payloads you can additionally specify required and optional fields:

```typescript
payloadFields: [
  { name: 'amount',    type: 'bigint' },    // required, stored as string
  { name: 'memo',      type: 'string', optional: true },
],
```

A schema with `eventName: '*'` acts as a wildcard fallback for any event not
matched by a more specific schema.

---

## How to validate events against expected structures

Create a `SchemaRegistry` and pass it to `validateEvent` or `validateEvents`:

```typescript
import { SchemaRegistry } from './schema';
import { validateEvents } from './validator';

const registry: SchemaRegistry = {
  schemas: [MY_TRANSFER_SCHEMA, UNKNOWN_EVENT_SCHEMA],
};

const results = validateEvents(parsedEvents, registry);

for (const { event, validation } of results) {
  if (!validation.valid) {
    console.log(`Event ${event.id} failed validation:`);
    for (const f of validation.findings.filter(f => f.severity === 'error')) {
      console.log(`  [${f.field}] ${f.message}`);
    }
  }
}
```

Each `ValidationResult` contains:

- `valid` — `true` when no error-severity findings were raised.
- `schemaId` — the schema that was applied, or `null`.
- `findings` — array of `{ severity, field, message }` objects.

Severity levels: `"error"` (structural mismatch), `"warning"` (advisory),
`"info"` (extra fields observed in the payload).

---

## Running against Testnet

### Prerequisites

```
node >= 18
```

Install dependencies from the repository root:

```bash
cd /path/to/stellar-sdk-example-hub
npm install
```

### Run directly with ts-node

```bash
npx ts-node examples/soroban/event-schema-validation/index.ts \
  CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC
```

### Environment variables

| Variable | Default |
|---|---|
| `SOROBAN_RPC_URL` | `https://soroban-testnet.stellar.org` |
| `CONTRACT_ID` | Fallback when no positional argument is given |

```bash
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org \
CONTRACT_ID=CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC \
npx ts-node examples/soroban/event-schema-validation/index.ts
```

### Run tests

```bash
# From the repository root
npx jest --testPathPattern=event-validation.test.ts
```

---

## File layout

| File | Purpose |
|---|---|
| `index.ts` | Main entry point; wires everything together and formats the report |
| `event-query.ts` | RPC query, ledger-range helpers, pagination, and de-duplication |
| `decoder.ts` | ScVal decoding, `formatNativeValue`, and `parseEventRecord` |
| `schema.ts` | Schema types, built-in schemas, and schema registry |
| `validator.ts` | Per-event structural validation against a schema |
| `event-validation.test.ts` | Unit tests (mocked RPC, deterministic fixtures) |

---

## Notes

- **Contract events are not Horizon events.** Horizon records operations and
  effects against classic Stellar accounts. Soroban contract events are emitted
  by smart contract execution and are only accessible through the Soroban RPC
  `getEvents` method.
- **Retention window.** The RPC node retains events for a rolling window of
  roughly 17 280 ledgers (≈ 24 hours at 5-second close time). Events older
  than the retention window are unavailable.
- **Successful decoding is not proof of authenticity.** A decoded event that
  passes schema validation confirms structure only. It does not verify that the
  contract is the one you expect, that the values are semantically correct, or
  that the transaction was not replayed.
- **Raw XDR is always preserved.** Even when decoding fails, `rawXdr` retains
  the original base64-encoded XDR for offline analysis.
