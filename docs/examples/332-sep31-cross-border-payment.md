# ISSUE-332 — SEP-31 receiving-anchor cross-border payment API

Educational, mocked sending-anchor flow; does **not** transfer any funds. Registered as `332-sep31-cross-border-payment`.

```bash
npm run run-example -- 332-sep31-cross-border-payment
```

Flow: `GET /info` to inspect `receive` assets, `funding_methods`, amount bounds, `sep12.sender` and `sep12.receiver` types; construct an `asset_code`, `amount`, `funding_method` payment with optional `sender_id` and `receiver_id` from SEP-12; `POST /transactions` receives the ID; `GET /transactions/:id` returns a **wrapped** `{transaction:{id,status}}` result. Extra transaction fields may be required by the receiving anchor; real calls must follow its published documentation. Assets requiring SEP-38 firm quotes are rejected by this simple demo.

The local one-time request ID guard blocks repeated or concurrent submission attempts for the same ID **within this running process**, even if an HTTP request fails ambiguously. It is not a distributed idempotency guarantee: production senders must use durable storage and reconcile unknown outcomes with the receiving anchor rather than blindly retrying.

Sanitized sample output:

```text
SEP-31 receiving assets: USDC
Transaction ID: mock-payment-001 status: pending_sender category: pending
This does not send an on-chain payment or prove off-chain settlement.
```

## Optional live discovery

Use `DIRECT_PAYMENT_SERVER` from the chosen receiving anchor's `stellar.toml` and confirm it actually supports SEP-31, eligible currency, funding method and the specific business relationship with the sending anchor. Configure HTTPS `SEP31_DIRECT_PAYMENT_SERVER`, anchor-issued auth `SEP31_JWT`, optional `SEP31_ASSET` and `SEP31_FUNDING_METHOD`. Enable network requests with `ANCHOR_MODE=live`, `ANCHOR_ALLOW_REQUESTS=true`. Default live behavior is discovery only. `SEP31_ACTION=create` explicitly allows payment-record creation. **Do not** supply real customer IDs until proper SEP-12 registration and the service's authorization requirements are fulfilled. No Stellar transfer is signed or sent by this demo.

Creation means the receiving anchor accepted or is assessing a **record**, not that the customer received funds. `pending_sender` means the sending anchor must still complete a Stellar payment outside this example; `pending_receiver`, `pending_external`, `pending_customer_info_update` and `pending_transaction_info_update` require further work. Only authoritative `completed` confirms completion. Never log customer identifiers, tokens or transaction details.

Sources: [SEP-31 specification](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0031.md), [SEP-12](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0012.md).
