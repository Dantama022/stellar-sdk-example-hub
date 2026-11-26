# #570 — Constant-product liquidity pool trade quote

Read-only, indicative quotes for Stellar's classic constant-product AMM pools. Does **not** build, sign, submit, or promise successful trades.

## Run

From repository root, with its existing dependencies available:

```sh
npx ts-node examples/liquidity-pools/index.ts testnet native 'USD:<ISSUER_G_ACCOUNT>' native 100 100
```

Replace the placeholder with an actual pool issuer on the selected network. Input is `<network> <assetA> <assetB> <inputAsset> <amount> [slippageBps]`. Assets use `native` or `CODE:G-issuer`. `100` slippage basis points means 1%. The Horizon endpoint defaults to the selected network, or call `analyzeSwap` from TypeScript with an explicit `horizon` override. No new dependencies are needed.

The example looks up matching pools via Horizon `GET /liquidity_pools?reserves=assetA,assetB`, validates asset identities with the installed SDK, then uses the fee and reserve amounts returned by Horizon. A missing `fee_bp` is rejected; it is never silently assumed.

## Calculation

Represent all amounts as integer units of 0.0000001 asset. `feeAdjustedInput = floor(input * (10000-fee_bp)/10000)`. Then:

```
estimatedOut = floor(reserveOut * feeAdjustedInput / (reserveIn + feeAdjustedInput))
minimumOut = floor(estimatedOut * (10000-slippageBps) / 10000)
spotPrice = reserveOut / reserveIn (output/input)
executionPrice = estimatedOut / input (output/input)
priceImpactPercent = 100 * (1 - executionPrice / spotPrice)
```

The displayed price impact includes the fee difference from the no-fee spot reference; it is **not** a forecast of future external market prices. Floor rounding is conservative. The liquidity pool may change before execution, and transaction fees and path routing are outside this quote.

## Deterministic example

For equal reserves of 1000 of each asset, a 30-bp fee, 100 units in, and 100-bp tolerance:

```json
{
  "inputAmount": "100.0000000",
  "estimatedOutput": "90.6610893",
  "minimumOutput": "89.7544784",
  "feeBasisPoints": 30,
  "slippageBasisPoints": 100,
  "spotPriceOutputPerInput": "1.0000000"
}
```

This is a calculation fixture, **not** live pool data or guaranteed execution. Test only: `npx jest --runInBand tests/swap-quote.test.ts --coverage=false`.

Sources: [Horizon liquidity pools](https://developers.stellar.org/docs/data/apis/horizon/api-reference/list-liquidity-pools), [Stellar liquidity pools](https://developers.stellar.org/docs/learn/fundamentals/stellar-data-structures/liquidity-pools).
