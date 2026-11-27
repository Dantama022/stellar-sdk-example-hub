# SEP-1 `stellar.toml` Validator

A read-only example that retrieves a domain's `/.well-known/stellar.toml`, parses it with the
maintained [`toml`](https://www.npmjs.com/package/toml) parser, validates the SEP-1 metadata, and
prints a report with `error`, `warning`, and `info` severities.

## What it checks

- Successful retrieval, response status, content type, and rejection of HTML/XML error pages.
- TOML syntax errors reported as actionable parse errors.
- Required `SIGNING_KEY` and expected `NETWORK_PASSPHRASE`, with optional expected-network matching.
- `ACCOUNTS`, `CURRENCIES`, `DOCUMENTATION`, and `PRINCIPALS` when present; optional fields are never
  treated as mandatory.
- Duplicate/invalid asset declarations and missing asset issuers (native or non-issued assets are
  not assumed to be issued Stellar assets).
- URL syntax, unexpected schemes, plain HTTP, and embedded credentials for published service
  endpoints.

The example does **not** automatically call published endpoints. Endpoint probing is opt-in via
`--check-endpoints`, uses `HEAD` requests with a short timeout, and is disabled in tests. No secrets
are read or printed, and no transaction is built, signed, or submitted.

## Usage

```sh
npx ts-node examples/sep-1/stellar-toml-validator.ts --domain example.org
npx ts-node examples/sep-1/stellar-toml-validator.ts \
  --domain example.org \
  --expected-network "Public Global Stellar Network ; September 2015" \
  --json
```

Use `--fail-on-error` to set a non-zero exit code when the report contains an error.

Programmatic use:

```ts
import { auditStellarToml, formatReport } from './examples/sep-1/stellar-toml-validator';

const report = await auditStellarToml('example.org', {
  expectedNetworkPassphrase: 'Testnet Global Stellar Network ; September 2015',
});
console.log(formatReport(report));
```

## Example output

```text
SEP-1 stellar.toml validation report
Domain:      example.org
URL:         https://example.org/.well-known/stellar.toml
Retrieved:   yes (HTTP 200)
Parsed:      yes
Network:     declared=Testnet ... expected=<none> consistent=unknown
Findings:    0 error(s), 0 warning(s), 2 info
Overall:     PASS
```

## Tests

```sh
npm test -- --runTestsByPath tests/stellar-toml-validator.test.ts
```

Tests use the deterministic fixtures in `fixtures/` and a mocked fetcher; they never contact a live
domain.

## Limitations

- Structural validation is not a trust judgment: a document can validate while still being wrong or
  malicious. Verify the signing key out of band before relying on it.
- Only fields defined by SEP-1 and common service endpoints are inspected. Custom fields are
  ignored.
- Content type validation is advisory: some hosts serve valid TOML as `text/plain`.
- Endpoint probing reports only the HTTP status. It does not validate endpoint semantics.
