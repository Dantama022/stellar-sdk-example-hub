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
6. **`12-asset-issuance`**: Custom asset issuance and locking the issuer account weight to 0.
7. **`17-offline-signing`**: Building unsigned transaction XDR, signing it offline, and verifying.
8. **`18-soroban-errors`**: Intentionally triggering and parsing Soroban RPC and simulation errors.

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

## Contributing

We love contributions! Want to add a claimable balances, liquidity pool, or event streaming example? Read [CONTRIBUTING.md](./CONTRIBUTING.md) to see how to contribute new examples.

## License

This project is licensed under the MIT License - see the [LICENSE](./LICENSE) file for details.
