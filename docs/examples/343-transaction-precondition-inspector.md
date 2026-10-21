# ISSUE-343 — Transaction preconditions and time-bound safety

Run: `npm run run-example -- 343-transaction-precondition-inspector`. No private key, network request, or transaction submission is required. The demo builds a deterministic unsigned classic transaction and reads its envelope back using `TransactionBuilder.fromXDR`.

Preconditions can be absent, contain legacy time bounds, or use V2 with **time bounds, ledger bounds, min source sequence, minimum sequence age, minimum sequence ledger gap and extra signers**. All checks are independent from transaction fees. Time bounds are inclusive at their upper timestamp (`maxTime=0` means no upper expiry); ledger upper bounds are **exclusive** (`maxLedger=0` means no upper bound). Fixed clock injection avoids flaky tests and makes UTC epoch assumptions explicit.

Use `inspectXdr(envelope, Networks.TESTNET)` and `validatePreconditions(view,{nowSeconds:1100n,requireExpiry:true})`. Missing or reversed bounds, expired transactions and ledger-bound violations produce actionable errors. Account-sequence, age, ledger gap and signer checks may require **fresh network state**, so local checks never guarantee acceptance. The simplified inspector rejects fee-bump envelopes as unsupported rather than silently treating their inner transaction as validated. No signing or submission occurs. If a real application chooses to submit, it must re-check state and obtain explicit authorization.

Representative output:

```json
{"locallyValid":true,"errors":[],"submitted":false,"networkChecksRemaining":["account sequence","ledger close time","signatures and balances"]}
```

References: [Transactions and preconditions](https://developers.stellar.org/docs/learn/fundamentals/transactions/operations-and-transactions), [CAP-21](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0021.md), [SDK transaction builder](https://stellar.github.io/js-stellar-sdk/TransactionBuilder.html).
