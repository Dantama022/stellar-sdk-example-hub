# #580 / ISSUE-400 — Transaction Operation Source & Fee Attribution

Read-only transaction inspector using Horizon transaction/operation records and `@stellar/stellar-sdk` envelope-XDR decoding. No signing or submission.

## Run

```bash
node -r ts-node/register examples/transaction-attribution/operation-source-attribution.ts 64_CHARACTER_TRANSACTION_HASH testnet
```

Supported network choices: `testnet`, `public`.

## Source rules

The transaction's source signs for its sequence number, but an operation can name its own explicit source. An operation without an explicit source inherits the transaction's **inner** transaction source. Horizon operations can report the effective source, but whether it was **explicit or inherited** requires the transaction envelope. Therefore the example decodes `envelope_xdr` and reports the exact status when possible; otherwise the status is `unverified` (it never guesses explicitness just because addresses differ).

A fee-bump envelope has a distinct **outer** fee-paying source, potentially different from its inner transaction source. Actual `fee_charged` is reported in integer stroops **once**, never repeated as a payment by each operation. In a failed transaction, the recorded operations do not have successful ledger effects even though the fee may be charged.

## Illustrative report excerpt (not live)

```json
{
  "transactionSource": "INNER_SOURCE",
  "feePayingAccount": "OUTER_FEE_SOURCE",
  "feeChargedStroops": "300",
  "feeBump": true,
  "operations": [
    { "index": 0, "type": "payment", "sourceStatus": "inherited" },
    { "index": 1, "type": "change_trust", "sourceStatus": "explicit" }
  ]
}
```

Trading/configuration/sponsorship/contract operations do not automatically imply an asset transfer. Smart-contract balance changes require inspecting additional state; these are flagged rather than guessed. Unknown operations receive warnings. If XDR is missing/cannot be decoded, fee-bump classification and source status are marked uncertain.

Docs: https://developers.stellar.org/docs/data/apis/horizon/api-reference/resources/transactions/object and https://developers.stellar.org/docs/learn/fundamentals/transactions/operations-and-transactions
