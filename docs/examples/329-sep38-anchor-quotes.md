# ISSUE-329 — SEP-38 quotes and indicative pricing

**Default:** the registered `329-sep38-anchor-quotes` example runs with a fake in-memory anchor service. It never exchanges funds or initiates payments. `GET /info` advertises supported assets, `GET /price` supplies an **indicative** value, and `POST /quote` (plus optional `GET /quote/{id}`) provides an authenticated or unauthenticated **firm** quote when the anchor supports that workflow. A firm quote can expire and is not a payment.

For an explicitly configured live test service (which may reserve liquidity when a firm quote is requested), set:

```powershell
$env:SEP38_LIVE='true'
$env:SEP38_URL='https://anchor-test.example/sep38/'
$env:SEP38_TOKEN='<obtained securely and not committed>'
```

The `SEP38_TOKEN` is optional depending on anchor capabilities and SEP-10/SEP-45 authentication. Use a real anchor's published testing documentation. Do **not** turn on live mode without verifying the service's asset pair and quote policy. The example defaults to mock responses. Tests never make network requests.

Assets use `iso4217:USD`, `stellar:native`, or `stellar:CODE:G...` identifiers. The client validates positive **decimal strings**, not JavaScript floating-point calculations. A `GET /price` requires `context`, `sell_asset`, `buy_asset`, and exactly one of `sell_amount` or `buy_amount`. Firm quotes also require checking their `id` and timezone-aware `expires_at` timestamp before use. Fees and net quote arithmetic should remain in exact decimal representations downstream.

Mock output:

```text
Asset info loaded: true
Indicative price: 0.5; firm quote ID: synthetic-quote-1; expiry: <future ISO timestamp>
No exchange, transaction signing, or payment was executed.
```

The service can reject unsupported pairs, respond with HTTP 401 or 429, or omit fields. The client returns sanitized errors and never prints authentication tokens, request bodies or raw provider error text. The mock response is intentionally synthetic and is not a real exchange offer.

References: [SEP-38 specification](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0038.md), [Stellar SEP-38 guide](https://developers.stellar.org/docs/build/apps/wallet/sep38).
