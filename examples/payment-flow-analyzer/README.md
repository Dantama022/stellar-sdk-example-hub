# Multi-account payment-flow relationship analyzer (#490)

Read-only **observed-ledger** relationship analyzer; not a transaction-history browser or real-world identity/intent classifier.

## Run (from repository root)

Uses existing `ts-node`, `@stellar/stellar-sdk` and Node 18+ `fetch` (no new dependencies):

```bash
npx ts-node examples/payment-flow-analyzer/index.ts --accounts=ACCOUNT_G1,ACCOUNT_G2 --network=testnet --from-ledger=100000 --to-ledger=101000 --max-pages=5
npx ts-node examples/payment-flow-analyzer/index.ts --accounts=ACCOUNT_G1,ACCOUNT_G2 --network=testnet --from-time=2026-01-01T00:00:00Z --to-time=2026-01-02T00:00:00Z --json
```

Optional `--horizon=https://your-horizon.example` overrides the network's default Horizon endpoint. A bounded ledger **or** time range is required. At most 20 accounts and 1000 pages per account. A max-page cutoff is labelled incomplete, never silently treated as all history. Each page uses `GET /accounts/:id/operations?order=asc&limit=200&cursor=...`, and incomplete operation metadata is supplemented by `GET /transactions/:hash` (cached, limited parallel lookups). Failed requests after an initial page become explicit incomplete-history warnings.

## Sample report (shortened, fictional data)

```json
{
  "network": "testnet",
  "accounts": ["G_ACCOUNT_A", "G_ACCOUNT_B"],
  "inspectedOperations": 2,
  "relationships": [
    { "operationId": "123", "transactionHash": "hash-1", "kind": "direct", "from": "G_ACCOUNT_A", "to": "G_ACCOUNT_B", "sentAsset": "XLM", "sentAmount": "5.0000000", "receivedAsset": "XLM", "receivedAmount": "5.0000000" },
    { "operationId": "124", "transactionHash": "hash-2", "kind": "path", "from": "G_ACCOUNT_B", "to": "G_ACCOUNT_A", "sentAsset": "XLM", "sentAmount": "3.0000000", "receivedAsset": "USD:G_ISSUER", "receivedAmount": "2.0000000" }
  ],
  "accountsSummary": { "G_ACCOUNT_A": { "incoming": { "USD:G_ISSUER": "2.0000000" }, "outgoing": { "XLM": "5.0000000" } } },
  "pagination": { "complete": true, "pages": 2 }
}
```

## Semantics and limitations

- Edges come only from confirmed `payment`, `create_account` and `path_payment_strict_send` / `path_payment_strict_receive` operation records. `create_account` is marked funding, not an ordinary payment. Path payments preserve separate sent and received asset/amount; intermediate offer matches are **not** modelled as independent end-user transfers.
- Transactions group by hash; multiple operations in one transaction remain separate auditable ledger operations, **not** evidence of multiple customer payments. Duplicated operations seen through two account histories are counted once by operation ID.
- Asset totals are 7-decimal strings calculated with BigInt; USD from two issuers is kept separate. No prices or exchange rates are inferred. Failed transactions are excluded from balance-changing relationships.
- Account/operation listing can be truncated by history retention, filtering, or `maxPages`; the report has `pagination.complete` and warnings. It is a graph over **selected accounts and retrieved records**, not proof no other transactions exist. `fromLedger`/`toLedger` includes bounds; when the ledger number cannot be retrieved the operation is excluded with a warning.
- Stellar account addresses are **not** person identities, relationship edges do not imply intent or real-world affiliations, and aggregate counts are observations, not claims of ownership.

Official: [Horizon operation objects](https://developers.stellar.org/docs/data/apis/horizon/api-reference/resources/operations/object), [Horizon pagination](https://developers.stellar.org/docs/data/apis/horizon/api-reference/structure/pagination/page-arguments).
