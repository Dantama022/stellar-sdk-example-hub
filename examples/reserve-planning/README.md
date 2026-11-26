# Issue #577 — Stellar Reserve and Sponsorship Planning

Read-only example; **does not submit transactions or require a secret key**. Requires repository Node >=18 and its existing `@stellar/stellar-sdk` dependency; no additional packages.

## Run

From the repository root, with existing dependencies:

```sh
npx --no-install ts-node examples/reserve-planning/reserve-calculator.ts <G-ACCOUNT> testnet 5000000
```

The final argument is **caller-supplied base reserve in integer stroops** and is *not* fetched from Horizon. Document its verified network source before using the estimates. The CLI models one unsponsored trustline addition; import `analyzeReservePlan()` to configure other scenarios (`add`, `remove`, `start-sponsorship`, `end-sponsorship` for trustlines, signers, offers, and data entries). Network choices: `testnet` or `public`.

## Reference example (synthetic)

Account has 10 XLM, 1 XLM native selling liabilities, 2 existing subentries, 0 sponsoring/0 sponsored reserve units; supplied base reserve 5,000,000 stroops (0.5 XLM). Adding an unsponsored trustline:

```json
{
  "minimumXlm": {"current": "2", "proposed": "2.5"},
  "reserveDifferenceXlm": "0.5",
  "estimatedSpendableXlm": {"current": "7", "proposed": "6.5"}
}
```

The formula is `(2 + subentry_count + num_sponsoring - num_sponsored) * baseReserve`, in stroops. Horizon `num_sponsoring` and `num_sponsored` are **reserve units**, not plain counts of entries. Sponsored entries are included in subentry counts; subtract their units from the owner and add to sponsor once. A sponsored signer/trustline/offer/data entry typically shifts one unit. Other ledger entries (e.g. sponsored accounts, claimable balances) may require **multiple reserve units**; this example intentionally does not model those operation types. Sponsorship operations model **existing** entries only for start/end sponsorship; the caller must verify real ledger ownership and sponsor relationships.

The analyzer fetches account and offer records, inspects trustlines and signers, and fetches proposed sponsor accounts when possible. Offer paging can be incomplete; not all individual sponsorship relationships are verifiable from one account snapshot. Sponsor availability is estimated separately and warnings identify unknown or insufficient sponsor balances. Selling liabilities are subtracted only when estimating available/spendable XLM; they are **not** part of the minimum-balance formula. Fees, authorization, sequence, dynamic ledger conditions, and other account restrictions may prevent real transactions. Never interpret this report as an eligibility guarantee.

Protocol concepts: [Stellar minimum balance](https://github.com/stellar/new-docs/blob/master/content/docs/glossary/minimum-balance.mdx), [sponsored reserves](https://developers.stellar.org/docs/build/guides/transactions/sponsored-reserves).
