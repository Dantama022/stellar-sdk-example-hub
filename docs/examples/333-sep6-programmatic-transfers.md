# ISSUE-333 — SEP-6 programmatic deposits and withdrawals

**Default mode is fully mocked.** Registered as `333-sep6-programmatic-transfers`, with no new dependencies or network transfer.

```bash
npm run run-example -- 333-sep6-programmatic-transfers
```

SEP-6 exposes `GET /info`, `GET /deposit`, `GET /withdraw` and `GET /transaction?id=...`. In contrast to SEP-24, the anchor does not require launching an interactive webview for the primary flow. A wallet must use info-derived asset support, funding methods and field requirements before initiating the transfer. This example uses a deterministic synthetic Stellar public account, a fictional asset and a mocked funding method. `GET /deposit` and `/withdraw` may initiate server-side transactions despite using HTTP GET — the in-process local request ID guard prevents a second attempt, but **does not** implement durable cross-process idempotency.

Example output:

```text
SEP-6 deposit assets: USD
SEP-6 withdrawal assets: USD
deposit request accepted. Tracking ID: mock-sep6-deposit
Status: pending_user_transfer_start category: pending
withdraw request accepted. Tracking ID: mock-sep6-withdraw
Status: pending_user_transfer_start category: pending
No Stellar transaction created or submitted; no settlement guaranteed.
```

An anchor may return instructions without a transaction ID. This is **not** a decoding failure: the example reports that status must be discovered via authenticated `/transactions` history or a known memo. It never invents an identifier. `pending_user_transfer_start`, `pending_customer_info_update` and `pending_stellar` do not mean settlement. Handle completion only after authoritative `completed`. Avoid automatically retrying a failed request, since the anchor may already have created it.

## Optional live discovery

Find `TRANSFER_SERVER` from the chosen anchor's `stellar.toml`; configure HTTPS `SEP6_TRANSFER_SERVER`, optional authenticated `SEP6_JWT` (SEP-10/45), `SEP6_ACCOUNT`, `SEP6_ASSET`, and `SEP6_FUNDING_METHOD`. Confirm capabilities with `/info` first and ensure the required trustline/customer SEP-12 profile exists. `ANCHOR_MODE=live` plus `ANCHOR_ALLOW_REQUESTS=true` enables network access; default live behavior only fetches `/info`. Set exactly `SEP6_ACTION=deposit` or `SEP6_ACTION=withdraw` for intentional initiation. The example does not handle bank instructions, identity documents, actual bank transfers or Stellar payments.

Sources: [SEP-6 specification](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0006.md), [Stellar SEP-6 wallet guide](https://developers.stellar.org/docs/build/apps/wallet/sep6).
