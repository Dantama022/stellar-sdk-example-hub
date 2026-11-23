# Orderbook spread and market-depth analyzer (#569)

Read-only observation of Stellar DEX liquidity, without transaction signing or offer placement.

## Run

```bash
npx ts-node examples/orderbook-depth-analyzer/index.ts --network=testnet --selling=native --buying=USD:VALID_G_ISSUER --limit=50 --price-limits=0.2,0.5,1.0
npx ts-node examples/orderbook-depth-analyzer/index.ts --network=testnet --selling=native --buying=USD:VALID_G_ISSUER --json
```

Use `native` or `XLM` for native and `CODE:G_ISSUER` for issued assets. Identical base and counter assets are rejected. Optional `--horizon=https://your-horizon.example`; `limit` 1..200. Uses Horizon `GET /order_book` with `selling_asset_*` (base) and `buying_asset_*` (counter) parameters. The observed timestamp is recorded.

## Key unit detail

Horizon `price_r` is **counter asset per base asset**. Horizon's orderbook `amount` for **both bids and asks** is denominated in the **counter asset**, per the documented response. All reported `counterAmount`, cumulative depth and `depthAtPrices` are therefore in the counter asset, NOT base-asset units. The approximate base equivalent is `counter amount / price`; values rounded to 7 decimals with BigInt arithmetic. Prices are calculated from the exact `price_r` numerator/denominator and displayed to 7 decimals. Distinct rational price levels are grouped by exact fraction, even if their displayed rounded prices look equal.

- `bestBid`: highest bid; `bestAsk`: lowest ask.
- `spreadAbsolute`: bestAsk - bestBid (counter per base).
- `spreadPercent`: `100 * (bestAsk - bestBid) / midpoint`, displayed to 4 decimals.
- `midpoint`: `(bestAsk + bestBid) / 2`, where both sides exist.
- Cumulative depth is a sum of counter-asset amounts. For `--price-limits`, bids count levels **at or above** the threshold and asks count levels **at or below** the threshold. Duplicate prices are aggregated, gaps between consecutive levels are reported.

## Sample report (fictional)

```json
{
  "selling": "XLM", "buying": "USD:G_ISSUER",
  "bestBid": "2.0000000", "bestAsk": "2.5000000",
  "spreadAbsolute": "0.5000000", "spreadPercent": "22.2222", "midpoint": "2.2500000",
  "bids": { "levels": [{ "price": "2.0000000", "counterAmount": "5.0000000", "cumulativeCounterAmount": "5.0000000", "offerCount": 2 }] },
  "warnings": []
}
```

For empty or one-sided books, missing prices and the spread are **null**. Network errors and malformed response prices are not silently replaced. Displayed offers are **not** guaranteed executable liquidity: book state and partial fills can change before an order executes. This is not investment advice.

Official: [Retrieve orderbook](https://developers.stellar.org/docs/data/apis/horizon/api-reference/retrieve-an-order-book), [Orderbook response and amount units](https://developers.stellar.org/docs/data/apis/horizon/api-reference/aggregations/order-books/object).
