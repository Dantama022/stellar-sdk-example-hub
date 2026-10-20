# ISSUE-335 — SEP-7 URI Generation and Validation

This standalone TypeScript example uses `web+stellar:pay?…` and `web+stellar:tx?…` to create/parse payment and transaction-signing **requests**. It performs no signing or submission. `pay` requires `destination` and can specify `amount`, matched `asset_code`/`asset_issuer`, text `memo` plus `memo_type=MEMO_TEXT`, `msg` and `network_passphrase`. `tx` requires base64-encoded `TransactionEnvelope` `xdr`; optional `callback=url:https://...`, `pubkey`, and `network_passphrase` are accepted. The demo intentionally **rejects** unimplemented `replace`, `chain`, signature verification and arbitrary extension parameters rather than treating them as authenticated. Other standard memo types are outside this teaching subset.

Run from the root after the project's normal dependency installation:

```bash
npx ts-node src/examples/335-sep7-uri.ts
```

Example (sanitized; full XDR omitted):

```text
Pay URI: web+stellar:pay?destination=G…&amount=1.25&memo=Example+order+42&memo_type=MEMO_TEXT&network_passphrase=Test+SDF+Network+%3B+September+2015
Parsed pay request: {"operation":"pay","destination":"G…","amount":"1.25","memo":"Example order 42"}
Unsigned signing-request URI: web+stellar:tx?xdr=AAAA…
Parsed transaction operation: tx
```

URI fields are percent-encoded using `URLSearchParams`, not manually concatenated. The parser rejects unsupported operations, duplicate parameters, missing required values, malformed percent-encoding, invalid addresses and invalid XDR. Syntax validation does not confer trust: wallets must independently show the destination, amount, asset, network, operation details and any callbacks before user approval. A callback can receive signed XDR and therefore must be reviewed. Never auto-open or auto-sign arbitrary external URIs; do not log sensitive transaction data. The sample XDR is unsigned, synthetic, testnet-only, and built entirely offline with an unfunded deterministic public account.

References: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0007.md ; https://developers.stellar.org/docs/build/apps/wallet/sep7
