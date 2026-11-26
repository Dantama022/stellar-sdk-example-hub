# Issue #575 — Stellar Account Balance Movement Attribution

Read-only Horizon example. It does **not** reconstruct a complete historical ledger balance from account snapshots or submit transactions.

## Run

```sh
npx --no-install ts-node examples/balance-analysis/account-balance-attribution.ts <G-ACCOUNT> testnet
```

For a custom ledger range and max pages, import `analyzeAccountBalances(accountId, 'testnet', {fromLedger: 100, toLedger: 200, maxPages: 5})`. Page cap and completeness status are always reported. It fetches account balances plus paginated account operations and transactions, then correlates them by transaction hash. History prior to Horizon's retention cutoff may not exist; this is **not a complete snapshot-to-snapshot audit**.

## Supported categorization

- Native/issued payments: positive incoming and outgoing transfers for the specified account.
- Path payments: separate *source asset/source amount* from *destination asset/received amount*.
- Create account: starting XLM balance as transfer.
- Claimable balance creation and clawback: direct change where amount and asset are reported.
- Liquidity pool deposit/withdraw: reserve movements and pool share changes only when operation metadata provides both.
- Manage offers/trades, trustlines, sponsorship, account merges, claiming claimable balances, and unsupported types: **flagged** for effects/ledger analysis, not guessed.
- Transaction fees: summed separately for the known fee-paying account in integer stroops. An unresolved fee-bump payer must not be inferred from the inner source.

## Reference case (synthetic)

Incoming 1.2345678 XLM, outgoing 0.25 XLM, 200 stroops of fees charged to the account:

```json
{
  "byAsset": [{"asset":"XLM","incoming":"1.2345678","outgoing":"0.25","net":"0.9845678"}],
  "transactionFeesXlm": "0.00002", "openingBalances": null,
  "historicalBalanceReconstructionComplete": false
}
```

All asset quantities use integer units (7 decimal places). Amounts, reserve obligations, selling liabilities, fees and actual trade fills are different things. This example deliberately avoids double counting and marks any unverified attribution as requiring further analysis. Fees can still be charged for failed transactions. Network support: `testnet` and `public`. No additional dependency changes.

References: [Horizon operations](https://developers.stellar.org/docs/data/apis/horizon/api-reference/resources/operations), [Horizon accounts](https://developers.stellar.org/docs/data/apis/horizon/api-reference/resources/accounts).
