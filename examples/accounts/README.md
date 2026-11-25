# Sponsorship Relationship and Reserve Dependency Inspector

A read-only example that inspects account and entry-level sponsorship metadata, distinguishes
sponsoring accounts from sponsored ones, and estimates the reserve obligations associated with
sponsored ledger entries.

## What it does

- Reads account-level fields (`sponsor`, `num_sponsoring`, `num_sponsored`, `subentry_count`,
  optional `sponsorship_counter`) from the selected Horizon endpoint.
- Inspects entry-level sponsorship for account entries, trustlines, signers and data entries where
  the endpoint actually exposes it.
- Resolves sponsor accounts and reports when a sponsor cannot be retrieved.
- Estimates three separate reserve figures with exact stroop arithmetic:
  outgoing responsibility for entries this account sponsors, incoming relief for entries others
  sponsor, and the account's own subentry reserve.
- Reports unresolved dependencies, multiple dependencies, significant obligations, missing metadata
  and endpoint limitations. It never submits a sponsorship operation.

## Usage

```sh
npx ts-node examples/accounts/sponsorship-relationship-inspector.ts \
  --account G... \
  --base-reserve 0.5 \
  --network "Testnet Global Stellar Network ; September 2015" \
  --json
```

`--base-reserve` is a decimal XLM amount; omit it to skip reserve estimation.

Programmatic use:

```ts
import { inspectSponsorship } from './examples/accounts/sponsorship-relationship-inspector';
```

## Example output

```text
Sponsorship relationship report (no operation submitted)
Account:        G...
Account sponsor: <none>
Sponsoring:     2 entries
Sponsored by:   0 entries
Sponsors:       <none resolved>
Sponsored:      G...
ENTRY  trustline USD:G... -> G...
RESERVE base=0.5000000 XLM
RESERVE outgoing=1.0000000 XLM
RESERVE incoming relief=0.0000000 XLM
RESERVE own=0.5000000 XLM
```

## Tests

```sh
npm test -- --runTestsByPath tests/sponsorship-relationship-inspector.test.ts
```

All tests use mocked account records; they never contact a network or modify an account.

## Limitations

- A single account response does not contain a complete sponsorship history.
- Entry categories are not all available from one endpoint; unsupported categories are reported as
  limitations rather than inferred.
- Reserve figures are estimates based on the supplied base reserve and visible entries; they are
  not authoritative ledger-state calculations.
- Missing historical metadata is reported as unresolved, not as evidence of an invalid relationship.
