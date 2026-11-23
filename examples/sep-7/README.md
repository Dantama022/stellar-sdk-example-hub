# SEP-7 URI Security Inspector

[`src/examples/262-sep7-uri-security-inspector.ts`](../../src/examples/262-sep7-uri-security-inspector.ts) inspects a [SEP-7](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0007.md) `web+stellar:` request before a wallet acts on it. It parses the URI, validates the `pay` or `tx` request, decodes transaction XDR with `@stellar/stellar-sdk`, checks the network and callback, and reports every finding with a severity.

It is an inspector only: it **never signs, never submits, never fetches the origin domain's `stellar.toml` and never opens the callback URL**.

## Setup and run

```bash
npm install
# Built-in demo request (Public network payment)
npm run run-example 262-sep7-uri-security-inspector
# Your own URI; quote it so the shell keeps the & characters
SEP7_URI='web+stellar:pay?destination=G...&amount=10' npm run run-example 262-sep7-uri-security-inspector
# Testnet wallet, JSON output
NETWORK_PASSPHRASE='Test SDF Network ; September 2015' JSON=1 SEP7_URI='web+stellar:tx?xdr=...' \
  npx ts-node src/examples/262-sep7-uri-security-inspector.ts
npm test -- tests/sep7-uri-security-inspector.test.ts
```

`NETWORK_PASSPHRASE` is the network the wallet is configured for. It defaults to the Public network, which is also SEP-7's default when a URI has no `network_passphrase`.

## What is checked

| Area | Checks |
|---|---|
| Parsing | `web+stellar:` scheme via the WHATWG URL parser; each value decoded once; malformed percent-encoding, duplicate keys and unknown parameters reported; a literal `+` (decoded as a space) flagged |
| `pay` | `destination` present and a valid `G...`/`M...` account; `asset_code` (1-12 alphanumerics) with a valid `asset_issuer`; `amount` positive, at most 7 decimals, within int64; `memo`/`memo_type` (text ≤ 28 bytes, ID ≤ uint64, hash/return 32 bytes base64) |
| `tx` | `xdr` present and decodable (including fee-bump envelopes); source, fee, time bounds and operation types; operations outside an allow-list, and account-control operations (`setOptions`, `accountMerge`, trustline flags, clawback, sponsorship revocation) as high severity; `pubkey` vs source; `replace` and `chain` noted |
| Network | `network_passphrase` (or the Public default) compared with the wallet's network |
| Callback | `url:` prefix, absolute URL, `https:` only, no embedded credentials; the destination host is reported so the user can decide whether to trust it |
| Origin | `origin_domain` without `signature` is high severity; a present signature is reported as **unverified** |

Status is `invalid` if any finding is high severity, `valid-with-warnings` if any is medium, otherwise `valid`.

## Sample output

A Public-network wallet inspecting a Testnet request that adds a signer:

```text
SEP-7 URI inspection: INVALID
  URI:         web+stellar:tx?xdr=AAAAAgAAAADQSrIy...&network_passphrase=Test%20SDF%20Network%20%3B%20September%202015&origin_domain=example.com&signature=REDACTED
  Operation:   tx
  Parsed:      true
  Network:     Test SDF Network ; September 2015 (MISMATCH)
  XDR:         decoded
  Source:      GDIEVMRSOQV3JKZ2CNUL2RQV4TTNAISKW4NAC25PQUQKGMWJO6DTOAE7
  Fee:         100 stroops
  Operations:  setOptions
  Signature:   present-unverified
  Findings:
    [HIGH] network-mismatch: Request targets "Test SDF Network ; September 2015" but the wallet expects "Public Global Stellar Network ; September 2015"
    [INFO] signature-unverified: Signature not verified: needs the origin domain's URI_REQUEST_SIGNING_KEY
    [HIGH] unexpected-operation: setOptions can change account control or asset authorization
  Nothing was signed, submitted or fetched.
```

## Redaction

Reports never contain the request `signature`, callback credentials or query strings, or the full transaction XDR (only its first 16 characters).

## Limitations

- **Signatures are not verified.** That needs the origin domain's `URI_REQUEST_SIGNING_KEY` from its `stellar.toml`, which this example deliberately does not fetch.
- A syntactically valid request is not a trustworthy one: the inspector cannot know whether the destination, asset issuer or callback host is the one the user intends to pay.
- Transaction XDR does not record its network; the network check relies on the URI's `network_passphrase`.
- `replace` (SEP-11 Txrep field substitution) and nested `chain` requests are reported but not applied or inspected.
- Operation allow-lists and the fee threshold are policy choices; adjust `allowedOperations` and `maxFeeStroops` for your wallet.
