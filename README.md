# 🎓 Stellar SDK Example Hub

[![CI Status](https://github.com/your-org/stellar-sdk-example-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/your-org/stellar-sdk-example-hub/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A curated repository of runnable TypeScript examples demonstrating key features of the Stellar and Soroban JavaScript/TypeScript SDK (`@stellar/stellar-sdk`).

Designed to help developers build, sign, submit, and troubleshoot operations on the Stellar network.

## Examples Roadmap & Catalog

We organize examples sequentially:

1. **`01-create-account`**: Keypair generation and testnet funding via Friendbot.
2. **`02-payment`**: Building, signing, and submitting simple native XLM payments.
3. **`03-create-trustline`**: Setting up trustlines to receive non-native assets.
4. **`04-multisig`**: Multi-signature setup, changing thresholds, and gathering signatures.
5. **`05-soroban-invoke`**: Simulating and invoking smart contract methods.
6. **`08-liquidity-pools`**: Liquidity pool identification, trustline setup, deposit, and withdrawal.
7. **`11-sponsored-reserves`**: Sponsorship lifecycle with sponsored reserves and verification.
8. **`12-asset-issuance`**: Custom asset issuance and locking the issuer account weight to 0.
9. **`17-offline-signing`**: Building unsigned transaction XDR, signing it offline, and verifying.
10. **`18-soroban-errors`**: Intentionally triggering and parsing Soroban RPC and simulation errors.

## Installation

Ensure you have [Node.js](https://nodejs.org/) (>= 18.0.0) installed.

Clone the repository and install dependencies:

```bash
git clone https://github.com/your-org/stellar-sdk-example-hub.git
cd stellar-sdk-example-hub
npm install
```

## Running Examples

We include a central runner to execute examples interactively.

### Interactive Mode
Run the driver to select and run an example from the list:
```bash
npm run dev
```

### Direct Run
Run a specific example directly by passing its suffix name:
```bash
npm run run-example 01-create-account
```

*Note: You can configure custom environment variables in a local `.env` file (e.g. `HORIZON_URL`, `SOROBAN_RPC_URL`).*

## Automated Example Validation

The repository includes an automated validation framework that discovers runnable examples and validates them in isolated subprocesses.

### Architecture

- Discovery: `src/validation/discovery.ts` recursively finds files under `src/examples` that match the configured file pattern.
- Configuration: `src/validation/validation.config.json` defines discovery rules, timeout behavior, and exclusions.
- Execution: `src/validation/executor.ts` runs each example in its own Node.js process and captures stdout, stderr, duration, and runtime failures.
- Reporting: `src/validation/reporter.ts` builds a reusable summary object and renders CI-friendly report output.
- Entrypoint: `src/validate-examples.ts` is the CLI command used locally and in GitHub Actions.

### Run Locally

Run validation with CI-safe exclusions applied:

```bash
npm run validate:examples
```

Run all discovered examples (including excluded ones):

```bash
npm run validate:examples:all
```

Target specific examples:

```bash
npm run validate:examples -- --only 01-create-account,02-payment
```

Use a custom config file:

```bash
npm run validate:examples -- --config path/to/validation.config.json
```

### Exclusion Mechanism

Examples that require external credentials, user interaction, or unavailable services can be excluded via config:

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

`match` supports `*` wildcard patterns and is evaluated against the example name (without `.ts`).

### CI Integration

The CI workflow runs `npm run validate:examples` on every push and pull request. The step fails automatically when validation reports one or more failed examples.

### Adding New Examples

When you add a new file in `src/examples` that matches the configured file pattern, it is discovered automatically by the validation framework.

- If it can run in CI, no extra validation registration is required.
- If it cannot run in CI, add an exclusion rule in `src/validation/validation.config.json` with a clear reason.

## Contributing

We love contributions! Want to add a claimable balances, liquidity pool, or event streaming example? Read [CONTRIBUTING.md](./CONTRIBUTING.md) to see how to contribute new examples.

## License

This project is licensed under the MIT License - see the [LICENSE](./LICENSE) file for details.
