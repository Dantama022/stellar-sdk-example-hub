# #578 / ISSUE-398 — Stellar Account Reserve Change Impact

Read-only Horizon example. All reserve calculations use `bigint` integer **stroops** (1 XLM = 10,000,000 stroops). No transaction, private key, or network-parameter change is involved.

## Run (from repository root)

Requires the repository's existing Node >=18, `ts-node`, and `@stellar/stellar-sdk` dependencies. No new packages.

```bash
node -r ts-node/register examples/reserve-analysis/reserve-impact-analyzer.ts G_VALID_ACCOUNT_ID testnet 5000000 10000000
```

Arguments: `accountId network currentReserveStroops proposedReserveStroops`. The two figures are **caller-supplied**; the second is **hypothetical**, not approved or forecast. If you use the CLI default for the current reserve, independently verify it against the selected network's configuration before treating the comparison as a current-state analysis. The programmatic API requires a source label for both parameters.

## Calculation

`minimum = (2 + subentry_count + num_sponsoring - num_sponsored) × base_reserve`

`available before liabilities = native balance − minimum`.

`estimated spendable = native balance − minimum − native selling liabilities`.

Each additional signer/offer/ordinary trustline contributes a subentry; pool-share trustlines account for two. Sponsorship counters are **reserve units** provided by Horizon, and must not be added again based on entry listings. The script also queries offers for inspection, but bases the formula on account counters to avoid double counting. Sponsoring contributions are `num_sponsoring × reserve_change`, while sponsored relief is `num_sponsored × reserve_change`.

Example **illustrative arithmetic**, not a live account: with `subentry_count=3`, `num_sponsoring=2`, `num_sponsored=1`, base reserves 0.5 and 1 XLM and XLM balance 2, the requirement changes from 3 to 6 XLM, a +3 XLM difference (+100%); the hypothetical shortfall is 4 XLM.

## Limitations

Horizon account metadata does not fully identify all reserve beneficiaries or complete sponsorship mappings. The analyzer includes the recorded counters and lists partial observed entries; missing sponsorship counts cause an error rather than an invented estimate. The current balance is a snapshot and excludes possible future account activity. Reserve requirements are distinct from liabilities, transaction fees and other transfer constraints.

Docs: https://developers.stellar.org/docs/learn/fundamentals/stellar-data-structures/accounts and https://developers.stellar.org/docs/build/guides/transactions/sponsored-reserves

Example report fields (illustrative):

```json
{
  "minimumBalanceXlm": { "current": "3", "proposed": "6" },
  "deltaXlm": "3",
  "changePercent": 100,
  "additionalXlmNeeded": "4",
  "baseReserve": { "proposedIsHypothetical": true }
}
```
