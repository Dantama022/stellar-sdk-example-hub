# Soroban Event Replay and Checkpoint Recovery

[`src/examples/263-soroban-event-replay-checkpoint.ts`](../../src/examples/263-soroban-event-replay-checkpoint.ts) replays a contract's events from Stellar RPC `getEvents`, processes them in a deterministic order, and keeps a checkpoint so it resumes after a restart, an RPC outage or a handler crash.

## Setup and run

```bash
npm install
CONTRACT_ID=C... START_LEDGER=123456 npm run run-example 263-soroban-event-replay-checkpoint
# Optional
EVENT_TOPICS='transfer,*,*'      # topic filter: one ScSymbol or * per position
END_LEDGER=124000                # stop at this ledger
CHECKPOINT_FILE=./events.json    # default .event-replay-checkpoint.json
SKIP_UNAVAILABLE_HISTORY=1       # continue from the oldest available ledger (the gap is still reported)
npm test -- tests/soroban-event-replay-checkpoint.test.ts
```

The network and RPC URL come from the usual `STELLAR_NETWORK` / `SOROBAN_RPC_URL` settings (`60-network-configuration`). Run it again to resume from the checkpoint.

## How it works

| Concern | Behaviour |
|---|---|
| Retrieval | `getEvents` filtered by contract id and optional topics. The first page uses `startLedger` (and `endLedger`); later pages use the returned `cursor` only, since the two are mutually exclusive. Responses are validated (events array, id, ledger). |
| Ordering | Each page is processed by ledger, then by the RPC's sortable event id, regardless of the order received. |
| Checkpoint | `{ lastLedger, processedIds }`: the last ledger reached and the ids already handled in it. Resuming re-queries from `lastLedger` inclusive and skips those ids, so a crash in the middle of a ledger loses nothing and repeats nothing that was committed. |
| Commit rule | The checkpoint is saved only after every event in a page has been handled. If a handler fails, progress up to the last successful event is saved and the run stops. |
| Duplicates | Ids already in the checkpoint, repeated within a response, or older than the checkpoint ledger are skipped and counted. |
| Retries | Timeouts, connection resets, HTTP 429 and 5xx are retried up to 3 times with backoff; other errors stop the run with the checkpoint intact. |
| Retention | RPC keeps a limited event history. The oldest available ledger comes from `getHealth`, or from the RPC's out-of-range error. Older ledgers are reported as **unrecoverable**: the run stops unless `SKIP_UNAVAILABLE_HISTORY=1`. |
| Storage | `CheckpointStore` is an interface: `FileCheckpointStore` (atomic temp-file + rename) and `MemoryCheckpointStore` are included; use a database in production. `EventSource` is an interface too, which is how the tests mock RPC. |

## Delivery guarantee and idempotent handlers

Retrieval is **at-least-once**, not exactly-once. If the process dies after a handler ran but before the checkpoint was saved, that event is delivered again on the next run. Make handlers idempotent: key writes by `event.id` (for example `INSERT ... ON CONFLICT (event_id) DO NOTHING`), or store the checkpoint in the same database transaction as the handler's writes.

## Sample output

Resuming from a checkpoint at ledger 1201, after one transient RPC failure:

```text
Event replay: COMPLETED
  Contract:            CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526
  RPC endpoint:        https://soroban-testnet.stellar.org
  Requested range:     1200-latest (resumed from ledger 1201)
  Retrieved events:    4
  Processed events:    3
  Duplicates skipped:  1
  Last processed:      1203
  Saved checkpoint:    ledger 1203, 1 id(s)
  Retries:             1
  Unrecoverable:       none
```

Each processed event is also printed as one JSON line (id, ledger, transaction, decoded topics and value). The endpoint is shown without credentials or query string.

## Limitations

- RPC event history is short (days, not months, on public providers). Use the replay to catch up after outages, and an indexer or archive for older history.
- A gap can only be reported when the server says where its history starts; very old providers that report neither field nor a descriptive error cannot be checked.
- A checkpoint is tied to its scope (contract, topics, start and end ledger). Changing any of these needs a new checkpoint file.
- The demo handler prints events; replace it with your own idempotent handler.
