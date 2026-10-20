# ISSUE-336 — SEP-30 Account Recovery Integration

This example demonstrates `POST /accounts/<address>` **registration**, `GET /accounts/<address>` lookup, and `POST /accounts/<address>/sign/<signing-address>` signature requests, not completed recovery. The current SEP-30 specification requires a JWT `Authorization: Bearer ...` header on every endpoint. Registration requires a SEP-10 JWT proving high-threshold account control; lookup permits SEP-10 or service-specific external authentication. The `identities` array contains roles and `auth_methods` with standard type/value pairs. The service responds with an account address, identity information and available signer public keys. Registration alone does not add those signers to the Stellar account, nor authorize a later recovery transaction. Signing requests require service-approved external identity authentication and transaction-envelope XDR; the example uses a mock 64-byte signature response, never a valid recovery authorization.

## Run safely, entirely offline

```bash
npx ts-node src/examples/336-sep30-account-recovery.ts
```

The script **defaults to an injected in-memory mock**, with an example.invalid synthetic identity and test-only public keys, and it never connects to a recovery service. Example output:

```text
SEP-30 account registration acknowledged: G…; recovery signers: 1
Mock recovery-signature response received for network: Test SDF Network ; September 2015
Neither registration nor a returned signature completes recovery.
```

## Explicit live-service integration (optional, not required)

For a separate, reviewed application integration, configure `SEP30_SERVICE_URL=https://your-provider.example`, `SEP30_JWT=<valid SEP-10 JWT>`, and optionally `SEP30_TIMEOUT_MS=5000` through a **local, untracked environment**. Use `liveSettingsFromEnv()` and `new Sep30Client(settings)` in your own client, with verified authorization and identity inputs. The bundled `run()` deliberately always stays mocked. It does not acquire SEP-10 credentials and cannot independently prove legitimate registration; never send its synthetic fixture to a provider.

Validation checks URL transport, account keys, identity schema, returned signer keys, HTTP errors, malformed JSON, timeouts and partial responses. Secrets, JWTs, identity payloads and raw service errors are never logged. A `POST` is not automatically retried. Service policies, thresholds, identities and signer updates are outside this isolated client. Tests inject mock responses; no production service or real identity documents are required.

References: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0030.md ; https://developers.stellar.org/docs/build/apps/wallet/sep30
