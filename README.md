# 🎓 Stellar SDK Example Hub

[![CI Status](https://github.com/your-org/stellar-sdk-example-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/your-org/stellar-sdk-example-hub/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A curated repository of runnable TypeScript examples demonstrating key features of the Stellar and Soroban JavaScript/TypeScript SDK (`@stellar/stellar-sdk`).

Designed to help developers build, sign, submit, inspect, and troubleshoot operations on the Stellar network.

## Examples Roadmap & Catalog

The repository currently includes the following runnable examples:

1. **`01-create-account`**: Keypair generation and Testnet funding through Friendbot.
2. **`02-payment`**: Building, signing, and submitting simple native XLM payments.
3. **`03-create-trustline`**: Setting up trustlines to receive non-native assets.
4. **`04-multisig`**: Multi-signature setup, changing thresholds, and gathering signatures.
5. **`05-soroban-invoke`**: Simulating and invoking smart contract methods.
6. **`07-claimable-balances`**: Creating a claimable balance and claiming it with predicates.
7. **`08-liquidity-pools`**: Liquidity pool identification, trustline setup, deposit, and withdrawal.
8. **`09-fee-bump`**: Wrapping a signed transaction in a sponsor-paid fee-bump transaction.
9. **`10-soroban-events`**: Subscribing to and decoding Soroban contract event streams.
10. **`11-sponsored-reserves`**: Demonstrating the sponsorship lifecycle with sponsored reserves and verification.
11. **`12-asset-issuance`**: Issuing a custom asset and locking the issuer account weight to zero.
12. **`13-soroban-deploy`**: Uploading and deploying a Soroban WASM smart contract.
13. **`14-time-locked-escrow`**: Demonstrating a transaction that is valid only within a defined time window.
14. **`15-account-merge`**: Merging an account into a destination account to recover its minimum reserve.
15. **`16-batched-operations`**: Bundling multiple payment operations into one atomic transaction.
16. **`17-offline-signing`**: Building unsigned transaction XDR, signing it offline, and verifying it.
17. **`18-soroban-errors`**: Intentionally triggering and parsing Soroban RPC and simulation errors.
18. **`19-horizon-streaming`**: Subscribing to live Horizon Testnet payment events through Server-Sent Events.
19. **`20-sep10-authentication`**: SEP-10 challenge generation, signing, verification, and JWT issuance.
20. **`21-sep24-deposit-withdrawal`**: Running SEP-24 interactive deposit and withdrawal against a Testnet anchor.
21. **`22-advanced-multisig`**: Managing weighted signers, threshold tiers, signer rotation, and insufficient-signature failures.
22. **`22-manage-buy-offer`**: Creating, modifying, and deleting buy offers on the Stellar SDEX with `manageBuyOffer`.
23. **`23-soroban-upgrade`**: Deploying a Soroban contract, uploading upgraded WASM, executing an upgrade, and verifying persisted state.
24. **`23-manage-data-entries`**: Creating, updating, querying, and removing account data entries with `manageData`.
25. **`24-create-passive-sell-offer`**: Creating a passive sell offer on the SDEX for resting liquidity provision.
26. **`24-cross-contract-invoke`**: Demonstrating cross-contract invocation, authorization, and returned values.
27. **`25-account-flags`**: Viewing and modifying issuer account authorization flags (`AUTH_REQUIRED`, `AUTH_REVOCABLE`, and `AUTH_IMMUTABLE`).
28. **`26-sponsored-claimable-balance`**: Creating a sponsored claimable balance and claiming it from the recipient account.
29. **`27-manage-sell-offer`**: Creating, updating, and removing sell offers directly on the SDEX.
30. **`28-trustline-authorization`**: Authorizing, deauthorizing, and reauthorizing an asset trustline.
31. **`29-account-home-domain`**: Setting, inspecting, updating, and removing an account home domain.
32. **`29-inflation-destination`**: Setting, inspecting, and removing an account inflation destination.
33. **`30-end-sponsoring-reserves`**: Completing the lifecycle of sponsored reserves and inspecting the resulting account state.
34. **`30-horizon-pagination`**: Retrieving and traversing paginated Horizon records safely across multiple pages.
35. **`23-manage-data-entries`**: Creating, updating, querying, and removing account data entries with `manageData`.
36. **`24-create-passive-sell-offer`**: Creating a passive sell offer on the SDEX for resting liquidity provision.
37. **`24-cross-contract-invoke`**: Demonstrating cross-contract invocation, authorization, and returned values.
38. **`25-account-flags`**: Viewing and modifying issuer account authorization flags (`AUTH_REQUIRED`, `AUTH_REVOCABLE`, and `AUTH_IMMUTABLE`).
39. **`26-sponsored-claimable-balance`**: Creating a sponsored claimable balance and claiming it from the recipient account.
40. **`27-manage-sell-offer`**: Creating, updating, and removing sell offers directly on the SDEX.
41. **`28-trustline-authorization`**: Authorizing, deauthorizing, and reauthorizing an asset trustline.
42. **`29-account-home-domain`**: Setting, inspecting, updating, and removing an account home domain.
43. **`29-inflation-destination`**: Setting, inspecting, and removing an account inflation destination.
44. **`30-end-sponsoring-reserves`**: Completing the lifecycle of sponsored reserves and inspecting the resulting account state.
45. **`30-horizon-pagination`**: Retrieving and traversing paginated Horizon records safely across multiple pages.
46. **`32-ledger-bounds`**: Building transactions with ledger bounds, querying the current ledger sequence, and demonstrating out-of-range rejections.
47. **`33-fee-bump-replacement`**: Wrapping a signed inner transaction in a fee-bump envelope with a higher fee and a separate fee-source account.
48. **`96-fee-bump-recovery-workflow`**: Recover a low-fee transaction by submitting a higher-fee fee-bump replacement.
49. **`37-strict-send-path-payment`**: Executing a strict-send path payment and observing the amount received.
50. **`36-strict-receive-path-payment`**: Executing a strict-receive path payment with a fixed destination amount and a maximum source spend.
51. **`35-revoke-sponsorship`**: Revoking sponsorship from a sponsored data entry and observing reserve responsibility shift back to the owner.
52. **`38-account-signer-management`**: Managing account signers and weights for multi-party authorization.
53. **`39-account-thresholds`**: Configuring and verifying low, medium, and high account thresholds while restoring the original account configuration.
54. **`41-sponsored-reserve-inspection`**: Inspecting sponsored and sponsoring ledger entries, identifying sponsorship relationships, and calculating reserve impact.
55. **`42-account-sequence-numbers`**: Retrieving, consuming, and correctly managing account sequence numbers across ordered transactions.
56. **`38-account-signer-management`**: Managing account signers and weights for multi-party authorization.
57. **`39-account-thresholds`**: Configuring and verifying low, medium, and high account thresholds while restoring the original account configuration.
58. **`32-ledger-bounds`**: Building transactions with ledger bounds, querying the current ledger sequence, and demonstrating out-of-range rejections.
59. **`33-fee-bump-replacement`**: Wrapping a signed inner transaction in a fee-bump envelope with a higher fee and a separate fee-source account.
60. **`37-strict-send-path-payment`**: Executing a strict-send path payment and observing the amount received.
61. **`36-strict-receive-path-payment`**: Executing a strict-receive path payment with a fixed destination amount and a maximum source spend.
62. **`35-revoke-sponsorship`**: Revoking sponsorship from a sponsored data entry and observing reserve responsibility shift back to the owner.
63. **`38-account-signer-management`**: Managing account signers and weights for multi-party authorization.
64. **`39-account-thresholds`**: Configuring and verifying low, medium, and high account thresholds while restoring the original account configuration.
65. **`41-sponsored-reserve-inspection`**: Inspecting sponsored and sponsoring ledger entries, identifying sponsorship relationships, and calculating reserve impact.
66. **`42-account-sequence-numbers`**: Retrieving, consuming, and correctly managing account sequence numbers across ordered transactions.
67. **`44-resilient-horizon-stream`**: Consuming a Horizon payment stream with cursor resume, controlled reconnection backoff, and graceful shutdown.
68. **`45-horizon-effects`**: Querying Horizon transaction effects, interpreting common effect types, and comparing operation intent to ledger state changes.
69. **`46-transaction-detail-inspection`**: Retrieving a Horizon transaction by hash and inspecting its metadata, result status, memo, envelope, and XDR information.
70. **`47-account-data-entries`**: Creating, reading, updating, and removing account data entries while explaining reserve implications.
71. **`48-asset-authorization-flags`**: Configuring issuer authorization flags and observing trustline authorization and revocation behavior.
72. **`49-claimable-balance-inspection`**: Inspecting claimable balances, claimants, and predicates with claimant-based Horizon filtering.
73. **`51-failed-transaction-analysis`**: Inspecting failed transaction result codes and operation errors with human-readable diagnostics.
74. **`54-fee-stats`**: Inspecting network fee statistics, fee percentiles, capacity usage, and recommended fee values.
75. **`57-account-reserve-calculator`**: Calculating account minimum reserve requirements and available XLM balance from ledger entry breakdowns.
76. **`58-account-relationship-discovery`**: Discovering and grouping account relationships including signers, asset issuers, sponsorships, and counterparties.
77. **`66-ledger-effects`**: Retrieving every effect produced by one closed ledger, grouping them by effect type and category, and summarizing the state changes a ledger introduced.
78. **`67-soroban-contract-events`**: Querying Soroban contract events over a ledger range, decoding event topics and data payloads, and reporting the ledger and transaction that produced each event.
79. **`67-soroban-contract-events`**: Querying Soroban contract events over a ledger range, decoding event topics and data payloads, and reporting the ledger and transaction that produced each event.
80. **`50-asset-issuer-discovery`**: Querying Horizon for an issued asset by code and issuer, displaying trustline/holder counts and authorization flags.
81. **`51-failed-transaction-analysis`**: Inspecting failed transaction result codes and operation errors with human-readable diagnostics.
82. **`52-account-balance-history`**: Reconstructing a simple native XLM balance history from recent Horizon effects with transaction and ledger references.
83. **`53-ledger-inspection`**: Retrieving and inspecting a Horizon ledger's sequence, close time, transaction/operation counts, protocol version, and base fee.
84. **`54-fee-stats`**: Inspecting network fee statistics, fee percentiles, capacity usage, and recommended fee values.
85. **`55-trade-history`**: Retrieving completed SDEX trades for an asset pair, displaying prices, amounts, and transaction references, and calculating traded volume and average price.
86. **`60-network-configuration`**: Selecting Testnet vs Mainnet Horizon / Soroban RPC endpoints, binding `TransactionBuilder` to the correct network passphrase, detecting mismatched configuration, and explaining why a transaction signed for one network cannot be submitted to another.
87. **`56-account-flags-inspection`**: Inspecting Horizon account flags (`auth_required`, `auth_revocable`, `auth_immutable`, `auth_clawback_enabled`), master key state, and restrictive configurations during an account audit.
88. **`57-account-reserve-calculator`**: Calculating account minimum reserve requirements and available XLM balance from ledger entry breakdowns.
89. **`58-account-relationship-discovery`**: Discovering and grouping account relationships including signers, asset issuers, sponsorships, and counterparties.
90. **`59-account-offer-inspection`**: Inspecting an account's active SDEX offers, selling/buying assets, prices, amounts, and approximate fill volumes.
91. **`61-horizon-resource-filtering`**: Building filtered Horizon queries across transactions, operations, payments, and effects with cursor-based pagination.
92. **`84-muxed-account-handling`**: Creating, parsing, and validating muxed accounts and extracting base account IDs and muxed identifiers.
93. **`85-transaction-fee-estimation`**: Estimating transaction fees from network fee statistics across low, recommended, and high priority levels.
94. **`86-transaction-memo-handling`**: Building and decoding MEMO_TEXT, MEMO_ID, MEMO_HASH, and MEMO_RETURN memos with size and privacy guidance.
95. **`87-transaction-envelope-inspection`**: Inspecting transaction envelopes, signatures, signer hints, and XDR serialization round-trips.
96. **`68-soroban-contract-simulation`**: Simulating a Soroban contract invocation, inspecting resource estimates and returned values, and assembling the footprint-bearing transaction without broadcasting.
97. **`69-soroban-contract-storage`**: Retrieving and inspecting Soroban contract storage entries via `getLedgerEntries`, decoding keys and values, and explaining instance, persistent, and temporary storage durability.
98. **`70-soroban-authorization`**: Invoking an authorized Soroban contract method, obtaining and signing authorization entries from simulation, and explaining how authorization differs from transaction signatures.
99. **`71-soroban-storage-update`**: Demonstrating the complete lifecycle of a Soroban storage update — reading initial state, simulating and submitting the modifying transaction, polling for confirmation, and verifying the updated value.
100. **`100-authorization-entry-inspection`**: Decoding a `SorobanAuthorizationEntry` — distinguishing source-account from address credentials, walking the invocation tree including sub-invocations, decoding arguments, and reading the nonce and signature expiration ledger.
101. **`101-simulation-result-analysis`**: Interpreting every part of a `simulateTransaction` response — classifying success, error and restore-required outcomes, reading the resource budget and ledger footprint, decoding the return value, and decoding diagnostic events.
102. **`102-contract-storage-inspection`**: Probing contract storage keys across persistent and temporary durability, displaying raw `ScVal` XDR alongside decoded values, and handling missing keys and decoding failures without aborting the sweep.
103. **`103-storage-ttl-management`**: Reading a storage entry's `liveUntilLedgerSeq`, classifying how much life it has left, and building, simulating and submitting an `ExtendFootprintTTL` transaction — plus when to restore an archived entry instead.

## Installation

Ensure you have [Node.js](https://nodejs.org/) version 18.0.0 or later installed.

Clone the repository and install its dependencies:

```bash
git clone https://github.com/your-org/stellar-sdk-example-hub.git
cd stellar-sdk-example-hub
npm install
```

## Running Examples

The repository includes a central runner for selecting and executing examples.

### Interactive Mode

Run the interactive runner:

```bash
npm run dev
```

Select an example with the arrow keys, provide any requested parameters, and confirm execution.

The transaction-detail inspection example prompts for a transaction hash. Leaving the prompt blank causes it to inspect the latest transaction returned by the connected Horizon server.

### Direct Run

Run a specific example by passing its catalog name:

```bash
npm run run-example 01-create-account
```

Run the account-threshold configuration example:

```bash
npm run run-example 39-account-thresholds
```

Run the sponsored reserve inspection example:

```bash
npm run run-example 41-sponsored-reserve-inspection
```

Run the account sequence-number management example:

```bash
npm run run-example 42-account-sequence-numbers
```

Inspect the latest transaction returned by Horizon:

```bash
npm run run-example 46-transaction-detail-inspection
```

Inspect Horizon effects for the latest transaction:

```bash
npm run run-example 45-horizon-effects
```

Run account data entry management (create, update, remove):

```bash
npm run run-example 47-account-data-entries
```

Run asset authorization flag and trustline authorization workflow:

```bash
npm run run-example 48-asset-authorization-flags
```

Inspect claimable balances and claimant predicates:

```bash
npm run run-example 49-claimable-balance-inspection
```

Inspect every effect produced by a closed ledger:

```bash
npm run run-example 66-ledger-effects
```

Inspect a specific ledger and raise the result limit by passing them as additional command-line arguments:

```bash
npm run run-example -- 66-ledger-effects <ledger-sequence> 100
```

The same values can be supplied through the `LEDGER_SEQUENCE` and `EFFECT_LIMIT` environment variables, and the Horizon endpoint through `HORIZON_URL` (defaulting to `https://horizon-testnet.stellar.org`). Leaving the ledger sequence blank inspects the latest closed ledger, so the example runs without any setup.

This example is read-only. It prints the ledger header (close time, transaction counts, operation count), then every effect with its type, affected account, and ledger sequence, followed by a breakdown grouped by effect type and by category (account balances, trustlines, DEX activity, claimable balances, liquidity pools, sponsorship, smart contracts) and summary statistics: distinct effect types, accounts touched, operations and transactions involved, and effects per operation.

Effect records do not carry a ledger field of their own. The ledger sequence, the transaction's position within that ledger, and the operation's position within that transaction are all decoded from the effect ID, which is the operation's TOID (`ledgerSequence << 32 | transactionOrder << 12 | operationIndex`) followed by the effect index.

Ledger effects differ from transaction effects and account effects in scope, not in record shape. Ledger effects cover every transaction in one closed ledger — a complete, bounded slice of history that will never change. Transaction effects (`45-horizon-effects`) cover one submission across its operations, which is what you want after submitting. Account effects cover one participant across all of history, spanning many ledgers and growing as the account stays active. The same `account_credited` record, with the same ID, can be returned by all three endpoints.

Invalid ledger sequences are rejected before any request is made, and a ledger that Horizon does not have — not yet closed, never ingested, or pruned — is reported with the latest available sequence rather than as an opaque 404. A ledger that closed with no transactions, or whose transactions all failed, is reported as an empty result with an explanation rather than as an error.

Inspect the events emitted by a Soroban smart contract:

```bash
npm run run-example 67-soroban-contract-events
```

Query a specific contract, ledger range, and result limit by passing them as additional command-line arguments:

```bash
npm run run-example -- 67-soroban-contract-events <contract-id> <start-ledger> <end-ledger> 25
```

The same values can be supplied through the `CONTRACT_ID`, `START_LEDGER`, `END_LEDGER`, `EVENT_LIMIT`, and `EVENT_TYPE` environment variables, and the RPC endpoint through `SOROBAN_RPC_URL` (defaulting to `https://soroban-testnet.stellar.org`). Leaving the contract ID blank makes the example discover a recently active contract on the connected network, so it runs without any setup. Leaving the ledger range blank scans roughly the last 24 hours of ledgers.

This example is read-only. For each event it prints the emitting contract, the ledger sequence and close time, the transaction hash, every indexed topic with its XDR type (`scvSymbol`, `scvAddress`, `scvI128`, …), and the decoded data payload. It also aggregates the results by event name and event type, and flags events emitted by a sub-call that later failed.

Contract events are **not** Horizon events. Horizon operations and effects are derived from protocol-defined changes to classic ledger state and are retained for the instance's full history; Soroban contract events are application-defined values the contract author chose to publish, live in transaction meta rather than ledger state, and are retained by Soroban RPC only for a rolling window (commonly around 24 hours). Because of that window, activity older than the retention period cannot be recovered by widening the ledger range — long-term event history has to be ingested as it happens. Queries that predate the window are narrowed automatically, and a contract with no events in range is reported as an empty result rather than an error.

To generate events of your own, deploy a contract with `13-soroban-deploy` and invoke it with `05-soroban-invoke`, then pass the resulting contract ID to this example. Example `10-soroban-events` covers the same RPC method in a shorter, minimal form.
Discover an asset issuer and trustline/holder counts:

```bash
npm run run-example 50-asset-issuer-discovery
```

Look up a specific issued asset by code and issuer:

```bash
npm run run-example -- 50-asset-issuer-discovery <asset-code> <issuer-account-id>
```

An issued asset is uniquely identified by `asset_code` + `asset_issuer` — the code alone is not unique. Leaving both blank makes the example discover a recently indexed asset on the connected network. Unknown or unindexed assets are reported as an empty result rather than a crash.

Reconstruct a simple native XLM balance history from recent effects:

```bash
npm run run-example 52-account-balance-history
```

Inspect balance history for a specific account with a custom effect window:

```bash
npm run run-example -- 52-account-balance-history <account-id> 50
```

This example reconstructs chronological native XLM balance changes from `account_credited`, `account_debited`, and `account_created` effects. It is educational rather than a production ledger: history outside the retrieved window is inferred, and failed transactions produce no effects. The account ID and limit can also be supplied through `ACCOUNT_ID` and `HISTORY_LIMIT`.

Inspect a Horizon ledger (latest when no sequence is given):

```bash
npm run run-example 53-ledger-inspection
```

Inspect a specific ledger sequence:

```bash
npm run run-example -- 53-ledger-inspection <ledger-sequence>
```

The ledger example displays sequence, close time, hash / previous hash, transaction and operation counts, protocol version, and base fee / reserve. Unavailable sequences (future or outside history retention) produce a clear error. The sequence can also be supplied through `LEDGER_SEQUENCE`.

Audit the account-level flags of a recently active account:

```bash
npm run run-example 56-account-flags-inspection
```

Audit a specific account by passing its ID as an additional command-line argument:

```bash
npm run run-example -- 56-account-flags-inspection <account-id>
```

This example is read-only. It explains each flag, reconstructs the raw flag bitmask, reports the master key weight, and highlights restrictive configurations such as `AUTH_IMMUTABLE` or a disabled master key. Accounts with no flags set are reported as using default, permissionless behaviour. The account ID can also be supplied through the `ACCOUNT_ID` environment variable.

Summarize recent SDEX trades for a recently traded asset pair:

```bash
npm run run-example 55-trade-history
```

Summarize trades for a specific pair by passing the base asset, counter asset, and result limit as additional command-line arguments:

```bash
npm run run-example -- 55-trade-history native USDC:<issuer-account-id> 25
```

Each side of the pair is given as `native` (or `XLM`) for the native asset, or as `CODE:ISSUER` for an issued asset; the same values can be supplied through the `BASE_ASSET`, `COUNTER_ASSET`, and `TRADE_LIMIT` environment variables. Prices are quoted as counter units per 1 base unit, so reversing the pair inverts every price. Leaving both assets blank makes the example discover a pair from the most recent trade on the connected network.

This example reports **completed** trades, which is the counterpart to orderbook depth: `server.orderbook(base, counter)` returns the bids and asks that are currently resting and may never execute, while `server.trades().forAssetPair(...)` returns executions that already settled on the ledger. Alongside each trade's timestamp, price, amounts, and operation and transaction references, the example reports total traded volume, an unweighted average price, and the volume-weighted average price (VWAP). A pair with no trades is reported as an empty history rather than an error, since it indicates the market has never executed rather than that the request failed.

Inspect Testnet vs Mainnet network configuration (Horizon, Soroban RPC, and passphrase):

```bash
npm run run-example 60-network-configuration
```

Select Mainnet explicitly via CLI or environment variable:

```bash
npm run run-example -- 60-network-configuration mainnet
STELLAR_NETWORK=mainnet npm run run-example 60-network-configuration
```

The example prints the selected Horizon and Soroban RPC endpoints, binds `TransactionBuilder` to the matching network passphrase, rejects mismatched endpoint/passphrase combinations, and shows why a transaction signed for one network cannot be submitted to another. It never submits Mainnet transactions.
Inspect an account's active SDEX offers:

```bash
npm run run-example 59-account-offer-inspection
```

Inspect offers for a specific account:

```bash
npm run run-example -- 59-account-offer-inspection <account-id>
```

This example is read-only. It lists offer IDs, selling/buying assets, amounts, prices (including rational representation), and approximate fill volume, and summarizes totals across active offers. Accounts with no offers produce a clear empty-state message. Leaving the account blank prefers an account that already has resting offers when Horizon has any. The account ID and limit can also be supplied through `ACCOUNT_ID` and `OFFER_LIMIT`.

Run the ledger bounds example:

```bash
npm run run-example 32-ledger-bounds
```

Run the fee-bump replacement workflow:

```bash
npm run run-example 33-fee-bump-replacement
```

Run the fee-bump recovery workflow:

```bash
npm run run-example 96-fee-bump-recovery-workflow
```

Inspect a specific transaction by supplying its hash as an additional command-line argument:

```bash
npm run run-example -- 46-transaction-detail-inspection <transaction-hash>
```

You can also provide the hash through the `TRANSACTION_HASH` environment variable.

Stream live Horizon Testnet payment events:

```bash
npm run run-example 19-horizon-streaming
```

The streaming example listens from cursor `now`, prints formatted payment-like operations as they arrive, logs stream errors, and closes cleanly when you press Ctrl+C.

For quick sampling, set `STREAM_DURATION_SECONDS=10` or `STREAM_MAX_EVENTS=3`.

Run the resilient streaming example with explicit reconnect backoff:

```bash
npm run run-example 44-resilient-horizon-stream
```

The resilient stream tracks the last paging token, logs each reconnect attempt, and resumes from the saved cursor instead of replaying already-processed records.

Simulate a Soroban contract invocation without broadcasting:

```bash
npm run run-example 68-soroban-contract-simulation
```

Supply a custom contract ID and method via environment variables:

```bash
CONTRACT_ID=<contract-id> CONTRACT_METHOD=<method> npm run run-example 68-soroban-contract-simulation
```

The example connects to Soroban RPC, builds an invocation transaction, submits it for simulation, and displays estimated resource usage (CPU instructions, read/write bytes, ledger footprint) and the returned value. It then assembles the footprint-bearing transaction without submitting — demonstrating the exact preparation steps required before signing and broadcasting.

Inspect Soroban contract storage entries:

```bash
npm run run-example 69-soroban-contract-storage
```

Inspect storage for a specific contract:

```bash
CONTRACT_ID=<contract-id> npm run run-example 69-soroban-contract-storage
```

The example queries the contract's instance entry and a named persistent key, decodes and displays their values and live-until ledger sequences, demonstrates graceful handling of missing keys, and explains the difference between instance, persistent, and temporary storage durability — and how storage differs from contract events.

Invoke an authorized Soroban contract method:

```bash
npm run run-example 70-soroban-authorization
```

The example funds an ephemeral account, builds a contract invocation, simulates to obtain authorization entries, inspects and signs each entry with the authorized keypair, assembles the transaction, and submits it — explaining at each step how Soroban authorization differs from ordinary transaction signatures.

Demonstrate the Soroban storage update lifecycle:

```bash
npm run run-example 71-soroban-storage-update
```

Supply a custom contract and methods:

```bash
CONTRACT_ID=<id> CONTRACT_METHOD=increment CONTRACT_READ_METHOD=get npm run run-example 71-soroban-storage-update
```

Decode a Soroban authorization entry:

```bash
npm run run-example 100-authorization-entry-inspection
```

Decode an entry supplied by a dApp, as a wallet would:

```bash
AUTH_ENTRY_XDR=<base64> npm run run-example 100-authorization-entry-inspection
```

The example obtains authorization entries from simulation, distinguishes source-account credentials from address credentials, walks the invocation tree including nested sub-invocations, decodes each argument, and reports the nonce and signature expiration ledger relative to the current ledger — the fields a wallet must show a user before collecting a signature.

Analyse a simulation result in full:

```bash
npm run run-example 101-simulation-result-analysis
```

```bash
CONTRACT_ID=<contract-id> CONTRACT_METHOD=<method> npm run run-example 101-simulation-result-analysis
```

The example classifies the response as success, error or restore-required, reports the CPU/read/write resource budget and minimum resource fee, decodes the read-only and read-write footprint into readable ledger keys, decodes the return value and state changes, and decodes the diagnostic event log — the part that usually explains a failure the top-level error message does not.

Sweep contract storage across durability tiers:

```bash
npm run run-example 102-contract-storage-inspection
```

```bash
CONTRACT_ID=<contract-id> STORAGE_KEYS=COUNTER,Admin npm run run-example 102-contract-storage-inspection
```

The example probes each key in both persistent and temporary storage, prints raw `ScVal` XDR next to the decoded value, reports last-modified and live-until ledgers, and ends with a summary table — making it obvious when a value is missing simply because it lives in the other durability tier.

Inspect and extend a storage entry's TTL:

```bash
npm run run-example 103-storage-ttl-management
```

Submit the extension against a funded account:

```bash
EXTEND_TTL=true SECRET_KEY=<secret> EXTEND_TO=100000 npm run run-example 103-storage-ttl-management
```

The example reads the entry's `liveUntilLedgerSeq`, converts the remaining ledgers into an approximate duration, classifies the entry as healthy, expiring soon or expired, then builds an `ExtendFootprintTTL` transaction with the entry in its read-only footprint and simulates it to price the rent. It is read-only unless `EXTEND_TTL=true`, and it explains why an archived persistent entry needs `restoreFootprint` rather than an extension, while an expired temporary entry is gone for good.

The example reads the initial storage value, simulates and submits a state-modifying transaction, polls for on-chain confirmation, and re-reads the storage to display a before-and-after comparison.

_Note: You can configure custom environment variables in a local `.env` file, including `HORIZON_URL`, `SOROBAN_RPC_URL`, `NETWORK_PASSPHRASE`, and `TRANSACTION_HASH`._

## Automated Example Validation

The repository includes an automated validation framework that discovers runnable examples and validates them in isolated subprocesses.

### Architecture

- **Discovery:** `src/validation/discovery.ts` recursively finds files under `src/examples` that match the configured file pattern.
- **Configuration:** `src/validation/validation.config.json` defines discovery rules, timeout behaviour, and exclusions.
- **Execution:** `src/validation/executor.ts` runs each example in its own Node.js process and captures standard output, standard error, duration, and runtime failures.
- **Reporting:** `src/validation/reporter.ts` builds a reusable summary object and renders CI-friendly report output.
- **Entrypoint:** `src/validate-examples.ts` is the CLI command used locally and in GitHub Actions.

### Run Locally

Run validation with CI-safe exclusions applied:

```bash
npm run validate:examples
```

Run all discovered examples, including excluded examples:

```bash
npm run validate:examples:all
```

Target specific examples:

```bash
npm run validate:examples -- --only 01-create-account,02-payment
```

Target the four account and transaction examples:

```bash
npm run validate:examples -- --only 39-account-thresholds,41-sponsored-reserve-inspection,42-account-sequence-numbers,46-transaction-detail-inspection
```

Use a custom configuration file:

```bash
npm run validate:examples -- --config path/to/validation.config.json
```

### Exclusion Mechanism

Examples that require external credentials, user interaction, or unavailable services can be excluded through the validation configuration:

```json
{
  "exclusions": [
    {
      "match": "05-soroban-invoke",
      "reason": "Requires Soroban RPC availability and deployed contracts"
    },
    {
      "match": "18-*",
      "reason": "Requires external service behavior that is not deterministic in CI"
    }
  ]
}
```

The `match` property supports `*` wildcard patterns and is evaluated against the example name without the `.ts` extension.

### CI Integration

The CI workflow runs `npm run validate:examples` on every push and pull request. The step fails automatically when validation reports one or more failed examples.

### Adding New Examples

When a new file is added under `src/examples` and matches the configured file pattern, the validation framework discovers it automatically.

- If the example can run safely in CI, no additional validation registration is required.
- If the example cannot run reliably in CI, add an exclusion rule to `src/validation/validation.config.json` with a clear reason.

## Contributing

Contributions are welcome. To add or improve an example, read [CONTRIBUTING.md](./CONTRIBUTING.md) for the repository’s contribution guidance.

## License

This project is licensed under the MIT License. See [LICENSE](./LICENSE) for details.
