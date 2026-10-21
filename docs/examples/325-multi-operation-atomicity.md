# ISSUE-325 — Classic Stellar multi-operation transactions

Run: `npm run run-example -- 325-multi-operation-atomicity` after using the repository's existing dependencies. This demo uses deterministic **public-only** fixture accounts, builds but does not sign or submit anything, and needs no network or funded account.

The classic transaction consists of (1) a `changeTrust` by the receiver for an issued asset, followed by (2) a `payment` from the asset issuer to the receiver, explicitly specifying the issuer as operation source. The issuer **and** the transaction-source receiver must sign before real submission. The receiver must already be an activated Stellar account with enough XLM for the trustline reserve and fees, and the issuer must be configured to issue this asset. Asset authorization settings may require additional authorization. Reversing operation order fails when the receiver does not have a trustline. Invalid amounts, codes, addresses, operation counts and bounds are rejected locally.

An atomic transaction applies all **operation effects** together on success and none of them on failed execution. **Fees and source account sequence effects may still occur on failures**; a failed transaction is not a free no-op. Do not automatically resend: inspect Horizon result codes and current account state first. Stellar classic transactions have a maximum of 100 operations and pay a base fee per operation. This example does not simulate Soroban resource usage.

The `submitTestnetOnly` function illustrates signing, submission and final results but is never invoked by the runner. It requires an explicit `enabled: true`, `ALLOW_TESTNET_MULTI_OP_SUBMIT=true`, and testnet-only credentials supplied outside source control. Do not put secrets in files or logs. It sends a transaction **only once** and does not retry. It is not a production payment system.

Example output:

```json
{"operations":["changeTrust","payment"],"atomic":true,"signed":false,"submitted":false}
```

References: [Stellar operations and transactions](https://developers.stellar.org/docs/learn/fundamentals/transactions/operations-and-transactions), [SDK TransactionBuilder](https://stellar.github.io/js-stellar-sdk/TransactionBuilder.html).
