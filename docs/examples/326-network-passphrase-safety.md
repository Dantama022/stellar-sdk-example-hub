# ISSUE-326 — Network passphrase validation and cross-network safety

**Run:** `npm run run-example` → `326-network-passphrase-safety`, or `npx ts-node src/examples/326-network-passphrase-safety.ts` via the registered runner (the module exports `run`). No private key or funded account is used.

**Configuration:** `STELLAR_NETWORK=testnet|public|custom`, `STELLAR_NETWORK_PASSPHRASE`, `HORIZON_URL` and optional `PROBE_HORIZON=true`. Defaults are Stellar testnet and the public Horizon testnet endpoint. For custom networks, supply both a unique exact passphrase and an HTTPS Horizon endpoint. Never guess passphrases from hostnames.

The passphrase is part of the network ID used in transaction signing hashes; a transaction envelope's XDR does **not** record its intended network. Keep the source passphrase in authenticated application context and compare it against the expected network **before** signing or sending. `guardedSign` and `guardedSubmit` accept callbacks so callers can test that a mismatch prevents side effects. Endpoint metadata (Horizon root `network_passphrase`) is an extra consistency check, not independent proof of endpoint trust or TLS identity.

Sample offline output:

```text
Network: testnet; Horizon: https://horizon-testnet.stellar.org
Unsigned transaction prepared; hash: <synthetic hash>
No signing or transaction submission performed.
```

A network mismatch raises `Network passphrase mismatch: signing/submission blocked`; a network probe error is distinguished from a configuration error. The endpoint display excludes paths, credentials and query strings. Never retry against a different network automatically.

References: [Stellar networks](https://developers.stellar.org/docs/networks), [Stellar SDK](https://stellar.github.io/js-stellar-sdk/).
