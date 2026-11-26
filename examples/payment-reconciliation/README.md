# Issue #574 — Stellar Memo Payment Reference Reconciliation

Read-only payment reference matching example. Memos are public and **never proof of payment by themselves**; do not place secrets, passwords, personal data or sensitive customer information in a memo.

## Run

```sh
npx --no-install ts-node examples/payment-reconciliation/memo-reference-matching.ts <G-ACCOUNT> testnet
```

The CLI uses an empty registry; to see matches, import `analyzeIncomingReferences(accountId, network, registry, maxPages)` and supply the in-memory registry described in `payment-reference-registry.ts`. It supports XLM (`asset: 'XLM'`) and issued assets (`asset: 'CODE:ISSUER'`). Example registry record:

```ts
const reference = {
  id: 'invoice-42', customerOrOrderId: 'order-42', memoType: 'text' as const,
  memo: 'ORDER-42', destination: 'G...destination...',
  asset: 'XLM', amount: '2.5', status: 'unpaid' as const,
};
```

The analyzer retrieves paginated account **payment operations**, filters incoming transfers, then fetches the associated transactions to verify status and decode memos. It supports `none`, `text`, `id` (64-bit decimal), `hash` and `return` (base64-encoded 32-byte values normalized to lowercase hex). A matching memo is not enough: successful transaction/operation, exact destination, asset and amount must also match. It can report exact match, amount/asset mismatch, unknown reference, duplicate, ambiguous match and awaiting verification.

## Example result (synthetic)

```json
{
  "transactionsInspected": 1,
  "counts": {"exact-match": 1, "amount-mismatch": 0, "asset-mismatch": 0, "unknown-reference": 0, "duplicate-payment": 0, "ambiguous-match": 0, "awaiting-verification": 0},
  "outstandingReferences": [], "paginationComplete": true
}
```

Duplicate payment **operation IDs** are ignored for crediting; later successful payments using an already matched reference are flagged. Distinct payment operations may legitimately share a transaction hash, so hash alone cannot establish a duplicate. Real applications must persist processed operation IDs, transaction hashes *with operation indices*, and settled invoice IDs in durable storage; this example's registry and detection are per-run only. Interrupted paging or missing transaction metadata raises an error rather than silently marking orders paid. Quantities compare as integer 7-decimal units, not floating-point values. Available networks: `testnet`/`public`.

References: [Horizon payments](https://developers.stellar.org/docs/data/apis/horizon/api-reference/resources/payments), [Stellar memos](https://developers.stellar.org/docs/learn/fundamentals/transactions/list-of-operations#memo).
