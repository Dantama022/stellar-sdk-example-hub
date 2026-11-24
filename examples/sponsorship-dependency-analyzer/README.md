# Sponsorship Dependency Analyzer (issue #358)

Read-only analysis of Stellar sponsorship relationships for one account.

## What it does

- Validates a `G...` public key and reads Horizon account sponsorship fields
  (`sponsor`, `num_sponsoring`, `num_sponsored`).
- Inspects sponsorship-created effects to discover ledger-entry relationships
  (trustlines, data entries, offers, claimable balances, account entry).
- Builds a directed graph: sponsor → sponsored account. Outgoing edges are
  dependencies created by the inspected account; incoming edges are reserve relief.
- Deduplicates repeated relationships and tracks each edge's data source.
- Marks the graph incomplete whenever account counters or effects pages are
  unavailable. No definitive monetary reserve is calculated.

## Run

```bash
ACCOUNT_ID=G... npm run run-example -- 358-sponsorship-dependency-analyzer
JSON_OUTPUT=true ACCOUNT_ID=G... npm run run-example -- 358-sponsorship-dependency-analyzer
```

`HORIZON_URL` overrides the Testnet Horizon endpoint. No secret keys are needed
and no transactions are submitted.

## Sample output

```text
Inspected account: GAAAA...
Graph exhaustive: yes
Sponsorship edges (2):
  - [incoming] GSPONSOR -> GAAAA... (account; source: horizon-account)
  - [outgoing] GAAAA... -> GOTHER... (trustline; source: horizon-effect)
Reserve units sponsoring: 1
Reserve units sponsored: 1
Definitive reserve: not calculated ...
```

An account with no sponsorship prints `No sponsorship relationships were discovered.`

## Limitations

Account counters are aggregate values, not an inventory of ledger entries.
Horizon effects may be paginated or unavailable, so the graph is not guaranteed
exhaustive. Minimum reserves depend on current network rules and full ledger
state; this report cannot prove an account is safe to merge or modify.

See https://developers.stellar.org/docs/learn/encyclopedia/sponsorship and
https://developers.stellar.org/docs/data/horizon/api-reference.
