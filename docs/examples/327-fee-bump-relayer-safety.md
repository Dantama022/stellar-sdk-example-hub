# ISSUE-327 — Fee-bump relayer safety

Run through the Example Hub runner by selecting `327-fee-bump-relayer-safety`. The example builds a temporary signed **fixture** in memory, then creates an **unsigned** sponsor-paid fee-bump envelope. It does not fund accounts, disclose secrets, sign the outer envelope, or submit anything.

The inner transaction contains operations authorized by the source account(s), with their signatures. The outer fee-bump envelope has a different source (the **fee payer**) and must be signed by that fee payer; the outer signature **does not replace** the inner signatures. A supplied XDR is not proof of the original network since network passphrases are not stored in XDR. The `parseInner` API requires a trusted, external original-network declaration, which a production relayer must authenticate.

Relayer policy checks operation types, destination allowlists, a minimum fee bid, and a maximum total sponsored fee. They are additional guards: production systems must also verify required inner signatures against current account signers/thresholds, base and resource fees, ledger time/sequence preconditions, and transaction state. The SDK computes the outer fee when building the fee-bump; compare its *actual total* with the budget before signing.

Sample output (redacted):

```text
Inner source: G...; fee-paying account: G...
Inner signatures: 1; outer signatures: 0
Sponsored fee (stroops): <computed>; limit: 1000
Prepared an unsigned fee-bump envelope; no real signing or network submission performed.
```

`SponsorshipTracker` is process-local only and does not prevent duplicates across restarts. Use durable idempotency state and on-ledger status checks for real relayers, and never automatically resubmit an uncertain transaction.

References: [Stellar fee-bump guide](https://developers.stellar.org/docs/build/guides/transactions/fee-bump-transactions), [SDK FeeBumpTransaction](https://stellar.github.io/js-stellar-base/FeeBumpTransaction.html).
