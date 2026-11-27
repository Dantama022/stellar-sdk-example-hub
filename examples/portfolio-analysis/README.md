# #579 / ISSUE-399 — Trustline Asset Exposure & Portfolio Concentration

Read-only Horizon account balance analysis, with optional **caller-provided** quote-currency prices. No market-price fetching or redemption/liquidity assumptions.

## Run

```bash
node -r ts-node/register examples/portfolio-analysis/account-asset-exposure.ts G_VALID_ACCOUNT_ID testnet '{"XLM":"0.25","USDC:G_VALID_ISSUER_ID":"1.00"}'
```

The third argument is a JSON map of asset IDs to decimal prices per *whole asset unit*, in a common reference currency. Native ID: `XLM`. Issued asset ID: `CODE:ISSUER_PUBLIC_KEY` (the same code with a different issuer is another asset). Pool share ID: `POOL:64_HEX_POOL_ID` and must be valued separately, if at all. Omit prices to see quantities and missing-price warnings. The price source is user supplied, not obtained from Horizon.

## Method and sample

Each asset balance and price is parsed to integer fixed-7 units. Estimated value is `balance_units × price_units / 10^7`. Concentrations are measured **against priced holdings only**. For 10 XLM at 1 quote unit each and 20 tokens at 2 each, the priced subtotal is 50 and allocation is 20% XLM / 80% token. Price-less assets are reported as `missingPrices`; the percent of **total** economic portfolio that is unpriced is unknowable and is `null`, not zero.

Includes issued trustline count, distinct issuer-aware IDs, pool-share count, per-asset and per-issuer percentages, top 3/5 concentration and configurable concentration threshold. Authorization flags are reported only when Horizon provides them. Selling liabilities are separated from balances; the derived availability is only a rough quantity estimate, not guaranteed to be transferable.

## Caveats

Authorization and issuer controls can restrict transfers. Pool shares are not ordinary issued assets. Issuer concentration is **not** a credit or market-risk score. Horizon balances do not provide prices, a liquidity order book, a redemption guarantee, or a reliable net-portfolio valuation for unpriced holdings.

Docs: https://developers.stellar.org/docs/learn/fundamentals/stellar-data-structures/accounts

Example report fields (illustrative, assuming both holdings have supplied prices):

```json
{
  "pricedSubtotal": "50",
  "unpricedAssetCount": 0,
  "unpricedValuePercent": null,
  "largestPricedAsset": "USD:ISSUER_ID",
  "topThreeOfPricedSubtotalPercent": 100
}
```
