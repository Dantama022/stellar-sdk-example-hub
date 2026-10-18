# Reliable lifecycle workflows (#405–#408)

These examples extend existing coverage rather than replace it. The open/closed
GitHub issue history was reviewed on 2026-10-18, including #94/#130/#237/#247/#280
(events), #123/#174/#225 (trustlines), #47/#48/#178 (paths), and #168/#207/#221
(history). Existing examples 67, 121, 127, 131, 163, 187, 190 and 209 cover
inspection, individual queries or monitors. These additions demonstrate durable
batch checkpoints and validated unsigned transaction preparation. They use
`@stellar/stellar-sdk` 13.3.0 APIs, not the separately installed v16 alias.

## Setup and execution

Use Node 22 or newer (the repository's v16 alias requires it), install dependencies,
and copy `.env.example` to `.env`. Existing network settings are reused:
`STELLAR_NETWORK`, `HORIZON_URL`, `SOROBAN_RPC_URL`, `NETWORK_PASSPHRASE`.
Keep Horizon, RPC, and passphrase on the same network. Never place secrets in URLs.
No example needs a secret key.

Run `npm run run-example -- <example-name>` with a working repository catalog,
or invoke an entry directly, for example:

```sh
npx ts-node src/examples/254-contract-event-checkpointing.ts
npx ts-node src/examples/255-asset-trustline-lifecycle.ts
npx ts-node src/examples/256-path-payment-preparation.ts
npx ts-node src/examples/257-transaction-history-checkpointing.ts
```

The direct entry points load `.env`. Each command is bounded and exits with a
failure status on error. The exported `run()` functions propagate useful validation
errors to programmatic callers. No transaction is submitted automatically.

## 254: Soroban event queries and repeated monitoring

Set `CONTRACT_ID` to a C-address and `START_LEDGER` to a positive retained ledger.
Optional `EVENT_TYPE` is `contract` (default) or `system`. Optional `EVENT_TOPIC`
is an ScSymbol, such as `transfer`. This filter encodes the first topic as XDR
and matches **three-topic events**, with wildcards at positions two and three.
For other topic counts, adjust the pattern in `eventFilter`; RPC topic patterns
match positional arrays, not arbitrary substring searches. Omit EVENT_TOPIC to
inspect all topic layouts for the contract. Invalid types, addresses and symbols
are rejected. Unsupported server parameters are errors; history is never silently
skipped by changing the requested ledger range.

Topics are indexed routing/filter values; data is the event payload. Neither has
a universal application schema. Generic ScVal decoding preserves bigint values
as strings and handles bytes safely. Unsupported or missing data displays
`{"undecodable":true}`. Output includes stable event ID, contract, ledger,
transaction hash, event type, successful-call flag, decoded topics and data.

Representative output (identifiers abbreviated):

```text
{"id":"000...-000...","contract":"C...","ledger":1234,"transaction":"abc...","type":"contract","topics":["transfer","G...","G..."],"data":"10000000"}
Bounded historical query complete. Re-run to poll from the checkpoint.
```

The SDK supports `getEvents({startLedger, filters, limit})` and subsequent
`getEvents({cursor, filters, limit})`. Start ledger and cursor are never combined.
The response cursor also permits progress across empty ledger ranges. Each run
ends on an empty response or after 100 pages. Repeat the command at a reasonable
interval for monitoring; this is historical retrieval/repeated polling, not a
permanent real-time subscription. Horizon operation records describe classic
transaction operations; they are not Soroban contract event payloads.

## 255: trustline lifecycle

Set `ACCOUNT_ID` to the holder G-address and `TRUST_ASSET=CODE:ISSUER`.
`TRUST_ACTION=inspect` is the default. Set `create` or `update` with `TRUST_LIMIT`
(positive, at most seven decimals), or `remove` to build a zero-limit operation.
The issuer must exist; a holder cannot establish a trustline to its own issue.
Inspection displays code, issuer, current balance and limit. XLM is native and
has no issuer or trustline. Liquidity-pool shares are not classic issued assets.

```text
code  issuer  balance    limit
USD   G...    0.0000000  100.0000000
Unsigned transaction XDR (not simulated, signed, or submitted):
AAAA...
```

The limit caps holdings; it is not the current balance. A trustline neither
purchases/transfers an asset nor establishes that the asset is safe. Creation
increases reserve requirements by one base reserve unless sponsored. Ensure the
holder has enough XLM for minimum balance and fees; removal releases the relevant
reserve (or adjusts sponsorship). The network's base reserve can change.
Removal rejects nonzero balances and buying/selling liabilities: dispose of the
asset and cancel offers first. Updates reject limits below balance plus buying
liabilities. Missing lines and accidental duplicate creation are errors.

## 256: strict-send and strict-receive preparation

Set `SOURCE_ACCOUNT`, `DESTINATION_ACCOUNT`, `SOURCE_ASSET`, `DEST_ASSET`.
Assets use `native` or `CODE:ISSUER`. Set `PATH_MODE=send` or `receive` (default),
`PATH_AMOUNT` and `PATH_BOUND`. For send, amount is fixed source spending and
bound is the minimum acceptable destination receipt. For receive, amount is fixed
destination receipt and bound is the maximum source spending.

Horizon `strictSendPaths` / `strictReceivePaths` discover routes. The example
validates route assets and amounts, compares estimates using exact integers,
prints source/destination amounts and intermediate assets, and prepares the best
route satisfying the supplied bound. Intermediate `path` assets exclude both
endpoints. Empty results report no path. Malformed routes fail before construction.

```text
index  source      destination  intermediate
0      10.0000000  20.0000000   (direct)
Estimate only; unsigned transaction XDR (not simulated or submitted):
AAAA...
```

Source funding, destination existence, trustlines, issuer authorization and
liquidity are prerequisites. Quotes change with markets. Bounds reject
unacceptable execution outcomes but cannot guarantee success. Common failures
include no liquidity, insufficient balance, missing/unauthorized trustlines,
line-full and underfunded accounts.

For both transaction examples, construction loads a fresh account sequence,
fetches the base fee, and uses a 180-second timeout. Review the unsigned envelope
in a trusted wallet and sign for the configured network; submission is a separate,
deliberate `server.submitTransaction(signedTransaction)` action in your application.
Rebuild stale envelopes. Failed submission does not prove the sequence or market
state remains unchanged. These examples do not accept or print signing secrets.

## 257: transaction history and safe resumption

Set `ACCOUNT_ID`. Transactions use ascending order, page size 100, exclusive
`paging_token` cursors, and hash-based deduplication. Records display hash,
ledger, successful status and creation time. Short pages are followed until an
empty page, or the 100-page budget; a short page alone is not treated as completion.
The cursor survives a restart and allows newer transactions to appear on a later
run. The default Horizon endpoint may omit failed transactions under its normal
query semantics; this example retains that scope.

```text
# Initial run
{"hash":"abc...","ledger":1234,"successful":true,"createdAt":"2026-10-18T12:00:00Z"}
Scan finished or reached its page budget; run again to retrieve newer history.
# Resumed run with no new transactions
Scan finished or reached its page budget; run again to retrieve newer history.
```

## Checkpoint guarantees and troubleshooting

254 defaults to `.events-checkpoint.json`; 257 to `.history-checkpoint.json`.
Override with `CHECKPOINT_FILE` (parent directory must exist). The files are
ignored by Git. Use a single process per checkpoint. Writes use a temporary file
and rename after the entire page processes successfully. Checkpoints bind endpoint,
network, account/filter and ordering/start ledger. Missing files start a new scan;
malformed, outdated or mismatched files fail closed. Inspect or delete the file
explicitly to reset; changing filters needs a separate checkpoint.

Stable event IDs or transaction hashes deduplicate within a run. Checkpoints
prevent blind replay of committed pages, but a crash/processing failure midway
through a page replays that page. External side effects must be idempotent using
the stable identifier; this is not exactly-once delivery. No database is needed
for the console-processing demo. Save failures stop the scan. No checkpoint is
advanced for a failed fetch or failed processing batch.

HTTP 429/5xx and timeout/temporary connection errors get up to three retries with
exponential backoff. Persistent failures terminate with the old checkpoint.
SDK RPC calls have a 15-second timeout. Stop with Ctrl+C; resume from the last
committed batch. Unavailable/pruned ledgers and stale RPC cursors require inspecting
the provider retention window; choose a supported START_LEDGER and a new checkpoint
only after acknowledging the history gap. Horizon pruning, backfills and Testnet
resets can also invalidate scan assumptions. A cursor is progress within the
provider's available history, not proof of complete archival history.

## Tests and manual Testnet checks

`npx jest tests/lifecycle-checkpoint-examples.test.ts --runInBand --coverage=false`
uses mocks/local files and no network or funds. It covers input validation, XDR
decoding, operation parameters, pagination, deduplication, retries, batch failure,
checkpoint loading and resumed history.

Manual network validation is opt-in: use a funded Testnet holder and existing
issuer, inspect/create/update/remove only after reviewing and signing externally;
for paths provide assets with actual liquidity and funded/trusted destination.
For events use a recently invoked contract and a retained ledger. Run history
twice, then make a Testnet transaction and confirm only new records appear. Never
use real funds for these manual checks. No live integration test runs by default.

The baseline repository has separate installation/catalog/source failures tracked
in upstream issue #413; these can block central commands independently of these
examples. Direct entry points permit isolated validation.

### Verification in this checkout

- New offline suite: 10 tests pass.
- ESLint and Prettier pass for the new TypeScript files.
- Isolated strict TypeScript compilation passes for all four entry points and tests.
- Full `npm run typecheck` is blocked by existing catalog syntax errors starting
  at line 6197 (the file contains concatenated catalog declarations).
- Full `npm run lint` fails in existing analyzer and other source files.
- Full `npm test -- --runInBand`: 27 suites pass, 40 fail; failures include existing
  concatenated source in `src/stellar-api-inspector.ts` and catalog parse errors.
- `npm install --ignore-scripts` and `npm ci --ignore-scripts` fail because existing
  `wasm-parser@^1.0.1` is unavailable (npm 404). Local verification installed the
  other declared dependencies temporarily, then restored the original dependency
  declarations and lockfile. No dependency versions were changed. The malformed
  `bin` JSON separator/duplicate key was repaired so npm can parse the manifest.
- No live Testnet transactions or RPC integration checks were performed.
