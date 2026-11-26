# Liquidity pool reserve exposure analyzer (#491)

Read-only inspection of a constant-product Stellar pool and, optionally, the proportional reserve exposure of a selected account's pool shares. No keys, trades or transactions.

## Run

```bash
npx ts-node examples/liquidity-pool-exposure-analyzer/index.ts --pool=64_HEX_POOL_ID --network=testnet
npx ts-node examples/liquidity-pool-exposure-analyzer/index.ts --pool=64_HEX_POOL_ID --account=PUBLIC_G_ACCOUNT --network=testnet --json
```

Optional `--horizon=https://your-horizon.example`. `GET /liquidity_pools/:id` provides `reserves`, `total_shares`, last-modified metadata; `GET /accounts/:id` supplies an account's `balances[]` with `asset_type: liquidity_pool_shares`, matching `liquidity_pool_id` and `balance`.

## Formula

`ownership fraction = account pool-share balance / pool.total_shares`

`estimated underlying exposure = pool reserve amount * ownership fraction`

All amounts are parsed to integer units of 10^-7 (BigInt) and results rounded to 7 decimal places. `total_shares` is a quantity in the same units as the share balance. Empty/missing or zero supply makes an account exposure **inconclusive**. An account with no pool-share trustline has zero pool shares, when account balances were successfully retrieved.

## Sample output (fictional)

```json
{
  "poolId": "...64 hex chars...", "network": "testnet", "reserves": [
    { "asset": "native", "amount": "100.0000000" },
    { "asset": "USD:G_ISSUER", "amount": "50.0000000" }
  ], "totalShares": "10.0000000", "accountShares": "2.5000000",
  "ownershipPercent": "25.000000", "estimatedExposure": [
    { "asset": "native", "amount": "25.0000000" },
    { "asset": "USD:G_ISSUER", "amount": "12.5000000" }
  ], "complete": true, "warnings": []
}
```

## Warnings and limitations

- An exposure estimate is **not** an immediate withdrawal quote: fees, rounding, minimum amounts, changes in reserves/supply and ledger timing affect actual results.
- Pool and account requests are not atomic. `observedAt`, `lastModifiedLedger` and `lastModifiedTime` help communicate freshness. Missing account or pool data is not silently substituted.
- Pool share position does **not** establish market value, redeemability or asset liquidity. Analysis is not investment advice.

Official: [Retrieve liquidity pool](https://developers.stellar.org/docs/data/apis/horizon/api-reference/retrieve-a-liquidity-pool), [Horizon accounts](https://developers.stellar.org/docs/data/apis/horizon/api-reference/resources/accounts).
