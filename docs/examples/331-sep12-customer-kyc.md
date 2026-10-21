# ISSUE-331 — SEP-12 customer information / KYC status

Mock-first TypeScript demo, no real PII or ID scans. Registered as `331-sep12-customer-kyc`.

```bash
npm run run-example -- 331-sep12-customer-kyc
```

Mock mode runs `GET /customer?type=individual` and discovers a `NEEDS_INFO` response with required field definitions. It validates a **fictional** `Demo Example` with `demo@example.invalid`, then sends `PUT /customer` with JSON. The returned `{id}` identifies the anchor's record, **not an accepted KYC outcome**. A subsequent `GET /customer?id=...&type=...` is the authoritative status check; this demo exposes `getCustomer` for it. Valid statuses include `NEEDS_INFO`, `PROCESSING`, `ACCEPTED`, and `REJECTED` (some fields may additionally be `VERIFICATION_REQUIRED`). Unsupported statuses cause explicit validation errors. Missing requirements, authentication failures, malformed JSON and timeouts are surfaced without printing request bodies or response secrets.

Sample output:

```text
SEP-12 status: NEEDS_INFO required field names: [ 'first_name', 'last_name', 'email_address' ]
Synthetic record ID: synthetic-customer-001 (submission does not imply verification approval)
Verification status: PROCESSING
```

## Optional live discovery

Find `KYC_SERVER` or fallback `TRANSFER_SERVER` in the selected anchor's `stellar.toml`, obtain an authorized **SEP-10 or SEP-45** token according to that anchor, and configure `SEP12_KYC_SERVER` (HTTPS), `SEP12_JWT`, and `SEP12_CUSTOMER_TYPE`. Enable `ANCHOR_MODE=live` and `ANCHOR_ALLOW_REQUESTS=true`. The provided `run` function performs **live discovery only** — it will never send even fictional personal data to a real KYC provider. For real customer workflows, a separate authenticated application must handle lawful collection, consent, storage limits, conditional fields, and any binary upload via the specification's file API.

SEP-12 is used alongside SEP-6, SEP-24 and SEP-31, but a customer ID may not transfer across anchors. `PUT /customer` responds with an ID; `GET /customer` provides the actual verification status. Do not log tokens, KYC documents, or full error payloads.

Sources: [SEP-12 specification](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0012.md), [Stellar SEP-12 API documentation](https://developers.stellar.org/docs/platforms/anchor-platform/api-reference/callbacks/get-customer).
