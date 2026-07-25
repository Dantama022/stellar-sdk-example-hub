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
34. **`37-strict-send-path-payment`**: Executing a strict-send path payment and observing the amount received.
35. **`35-revoke-sponsorship`**: Revoking sponsorship from a sponsored data entry and observing reserve responsibility shift back to the owner.
36. **`38-account-signer-management`**: Managing account signers and weights for multi-party authorization.
37. **`39-account-thresholds`**: Configuring and verifying low, medium, and high account thresholds while restoring the original account configuration.
38. **`41-sponsored-reserve-inspection`**: Inspecting sponsored and sponsoring ledger entries, identifying sponsorship relationships, and calculating reserve impact.
39. **`42-account-sequence-numbers`**: Retrieving, consuming, and correctly managing account sequence numbers across ordered transactions.
40. **`45-horizon-effects`**: Querying Horizon transaction effects, interpreting common effect types, and comparing operation intent to ledger state changes.
41. **`46-transaction-detail-inspection`**: Retrieving a Horizon transaction by hash and inspecting its metadata, result status, memo, envelope, and XDR information.
42. **`47-account-data-entries`**: Creating, reading, updating, and removing account data entries while explaining reserve implications.
43. **`48-asset-authorization-flags`**: Configuring issuer authorization flags and observing trustline authorization and revocation behavior.
44. **`49-claimable-balance-inspection`**: Inspecting claimable balances, claimants, and predicates with claimant-based Horizon filtering.

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
