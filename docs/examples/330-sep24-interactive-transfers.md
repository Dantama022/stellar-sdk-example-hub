# ISSUE-330 — SEP-24 interactive deposit/withdrawal

**Mock-first, educational.** Registered as `330-sep24-interactive-transfers` in the example runner. Uses Node 18+ `fetch`, existing TypeScript and installed Stellar SDK; **no additional dependencies**.

```bash
npm run run-example -- 330-sep24-interactive-transfers
```

Mock mode is the default and contacts **no external service**. It calls fake `GET /info`, then `POST /transactions/deposit/interactive` and `/transactions/withdraw/interactive`, validates the `interactive_customer_info_needed` responses, and reads `GET /transaction?id=...`. The account is a public example address; no private key is used. Only the interactive URL's **origin** is printed (not its sensitive query parameters). The application must not open the URL automatically; a wallet UI would validate the HTTPS URL, present the destination and transaction context to the user, then open a browser/webview with user approval. Callback messages require separate validation.

Mock output (abridged):

```text
SEP-24: offline mocked flow
Available deposit assets: USD
Available withdrawal assets: USD
deposit transaction created: demo-deposit UI host: https://mock.anchor.test
Status: pending_user_transfer_start category: pending (not proof of settlement)
withdraw transaction created: demo-withdraw UI host: https://mock.anchor.test
Status: pending_user_transfer_start category: pending (not proof of settlement)
No transaction signed or submitted.
```

## Optional live test environment

A selected anchor must advertise `TRANSFER_SERVER_SEP0024` in `stellar.toml`; inspect its **current** documentation and `/info` response for assets, limits and auth requirements. This example does not obtain SEP-10/45 JWTs: authenticate separately, then set `SEP24_JWT` in your shell without committing it. The HTTPS transfer server URL must be supplied as `SEP24_TRANSFER_SERVER`; a valid wallet account as `SEP24_ACCOUNT`. Set `SEP24_ASSET` to an asset listed under `/info` deposit/withdraw. To enable network requests, set `ANCHOR_MODE=live` and `ANCHOR_ALLOW_REQUESTS=true`. To initiate exactly one flow, additionally set `SEP24_ACTION=deposit` **or** `SEP24_ACTION=withdraw`. Without this action, live mode performs discovery only.

Avoid printing JWTs or full interactive URLs. Real anchors may request additional inputs through their hosted UI or support a distinct interactive host. SEP-24 responses do **not** guarantee funds transfer; statuses like `pending_user_transfer_start` and `pending_anchor` are not terminal. `completed` must be obtained from an authoritative status response. Withdrawal settlement may additionally require a signed Stellar transfer, which this example intentionally does not perform.

Source: [SEP-24 specification](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0024.md); [Stellar SEP-24 integration guide](https://developers.stellar.org/docs/build/apps/example-application-tutorial/anchor-integration/sep24). Existing repository example `21-sep24-deposit-withdrawal` has a separate on-chain testnet workflow; this example does not reuse its signing logic.
