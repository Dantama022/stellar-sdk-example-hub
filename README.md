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
74. **`148-result-code-decoder`**: Retrieving a transaction from Horizon and decoding transaction and operation result codes into categorized diagnostics, explanations, and troubleshooting suggestions.
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
92. **`62-payment-history`**: Retrieving recent account payment records, identifying incoming and outgoing transfers, and displaying amounts, assets, counterparties, ledgers, timestamps, and transaction hashes.
93. **`63-asset-discovery`**: Browsing Horizon asset records, filtering by asset code, distinguishing issuers, and displaying holder, balance, claimable-balance, liquidity-pool, and contract statistics.
94. **`64-liquidity-pool-inspection`**: Browsing available liquidity pools or inspecting a pool ID, including reserve assets, balances, pool shares, fees, and participating accounts.
95. **`65-offer-book-inspection`**: Inspecting active Stellar offers with selling and buying asset filters, seller details, prices, amounts, ledger references, and market summary statistics.
96. **`84-muxed-account-handling`**: Creating, parsing, and validating muxed accounts and extracting base account IDs and muxed identifiers.
97. **`85-transaction-fee-estimation`**: Estimating transaction fees from network fee statistics across low, recommended, and high priority levels.
98. **`86-transaction-memo-handling`**: Building and decoding MEMO_TEXT, MEMO_ID, MEMO_HASH, and MEMO_RETURN memos with size and privacy guidance.
99. **`87-transaction-envelope-inspection`**: Inspecting transaction envelopes, signer hints, and XDR serialization round-trips.
100. **`150-mixed-operation-transaction`**: Building and inspecting one atomic transaction containing payment, Manage Data, and bump-sequence operations with operation-specific sources.
101. **`151-fee-bump-wrapping`**: Wrapping a base64 transaction envelope in a fee-bump, validating preserved inner fields and signatures, and inspecting the outer envelope.
96. **`68-soroban-contract-simulation`**: Simulating a Soroban contract invocation, inspecting resource estimates and returned values, and assembling the footprint-bearing transaction without broadcasting.
97. **`69-soroban-contract-storage`**: Retrieving and inspecting Soroban contract storage entries via `getLedgerEntries`, decoding keys and values, and explaining instance, persistent, and temporary storage durability.
98. **`70-soroban-authorization`**: Invoking an authorized Soroban contract method, obtaining and signing authorization entries from simulation, and explaining how authorization differs from transaction signatures.
99. **`71-soroban-storage-update`**: Demonstrating the complete lifecycle of a Soroban storage update — reading initial state, simulating and submitting the modifying transaction, polling for confirmation, and verifying the updated value.
100. **`100-authorization-entry-inspection`**: Decoding a `SorobanAuthorizationEntry` — distinguishing source-account from address credentials, walking the invocation tree including sub-invocations, decoding arguments, and reading the nonce and signature expiration ledger.
101. **`101-simulation-result-analysis`**: Interpreting every part of a `simulateTransaction` response — classifying success, error and restore-required outcomes, reading the resource budget and ledger footprint, decoding the return value, and decoding diagnostic events.
181. **`181-soroban-footprint-comparison`**: Comparing Soroban ledger footprints across multiple invocation variants, distinguishing read-only from read-write entries, spotting shared and divergent keys, flagging access-mode changes, and identifying the invocation with the smaller footprint.
102. **`102-contract-storage-inspection`**: Probing contract storage keys across persistent and temporary durability, displaying raw `ScVal` XDR alongside decoded values, and handling missing keys and decoding failures without aborting the sweep.
103. **`103-storage-ttl-management`**: Reading a storage entry's `liveUntilLedgerSeq`, classifying how much life it has left, and building, simulating and submitting an `ExtendFootprintTTL` transaction — plus when to restore an archived entry instead.
23. **`23-manage-data-entries`**: Creating, updating, querying, and removing account data entries with `manageData`.
24. **`24-create-passive-sell-offer`**: Creating a passive sell offer on the SDEX for resting liquidity provision.
25. **`24-cross-contract-invoke`**: Demonstrating cross-contract invocation, authorization, and returned values.
26. **`25-account-flags`**: Viewing and modifying issuer account authorization flags (`AUTH_REQUIRED`, `AUTH_REVOCABLE`, and `AUTH_IMMUTABLE`).
27. **`26-sponsored-claimable-balance`**: Creating a sponsored claimable balance and claiming it from the recipient account.
28. **`27-manage-sell-offer`**: Creating, updating, and removing sell offers directly on the SDEX.
29. **`28-trustline-authorization`**: Authorizing, deauthorizing, and reauthorizing an asset trustline.
30. **`29-account-home-domain`**: Setting, inspecting, updating, and removing an account home domain.
31. **`29-inflation-destination`**: Setting, inspecting, and removing an account inflation destination.
32. **`30-end-sponsoring-reserves`**: Completing the lifecycle of sponsored reserves and inspecting the resulting account state.
33. **`30-horizon-pagination`**: Retrieving and traversing paginated Horizon records safely across multiple pages.
34. **`32-ledger-bounds`**: Building transactions with ledger bounds, querying the current ledger sequence, and demonstrating out-of-range rejections.
35. **`33-fee-bump-replacement`**: Wrapping a signed inner transaction in a fee-bump envelope with a higher fee and a separate fee-source account.
36. **`96-fee-bump-recovery-workflow`**: Recover a low-fee transaction by submitting a higher-fee fee-bump replacement.
37. **`37-strict-send-path-payment`**: Executing a strict-send path payment and observing the amount received.
35. **`36-strict-receive-path-payment`**: Executing a strict-receive path payment with a fixed destination amount and a maximum source spend.
35. **`35-revoke-sponsorship`**: Revoking sponsorship from a sponsored data entry and observing reserve responsibility shift back to the owner.
36. **`38-account-signer-management`**: Managing account signers and weights for multi-party authorization.
37. **`39-account-thresholds`**: Configuring and verifying low, medium, and high account thresholds while restoring the original account configuration.
38. **`41-sponsored-reserve-inspection`**: Inspecting sponsored and sponsoring ledger entries, identifying sponsorship relationships, and calculating reserve impact.
39. **`42-account-sequence-numbers`**: Retrieving, consuming, and correctly managing account sequence numbers across ordered transactions.
35. **`38-account-signer-management`**: Managing account signers and weights for multi-party authorization.
36. **`39-account-thresholds`**: Configuring and verifying low, medium, and high account thresholds while restoring the original account configuration.
35. **`32-ledger-bounds`**: Building transactions with ledger bounds, querying the current ledger sequence, and demonstrating out-of-range rejections.
36. **`33-fee-bump-replacement`**: Wrapping a signed inner transaction in a fee-bump envelope with a higher fee and a separate fee-source account.
37. **`37-strict-send-path-payment`**: Executing a strict-send path payment and observing the amount received.
38. **`36-strict-receive-path-payment`**: Executing a strict-receive path payment with a fixed destination amount and a maximum source spend.
39. **`35-revoke-sponsorship`**: Revoking sponsorship from a sponsored data entry and observing reserve responsibility shift back to the owner.
40. **`38-account-signer-management`**: Managing account signers and weights for multi-party authorization.
41. **`39-account-thresholds`**: Configuring and verifying low, medium, and high account thresholds while restoring the original account configuration.
42. **`41-sponsored-reserve-inspection`**: Inspecting sponsored and sponsoring ledger entries, identifying sponsorship relationships, and calculating reserve impact.
43. **`42-account-sequence-numbers`**: Retrieving, consuming, and correctly managing account sequence numbers across ordered transactions.
44. **`44-resilient-horizon-stream`**: Consuming a Horizon payment stream with cursor resume, controlled reconnection backoff, and graceful shutdown.
45. **`45-horizon-effects`**: Querying Horizon transaction effects, interpreting common effect types, and comparing operation intent to ledger state changes.
46. **`46-transaction-detail-inspection`**: Retrieving a Horizon transaction by hash and inspecting its metadata, result status, memo, envelope, and XDR information.
47. **`47-account-data-entries`**: Creating, reading, updating, and removing account data entries while explaining reserve implications.
48. **`48-asset-authorization-flags`**: Configuring issuer authorization flags and observing trustline authorization and revocation behavior.
49. **`49-claimable-balance-inspection`**: Inspecting claimable balances, claimants, and predicates with claimant-based Horizon filtering.
50. **`51-failed-transaction-analysis`**: Inspecting failed transaction result codes and operation errors with human-readable diagnostics.
51. **`54-fee-stats`**: Inspecting network fee statistics, fee percentiles, capacity usage, and recommended fee values.
52. **`57-account-reserve-calculator`**: Calculating account minimum reserve requirements and available XLM balance from ledger entry breakdowns.
53. **`58-account-relationship-discovery`**: Discovering and grouping account relationships including signers, asset issuers, sponsorships, and counterparties.
54. **`192-soroban-contract-code-inspection`**: Inspecting Soroban contract code metadata, extracting the deployed code identifier, retrieving TTL and ledger information, and optionally comparing a supplied WASM hash against the on-chain code identifier.
54. **`66-ledger-effects`**: Retrieving every effect produced by one closed ledger, grouping them by effect type and category, and summarizing the state changes a ledger introduced.
55. **`67-soroban-contract-events`**: Querying Soroban contract events over a ledger range, decoding event topics and data payloads, and reporting the ledger and transaction that produced each event.
54. **`67-soroban-contract-events`**: Querying Soroban contract events over a ledger range, decoding event topics and data payloads, and reporting the ledger and transaction that produced each event.
50. **`50-asset-issuer-discovery`**: Querying Horizon for an issued asset by code and issuer, displaying trustline/holder counts and authorization flags.
51. **`51-failed-transaction-analysis`**: Inspecting failed transaction result codes and operation errors with human-readable diagnostics.
52. **`52-account-balance-history`**: Reconstructing a simple native XLM balance history from recent Horizon effects with transaction and ledger references.
53. **`53-ledger-inspection`**: Retrieving and inspecting a Horizon ledger's sequence, close time, transaction/operation counts, protocol version, and base fee.
54. **`54-fee-stats`**: Inspecting network fee statistics, fee percentiles, capacity usage, and recommended fee values.
55. **`55-trade-history`**: Retrieving completed SDEX trades for an asset pair, displaying prices, amounts, and transaction references, and calculating traded volume and average price.
56. **`56-account-flags-inspection`**: Inspecting Horizon account flags (`auth_required`, `auth_revocable`, `auth_immutable`, `auth_clawback_enabled`), master key state, and restrictive configurations during an account audit.
57. **`57-account-reserve-calculator`**: Calculating account minimum reserve requirements and available XLM balance from ledger entry breakdowns.
58. **`58-account-relationship-discovery`**: Discovering and grouping account relationships including signers, asset issuers, sponsorships, and counterparties.
59. **`59-account-offer-inspection`**: Inspecting an account's active SDEX offers, selling/buying assets, prices, amounts, and approximate fill volumes.
60. **`61-horizon-resource-filtering`**: Building filtered Horizon queries across transactions, operations, payments, and effects with cursor-based pagination.
61. **`84-muxed-account-handling`**: Creating, parsing, and validating muxed accounts and extracting base account IDs and muxed identifiers.
52. **`52-account-balance-history`**: Reconstructing a simple native XLM balance history from recent Horizon effects with transaction and ledger references.
53. **`53-ledger-inspection`**: Retrieving and inspecting a Horizon ledger's sequence, close time, transaction/operation counts, protocol version, and base fee.
54. **`54-fee-stats`**: Inspecting network fee statistics, fee percentiles, capacity usage, and recommended fee values.
55. **`55-trade-history`**: Retrieving completed SDEX trades for an asset pair, displaying prices, amounts, and transaction references, and calculating traded volume and average price.
56. **`60-network-configuration`**: Selecting Testnet vs Mainnet Horizon / Soroban RPC endpoints, binding `TransactionBuilder` to the correct network passphrase, detecting mismatched configuration, and explaining why a transaction signed for one network cannot be submitted to another.
56. **`56-account-flags-inspection`**: Inspecting Horizon account flags (`auth_required`, `auth_revocable`, `auth_immutable`, `auth_clawback_enabled`), master key state, and restrictive configurations during an account audit.
57. **`57-account-reserve-calculator`**: Calculating account minimum reserve requirements and available XLM balance from ledger entry breakdowns.
58. **`58-account-relationship-discovery`**: Discovering and grouping account relationships including signers, asset issuers, sponsorships, and counterparties.
59. **`59-account-offer-inspection`**: Inspecting an account's active SDEX offers, selling/buying assets, prices, amounts, and approximate fill volumes.
60. **`61-horizon-resource-filtering`**: Building filtered Horizon queries across transactions, operations, payments, and effects with cursor-based pagination.
61. **`140-account-reserve-analysis`**: Inspecting an account's total XLM balance, reserve requirements, subentries, liabilities, sponsorship relationships, and estimated spendable XLM.
62. **`141-sequence-number-management`**: Retrieving on-ledger sequence numbers, allocating sequences locally for multiple pending transactions, detecting stale sequences, and refreshing from Horizon.
63. **`142-batch-transaction-construction`**: Constructing, inspecting, and optionally submitting a batch of independent transactions from one account with correctly ordered sequential sequence numbers.
64. **`143-transaction-time-bounds`**: Constructing transactions with time bounds, evaluating validity status (not-yet-valid, valid, expired), observing txTOO_EARLY and txTOO_LATE rejections, and detecting invalid ranges.
61. **`84-muxed-account-handling`**: Creating, parsing, and validating muxed accounts and extracting base account IDs and muxed identifiers.
62. **`85-transaction-fee-estimation`**: Estimating transaction fees from network fee statistics across low, recommended, and high priority levels.
63. **`86-transaction-memo-handling`**: Building and decoding MEMO_TEXT, MEMO_ID, MEMO_HASH, and MEMO_RETURN memos with size and privacy guidance.
64. **`87-transaction-envelope-inspection`**: Inspecting transaction envelopes, signatures, signer hints, and XDR serialization round-trips.
61. **`68-soroban-contract-simulation`**: Simulating a Soroban contract invocation, inspecting resource estimates and returned values, and assembling the footprint-bearing transaction without broadcasting.
62. **`69-soroban-contract-storage`**: Retrieving and inspecting Soroban contract storage entries via `getLedgerEntries`, decoding keys and values, and explaining instance, persistent, and temporary storage durability.
63. **`70-soroban-authorization`**: Invoking an authorized Soroban contract method, obtaining and signing authorization entries from simulation, and explaining how authorization differs from transaction signatures.
64. **`71-soroban-storage-update`**: Demonstrating the complete lifecycle of a Soroban storage update — reading initial state, simulating and submitting the modifying transaction, polling for confirmation, and verifying the updated value.
65. **`82-transaction-time-bounds`**: Building, simulating, signing, and submitting a Soroban contract invocation with custom time bounds, demonstrating expired and invalid time-bounds handling, and explaining best practices for choosing validity windows.
65. **`80-offline-transaction-workflow`**: Building an unsigned transaction, serializing it to XDR, signing it in a simulated offline (air-gapped) environment, gracefully handling corrupted XDR, and reconstructing and submitting the signed transaction.
65. **`104-contract-restoration`**: Detecting archived Soroban contract ledger entries, building and simulating a `RestoreFootprint` transaction, submitting restoration when required, and verifying the contract becomes accessible again — with guidance on TTL extension versus restoration.
65. **`106-scval-serialization`**: Converting JavaScript values to Soroban ScVal objects and back with reusable helpers, displaying raw XDR, and explaining common serialization pitfalls.
65. **`105-contract-event-decoding`**: Retrieving Soroban contract events and decoding indexed topics and data payloads into human-readable values, with raw base64 XDR shown alongside decoded output.
65. **`107-contract-spec-introspection`**: Retrieving on-chain WASM, parsing Soroban ScSpec metadata, and displaying functions, arguments, return types, user-defined types, and documentation with dynamic function selection.
66. **`108-dynamic-contract-invocation`**: Discovering contract methods from runtime ScSpec metadata, encoding JavaScript arguments into the required `ScVal` types, simulating a dynamically constructed invocation, and decoding its return value.
67. **`109-soroban-transaction-preparation`**: Building and simulating a Soroban invocation, extracting resource limits, fees, footprint and authorization data, applying the simulation result, and inspecting the prepared unsigned transaction XDR.
68. **`110-soroban-transaction-submission`**: Preparing, signing and submitting a Soroban transaction, polling pending status until a terminal result, and displaying the hash, ledger, return value, resource allocation, fees and events.
69. **`111-soroban-transaction-error-diagnosis`**: Retrieving failed Soroban transactions, decoding transaction and diagnostic XDR, identifying failed invocations, classifying failure categories, and displaying actionable troubleshooting guidance.
70. **`188-soroban-transaction-inspection`**: Querying a Soroban transaction by hash, classifying its status, decoding the result/return value and diagnostics, and producing a structured read-only inspection report with polling and JSON output support.
65. **`81-transaction-preflight`**: Running the full Soroban preflight workflow — simulating an invocation, extracting the footprint/authorization/resource-fee data, assembling, signing, submitting, and confirming the final transaction.
65. **`83-multi-contract-transaction`**: Composing a single orchestrator contract invocation that touches multiple downstream contracts, simulating and submitting it, and explaining atomicity and execution order across contracts within one Soroban host invocation.
66. **`93-trustline-management`**: Creating, inspecting, updating, and removing asset trustlines — demonstrating changeTrust operations, trust limit configuration, authorization status inspection, and the 0.5 XLM reserve cost of each subentry.
67. **`92-account-payment-stream`**: Subscribing to a Horizon account payment stream, displaying incoming and outgoing payments in real time, handling stream errors with automatic reconnection, and explaining when streaming should be preferred over polling.
68. **`126-claimable-balance-management`**: Discovering, inspecting, filtering, and claiming eligible Stellar claimable balances end-to-end.
69. **`128-account-authorization-flags`**: Inspecting and managing issuer authorization flags, with both allowTrust and setTrustLineFlags authorization workflows.
70. **`130-sponsored-reserve-management`**: Sponsoring a trustline and a data entry, inspecting reserve responsibility, and revoking one entry's sponsorship.
71. **`131-path-payment-route-inspection`**: Discovering and ranking strict-receive path payment routes without submitting a payment.
68. **`139-account-offer-inspection`**: Inspect an account's open SDEX offers, grouped by trading pair with summary statistics.
69. **`138-account-merge-preflight`**: Inspect a Stellar account to determine merge readiness and identify blocking ledger states.
70. **`132-fee-bump-inspection`**: Decode and inspect fee-bump and normal transaction envelopes offline.
71.  **`136-transaction-fee-estimation`**: Estimate minimum transaction fees using Horizon network fee statistics across operation sizes.
72. **`120-transaction-lifecycle-monitor`**: Monitor a Horizon transaction until confirmation, failure, timeout, or temporary rate limiting, with ledger, fee, operation-count, and result information.
73. **`121-account-history-pagination`**: Traverse an account's Horizon operation history page by page with configurable page size, record limits, operation filtering, cursor-safe traversal, and duplicate prevention.
74. **`122-order-book-inspection`**: Inspect a Stellar trading pair's bids, asks, best prices, spread, midpoint, configurable depth, and summarized liquidity.
75. **`123-trade-history-analysis`**: Retrieve historical trades for a Stellar pair, filter by time, and calculate high, low, average price, traded volume, and trade count.
72. **`124-liquidity-pool-inspection`**: Retrieve and analyze an existing Stellar liquidity pool, its reserves, shares, and fees.
73. **`125-liquidity-pool-simulation`**: Simulate deposit and withdrawal operations on a liquidity pool to estimate share and asset changes.
74. **`127-trustline-management`**: Inspect, create, update, and remove asset trustlines for a Stellar account.
75. **`129-asset-clawback`**: Verify clawback configurations and simulate/execute asset recovery operations.
76. **`133-transaction-signature-verification`**: Decode a Stellar transaction envelope, extract signer hints, and cryptographically verify signatures against candidate public keys offline.
77. **`134-multisignature-threshold-inspection`**: Inspect an account's multisignature configuration (signers, weights, thresholds) and determine if a given transaction holds sufficient authorization.
78. **`135-transaction-preflight-validation`**: Run local and network-dependent preflight validation checks (sequence, fees, time bounds, signatures) on a transaction envelope prior to submission.
79. **`137-dynamic-fee-selection`**: Query Horizon fee statistics and dynamically calculate a transaction fee based on strategies like median, high priority, or custom multipliers, with safety caps.
80. **`157-horizon-pagination`**: Reusable pagination across Horizon transactions, operations, and payments with duplicate prevention, early termination, timeouts, and metrics.
81. **`158-resilient-horizon-streaming`**: Resilient Horizon streaming with cursor resume, duplicate/malformed event handling, exponential backoff reconnects, and stream statistics.
82. **`159-horizon-stream-filtering`**: Client-side AND/OR filtering pipeline for Horizon operation streams covering account, asset, operation type, success status, and amount ranges.
83. **`160-horizon-retry-rate-limit`**: Retry wrapper for transient Horizon failures and 429 rate limits with Retry-After parsing, exponential backoff, and request diagnostics.
84. **`177-soroban-event-decoding`**: Retrieve, filter, decode, and display Soroban contract events with topic and payload decoding, supporting configurable ledger ranges and event-type filtering.
85. **`178-soroban-contract-storage`**: Inspect Soroban contract storage entries across instance, persistent, and temporary durability tiers with decoded keys, values, and TTL information.
86. **`179-soroban-footprint-inspection`**: Extract and analyze the Soroban ledger footprint from a transaction simulation or envelope, distinguishing read-only from read-write entries and detecting duplicates.
87. **`180-soroban-resource-analysis`**: Analyze Soroban resource usage from simulation results with CPU instructions, memory, ledger read/write metrics, utilization percentages, and near-limit detection.
84. **`193-soroban-contract-interface`**: Inspecting deployed Soroban contract interfaces, exported functions, argument/return types, user-defined structs/enums/unions, and generating example call signatures.
85. **`194-soroban-contract-client-generator`**: Generating strongly typed TypeScript contract client wrappers, type definitions, method signatures, and ScVal conversion helpers from a Soroban contract specification.
86. **`195-soroban-interface-compatibility`**: Comparing two Soroban contract specifications to detect additions, removals, parameter/type changes, and classify breaking vs compatible modifications.
87. **`196-soroban-authorization-preparation`**: Preparing, inspecting, decoding, and round-trip verifying Soroban authorization entries and invocation trees without requesting secret keys or signing.

84. **`116-soroban-token-contract`**: Inspect Soroban token metadata, balances, allowances, and optional total supply; construct and simulate a token transfer; and decode returned `ScVal` values.
85. **`117-soroban-auth-tree`**: Simulate Soroban authorization requirements and display readable root and nested invocation trees with signer, contract, function, argument, and signature information.
86. **`118-ledger-footprint-analysis`**: Simulate and compare Soroban ledger footprints, distinguish read-only and read-write entries, decode ledger keys, identify storage types, and display raw XDR.
87. **`119-soroban-resource-fee-analysis`**: Simulate and compare Soroban CPU, memory, ledger I/O, transaction resource limits, resource fees, inclusion fees, and total estimated transaction cost.

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

Decode transaction and operation result codes for a transaction hash:

```bash
npm run run-example -- 148-result-code-decoder <transaction-hash>
```

Print the same diagnostic report as JSON:

```bash
npm run run-example -- 148-result-code-decoder <transaction-hash> --json
```

The hash can also be supplied through `TRANSACTION_HASH`, the Horizon endpoint through `HORIZON_URL`, and JSON output through `JSON_OUTPUT=true`. Unknown result codes remain visible in the report with a generic explanation and protocol-documentation guidance.

Build and inspect a mixed-operation transaction in dry-run mode:

```bash
npm run run-example -- 150-mixed-operation-transaction <source-account>
```

The example loads the source account from Horizon, validates the serialized envelope locally, and does not submit it. Use `--json` for structured output. `SOURCE_ACCOUNT`, `HORIZON_URL`, `DRY_RUN`, and `JSON_OUTPUT` can also configure the run; submission is intentionally disabled because the generated operation-specific accounts are demonstration identities.

Wrap and validate a base64 inner transaction envelope as a fee bump:

```bash
npm run run-example -- 151-fee-bump-wrapping <inner-envelope-xdr> <fee-source-account> 500 --json
```

The example loads the fee-source account from Horizon, compares the inner source, sequence, operations, memo, time bounds, hash, and signatures before and after wrapping, and keeps submission disabled. Set `INNER_ENVELOPE_XDR`, `FEE_SOURCE_ACCOUNT`, `FEE_BUMP_BASE_FEE`, `HORIZON_URL`, and `JSON_OUTPUT` instead of passing arguments. Set `FEE_SOURCE_SECRET` only when demonstrating outer fee-bump signing; the secret is never printed.

Run account data entry management (create, update, remove):

```bash
npm run run-example 47-account-data-entries
```

Inspect decoded account data entries and Manage Data state:

```bash
npm run run-example 89-account-data-inspection
```

Query and inspect claimable balances with claimant-based Horizon filtering:

```bash
npm run run-example 88-claimable-balance-inspection
```

Run asset authorization flag and trustline authorization workflow:

```bash
npm run run-example 48-asset-authorization-flags
```

Inspect claimable balances and claimant predicates:

```bash
npm run run-example 49-claimable-balance-inspection
```

Inspect account data entries and decoded base64 values:

```bash
npm run run-example 89-account-data-inspection
```

Query and inspect claimable balances with claimant-based Horizon filtering:

```bash
npm run run-example 88-claimable-balance-inspection
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

Inspect recent payment history for an account:

```bash
npm run run-example 62-payment-history
```

Supply an account and custom history limit:

```bash
npm run run-example -- 62-payment-history <account-id> 25
```

The example uses Horizon payment records rather than generic operations. It identifies incoming, outgoing, self, and related records; formats native XLM and issued assets; and displays counterparties, transaction hashes, ledger sequences, and timestamps. The account and limit can also be supplied through `ACCOUNT_ID` and `PAYMENT_HISTORY_LIMIT`. Accounts with no payment records produce a clear empty result.

Discover issued Stellar assets:

```bash
npm run run-example 63-asset-discovery
```

Filter assets by code and set a result limit:

```bash
npm run run-example -- 63-asset-discovery USDC 25
```

The example displays the asset code, issuer, type, holder counts, balances, claimable-balance statistics, liquidity-pool holdings, and contract holdings where Horizon provides them. The same asset code can be used by several issuers, so an issued asset is identified by both code and issuer. Configuration is also available through `ASSET_CODE` and `ASSET_DISCOVERY_LIMIT`.

Browse Horizon liquidity pools:

```bash
npm run run-example 64-liquidity-pool-inspection
```

Inspect one specific pool:

```bash
npm run run-example -- 64-liquidity-pool-inspection <liquidity-pool-id>
```

The example displays both participating assets, reserve balances, total pool shares, fee basis points, participating-account counts, and ledger metadata. Liquidity pool IDs are deterministic identifiers derived from canonical pool parameters. Configuration is also available through `LIQUIDITY_POOL_ID` and `LIQUIDITY_POOL_LIMIT`.

Inspect active offers across the Stellar decentralized exchange:

```bash
npm run run-example 65-offer-book-inspection
```

Filter by selling asset, buying asset, and result limit:

```bash
npm run run-example -- 65-offer-book-inspection native USDC:<issuer-account-id> 25
```

The example displays offer IDs, sellers, selling and buying assets, remaining amounts, prices, approximate buying totals, and last-modified ledgers. It explains that offers are open seller-owned intentions, order books aggregate active market depth, trades are completed executions, and liquidity pools are AMM reserves. Configuration is also available through `SELLING_ASSET`, `BUYING_ASSET`, and `OFFER_BOOK_LIMIT`.

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

Paginate multiple Horizon collections with shared metrics and duplicate prevention:

```bash
npm run run-example 157-horizon-pagination
```

Use `--json` or `JSON_OUTPUT=true` for structured output. Configure `PAGE_SIZE`, `MAX_RECORDS`, `REQUEST_TIMEOUT_MS`, and `HORIZON_URL` as needed.

Run a resilient Horizon stream with cursor resume and reconnect backoff:

```bash
npm run run-example 158-resilient-horizon-streaming
```

Filter streamed Horizon operations client-side while preserving the underlying cursor:

```bash
npm run run-example 159-horizon-stream-filtering
```

Demonstrate retry and rate-limit handling for Horizon requests:

```bash
npm run run-example 160-horizon-retry-rate-limit
```

All four examples support `--json` output and can be configured through environment variables such as `HORIZON_URL`, `JSON_OUTPUT`, and stream-specific settings documented in each example file.

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

Build a Soroban contract invocation with custom time bounds:

```bash
npm run run-example 82-transaction-time-bounds
```

Supply a custom contract and method:

```bash
CONTRACT_ID=<id> CONTRACT_METHOD=hello npm run run-example 82-transaction-time-bounds
```

The example computes and validates a time-bounds window, then simulates, signs, and submits a contract invocation within it; deliberately constructs an already-expired window to show how the network rejects a stale transaction with a clear, friendly explanation instead of a raw error; demonstrates graceful rejection of an invalid configuration; and explains why choosing a good time-bounds window matters for Soroban contract execution.
Run the offline transaction preparation workflow:

```bash
npm run run-example 80-offline-transaction-workflow
```

The interactive runner (`npm run run-example` with no example name) also prompts for a custom payment amount before running.

The example builds an unsigned payment transaction on an online machine, serializes it to XDR, simulates transferring that XDR to an air-gapped offline signer, signs it there, and returns the signed XDR. It also deliberately corrupts a copy of the signed XDR to demonstrate graceful error handling before reconstructing the real signed transaction and submitting it to the network — finishing with a short explainer on when and why offline (cold-storage/hardware-wallet) signing should be used.
Detect archived Soroban contract state and demonstrate restoration:

```bash
npm run run-example 104-contract-restoration
```

Inspect a specific contract:

```bash
npm run run-example -- 104-contract-restoration <contract-id>
```

The same contract ID can be supplied through `CONTRACT_ID`. For accessible contracts the example simulates restoration and reports the estimated fee and footprint without submitting an unnecessary transaction. When simulation detects archived entries (`isSimulationRestore`), it prepares, submits, and polls a `RestoreFootprint` transaction, then re-checks accessibility. The output explains the difference between proactive `extendFootprintTtl` and reactive `restoreFootprint`.
Convert JavaScript values to Soroban ScVal and back:

```bash
npm run run-example 106-scval-serialization
```

This offline example encodes booleans, integers, BigInts, strings, symbols, bytes, addresses, vectors, maps, and nested objects using `src/utils/scval-utils.ts`, prints raw base64 XDR for each value, compares originals with decoded round-trip results, and demonstrates graceful handling of unsupported JavaScript types.
Decode Soroban contract event topics and payloads:

```bash
npm run run-example 105-contract-event-decoding
```

Query a specific contract, start ledger, and limit:

```bash
npm run run-example -- 105-contract-event-decoding <contract-id> <start-ledger> 10
```

The same values can be supplied through `CONTRACT_ID`, `START_LEDGER`, and `EVENT_LIMIT`. For each event the example prints the contract ID, ledger sequence, transaction hash, every topic and the data payload with raw base64 XDR beside the decoded value. Unsupported ScVal types are reported without aborting the run.
Inspect a Soroban contract specification from on-chain WASM:

```bash
npm run run-example 107-contract-spec-introspection
```

Select a contract and function dynamically:

```bash
npm run run-example -- 107-contract-spec-introspection <contract-id> balance
```

The same values can be supplied through `CONTRACT_ID` and `CONTRACT_FUNCTION`. The example fetches WASM via Soroban RPC, parses ScSpec metadata with `spec-parser` utilities, lists functions, structs, enums, unions, and error enums, and shows how SDK tooling and explorers use the same metadata. Missing or empty specifications are reported gracefully.
Run a contract method discovered dynamically from its Soroban specification:

```bash
npm run run-example 108-dynamic-contract-invocation
```

The example retrieves deployed contract WASM through Soroban RPC, parses the embedded contract specification, lists methods, selects one at runtime, converts JavaScript values into the exact `ScVal` types declared by the specification, simulates the invocation, and decodes the returned value. Invalid arguments and simulation failures are reported clearly.

Prepare a Soroban transaction without signing or submitting it:

```bash
npm run run-example 109-soroban-transaction-preparation
```

The example builds and simulates a contract invocation, displays resource limits, Soroban fees, ledger footprint and authorization entries, applies the simulation with `rpc.assembleTransaction()`, verifies the prepared data, and prints the prepared transaction XDR. It also explains building, simulation, preparation, signing and submission as separate lifecycle stages.

Run the complete Soroban submission and confirmation lifecycle:

```bash
npm run run-example 110-soroban-transaction-submission
```

By default the example creates a temporary Testnet account and funds it through Friendbot. It builds, simulates, prepares, signs and submits the invocation, then polls until success, failure, timeout or unavailability. Configure polling with `POLL_INTERVAL_MS` and `POLL_TIMEOUT_MS`, or provide a funded account through `SOURCE_SECRET`. The secret is never printed.

Diagnose a failed Soroban transaction:

```bash
npm run run-example 111-soroban-transaction-error-diagnosis
```

Supply a specific failed transaction with `TRANSACTION_HASH=<transaction-hash>`. When no hash is supplied, the example searches recent Soroban RPC transaction history for a failed contract invocation. It distinguishes RPC, transaction, authorization, resource/fee, contract execution and state/archival failures, decodes available diagnostics and XDR, identifies the failed invocation where possible, and provides troubleshooting guidance. Missing diagnostic information is handled gracefully.

Inspect an arbitrary Soroban transaction by hash:

```bash
npm run run-example 188-soroban-transaction-inspection
```

Provide a transaction hash with `TRANSACTION_HASH=<hash>`, optionally set `POLL_INTERVAL_MS` and `POLL_TIMEOUT_MS`, and pass `--json` for machine-readable output. The example validates the hash, requests the transaction from Soroban RPC, handles not-found/pending/failed/success states, decodes any return value and event payloads, prints the raw XDR, and surfaces resource and fee information when the RPC response includes it.

Run the full Soroban transaction preflight workflow:

```bash
npm run run-example 81-transaction-preflight
```

Supply a custom contract ID and method via environment variables:

```bash
CONTRACT_ID=<contract-id> CONTRACT_METHOD=<method> npm run run-example 81-transaction-preflight
```

The example funds an ephemeral fee-payer account, builds a contract invocation transaction, and submits it for preflight simulation to extract the ledger footprint, authorization entries, and estimated resource fee. It then assembles the final transaction from that simulation data, signs and submits it, and polls until on-chain confirmation — while also explaining how a full preflight (simulate → assemble → sign → submit) differs from an ordinary read-only simulation that is never meant to be submitted, and reporting any preflight failures with clear, actionable guidance.
Compose a multi-contract transaction through an orchestrator invocation:

```bash
npm run run-example 83-multi-contract-transaction
```

Supply a custom orchestrator and downstream contract IDs:

```bash
CONTRACT_ID=<orchestrator-id> CONTRACT_ID_A=<contract-a-id> CONTRACT_ID_B=<contract-b-id> npm run run-example 83-multi-contract-transaction
```

Soroban only allows a single host-function (contract invocation) operation per transaction, so "multiple contract invocations in one transaction" is achieved by invoking one orchestrator/router contract whose method internally makes cross-contract calls into other contracts, rather than by adding several top-level `contract.call(...)` operations. The example builds that single orchestrator invocation with two downstream contract IDs as arguments, simulates it to display the combined resource footprint and authorization entries spanning every contract touched, signs and submits it, and explains why a failure anywhere in the call chain — including a downstream cross-contract call — rolls back the entire transaction atomically, and why execution order follows the orchestrator's own code path rather than the order arguments are listed.

Run the trustline management lifecycle example:

```bash
npm run run-example 93-trustline-management
```

Use a custom asset code:

```bash
npm run run-example -- 93-trustline-management MYTOKEN
```

The example creates two ephemeral Testnet accounts (a holder and a simulated issuer), then walks through the complete trustline lifecycle: creating a trustline for a custom asset with an initial limit, inspecting all trustline details (asset code, issuer, balance, limit, authorization status, and buying/selling liabilities), updating the trust limit, demonstrating invalid asset handling, and finally removing the trustline by setting the limit to zero — recovering the 0.5 XLM reserve subentry cost.

Each non-native Stellar asset requires an explicit opt-in from the receiving account before any payment of that asset can land. The changeTrust operation creates or updates a trustline when `limit > "0"` and removes it when `limit = "0"` (provided the balance is already zero). Each trustline consumes one account subentry, raising the minimum reserve by 0.5 XLM. The asset code can also be supplied through `ASSET_CODE`.

Stream real-time payment events for an account:

```bash
npm run run-example 92-account-payment-stream
```

Monitor a specific account with optional direction filtering:

```bash
npm run run-example -- 92-account-payment-stream <account-id>
ACCOUNT_ID=<account-id> PAYMENT_FILTER=incoming npm run run-example 92-account-payment-stream
```

The example connects to a Horizon server, resolves or discovers an account to monitor, opens a Server-Sent Events stream via `server.payments().forAccount(...).cursor('now').stream(...)`, and displays every new payment record in real time — including the transaction hash, payment type, source and destination accounts, asset information, amount, and timestamp. Each record is labelled as incoming, outgoing, self, or related relative to the monitored account.

The `PAYMENT_FILTER` variable accepts `all` (default), `incoming`, or `outgoing`. Stream errors are logged with a reconnection notice rather than aborting — the SDK reconnects automatically after 15 seconds. Setting `STREAM_MAX_EVENTS` or `STREAM_DURATION_SECONDS` limits the run time, which is useful in CI. Leaving `ACCOUNT_ID` blank makes the example discover a recently active account, so it runs without any setup. Press Ctrl+C to shut down cleanly.

_Note: You can configure custom environment variables in a local `.env` file, including `HORIZON_URL`, `SOROBAN_RPC_URL`, `NETWORK_PASSPHRASE`, and `TRANSACTION_HASH`._

Run the account reserve and spendable balance analysis example:

```bash
npm run run-example 140-account-reserve-analysis
```

Analyse reserves for a specific account:

```bash
npm run run-example -- 140-account-reserve-analysis <account-id>
```

Output as JSON:

```bash
OUTPUT_JSON=true npm run run-example 140-account-reserve-analysis
```

Run the sequence number management example:

```bash
npm run run-example 141-sequence-number-management
```

Run the batch transaction construction example:

```bash
npm run run-example 142-batch-transaction-construction
```

Run in dry-run mode (build and inspect without submitting):

```bash
DRY_RUN=true npm run run-example 142-batch-transaction-construction
```

Run the transaction time bounds example:

```bash
npm run run-example 143-transaction-time-bounds
```

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

## Horizon Market and History Examples 120-123

Monitor a transaction through its Horizon lifecycle:

```bash
npm run run-example 120-transaction-lifecycle-monitor
```

Set `TRANSACTION_HASH`, `POLL_INTERVAL_MS`, `POLL_TIMEOUT_MS`, and `JSON_OUTPUT=true` to configure non-interactive monitoring. If no hash is supplied, the example uses the latest Horizon transaction so it remains directly runnable.

Paginate an account's historical operations:

```bash
npm run run-example 121-account-history-pagination
```

Use `ACCOUNT_ID`, `PAGE_SIZE`, `MAX_RECORDS`, `OPERATION_TYPE`, and `JSON_OUTPUT=true` to configure account-history traversal. The example follows Horizon pagination links, prevents duplicate records, and stops at the requested maximum.

Inspect current order-book depth:

```bash
npm run run-example 122-order-book-inspection
```

Use `SELLING_ASSET`, `BUYING_ASSET`, `ORDER_BOOK_DEPTH`, and `JSON_OUTPUT=true`. Assets use `native`/`XLM` or `CODE:ISSUER`. Without an explicit pair, the example derives a recently traded pair from Horizon.

Analyze historical trades:

```bash
npm run run-example 123-trade-history-analysis
```

Use `SELLING_ASSET`, `BUYING_ASSET`, `TRADE_HISTORY_LIMIT`, `TRADE_FROM_TIME`, `TRADE_TO_TIME`, and `JSON_OUTPUT=true`. Time filters accept ISO-8601 values or Unix timestamps in seconds. Empty markets are reported as a valid zero-trade result.
