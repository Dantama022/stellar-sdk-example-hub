# Clawback Eligibility and Balance Impact Preflight

A read-only example that checks whether an issuer can claw back an asset from a holder, estimates the
balance impact with integer stroop arithmetic, and can emit an **unsigned** transaction XDR for
inspection.

## What it does

- Loads issuer and holder accounts from Horizon and reports lookup failures separately from
  ineligibility.
- Inspects `AUTH_CLAWBACK_ENABLED`, `AUTH_REVOCABLE`, `AUTH_REQUIRED` and `AUTH_IMMUTABLE`.
- Checks the holder trustline exists and whether it is authorized, unauthorized, or authorized only
  to maintain liabilities.
- Validates code, issuer, holder, amount, balance and protocol version (>= 17) preconditions.
- Estimates the remaining balance as `balance - amount` using `bigint` stroops (7 decimals).
- Builds a clawback operation with the SDK's `Operation.clawback` builder without signing or
  submitting anything.

## Usage

```sh
npx ts-node examples/assets/clawback-preflight.ts \
  --asset USD \
  --issuer GB6ZS324HT6VEEDZ6MG6CESWE7YZSY7WAJDRQSP2GZCRZ5GBND377A2F \
  --holder GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7 \
  --amount 10.5 \
  --horizon https://horizon-testnet.stellar.org \
  --protocol 22 \
  --xdr
```

Add `--json` for a machine-readable report and `--fail-on-ineligible` to set a non-zero exit code.

Programmatic use:

```ts
import { assessClawbackEligibility, loadAccountSnapshot } from './examples/assets/clawback-preflight';
```

## Example output

```text
Clawback preflight report (no transaction submitted)
Asset:           USD (G...)
Holder:          G...
Balance:         25.0000000
Proposed amount: 10.5000000
Remaining:       14.5000000
Clawback flag:   enabled
Trustline:       authorized
Protocol:        22
Eligible:        YES
ADVICE  The issuer must authorize and sign the transaction; this example never signs or submits it.
```

## Tests

```sh
npm test -- --runTestsByPath tests/clawback-preflight.test.ts
```

Tests use mocked accounts and trustlines and never contact a network.

## Limitations

- Trustline authorization alone does not determine eligibility; issuer flags and protocol version
  matter too.
- The XDR preview is a template: the issuer must supply its real sequence number, authorize the
  operation and sign it.
- Reserve, fee and liquidity consequences of the clawback are outside this preflight's scope.
- No secret seed is ever read, logged or required.
