# Stellar Account Merge Readiness Auditor

A **read-only** audit of a Stellar account before a potential account merge.

Merging an account removes it as an independent account and transfers its
native balance to a destination account. The operation is only possible when
the source account satisfies the protocol rules, and getting it wrong can
lock funds or destroy account relationships. This example inspects the
ledger state of an account, explains which conditions appear satisfied, which
require attention and which cannot be verified from the available data.

> The auditor **never** signs and **never** submits a transaction. It does not
> need a secret key. Its result is advisory: a successful audit is a
> preliminary assessment, never a guarantee that a merge transaction will
> succeed.

## What it inspects

| Area | Source | What is reported |
| --- | --- | --- |
| Account state | Horizon `accounts` endpoint | Native balance, sequence number, subentry count, thresholds, flags |
| Trustlines | Horizon account balances | Every non-native trustline and its liabilities |
| Offers | Horizon `offers` endpoint | Open SDEX offers of the account |
| Signers | Horizon account record | Signers other than the master key |
| Data entries | Horizon account record | Names of the data entries |
| Sponsorship | Horizon account record | `sponsor`, `num_sponsoring`, `num_sponsored` |
| Claimable balances | Horizon `claimable_balances` endpoint | Balances the account can claim |

Everything that cannot be retrieved is reported as *missing information*
instead of silently ignored.

## Protocol rules that are applied

1. **No subentries.** The source account of an `AccountMerge` operation must
   not own any subentry. Subentries are trustlines other than the native
   balance line, offers, data entries and signers other than the master key.
   The ledger reports the authoritative number in `subentry_count`.
2. **No sponsorship.** An account that sponsors other entries has to revoke
   the sponsorship before it can be merged.
3. **Claimable balances are not subentries.** A claimable balance does not
   block a merge, but the claim is lost when the claimant account is merged
   away, so it is reported as an item that needs a manual check.
4. **Liabilities.** An account with buying liabilities has committed to pay
   for assets it does not hold yet. This is reported as a potential blocker.
5. **Master key.** The source account has to sign the merge transaction, so
   it needs an active master key with a weight above zero.
6. **Destination capacity.** The destination account is not audited. It has to
   be able to hold the merged balance. This is always reported as a
   limitation.

Not every subentry type is treated the same way, and the report states for
every finding whether it is a *confirmed* fact of the inspected ledger state,
a *potential* blocker or an item that *needs review*.

## Readiness classifications

| Classification | Meaning |
| --- | --- |
| `no_obvious_blockers` | Nothing that blocks a merge was found in the inspected data. |
| `potential_blockers` | At least one confirmed or potential blocker was found. |
| `additional_review_required` | The data is incomplete or a condition needs a manual check. |
| `unable_to_determine` | The required account data could not be retrieved. |

## Usage

```bash
# Console report for a testnet account
node dist/examples/account-merge-readiness/index.js \
  --account GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF \
  --endpoint https://horizon-testnet.stellar.org

# JSON report written to a file
node dist/examples/account-merge-readiness/index.js \
  --account GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF \
  --endpoint https://horizon-testnet.stellar.org \
  --format json \
  --output merge-audit.json
```

### Options

| Option | Description |
| --- | --- |
| `-a, --account <G...>` | Public key of the account to audit (required). |
| `-e, --endpoint <url>` | Horizon endpoint. Defaults to the testnet Horizon. |
| `-l, --limit <n>` | Maximum number of records to inspect per paginated collection. |
| `-o, --output <path>` | Write the report to a file instead of the console. |
| `-f, --format <format>` | `console` (default) or `json`. |
| `-n, --network <name>` | Name of the network that is written into the report. |

The console report and the JSON report contain exactly the same information.

## Reserve and balance implications

* The base reserve is `0.5 XLM` per ledger entry. The account itself always
  costs one base reserve, every entry it owns costs another one.
* The **minimum balance** is `base reserve × (1 + owned entries)`. Entries
  whose reserve is paid by a sponsor are excluded.
* The **available balance** is the observed balance minus the minimum balance.
* A merge removes the source account, so the base reserve of the account
  itself is released. The destination account is expected to receive the
  remaining balance of the source account minus the transaction fee, plus the
  released base reserve.
* Fees, sponsorship changes and every other change of the ledger state
  between the audit and the submission of the transaction are **not** included.
  A balance that was observed during the audit is not guaranteed to be
  unchanged when the merge is submitted.

## Limitations of evaluating merge readiness statically

* The audit inspects one ledger state. Any change between the audit and the
  submission of the transaction can change the outcome.
* The destination account is not part of the audit.
* Ledger entries that Horizon does not expose cannot be taken into account.
* The classification is advisory. Only the network can decide whether a merge
  transaction succeeds.

## Project layout

| File | Responsibility |
| --- | --- |
| `account-inspector.ts` | Retrieves and normalizes the account state. |
| `blocker-analysis.ts` | Turns the account state into findings and a classification. |
| `reserve-analysis.ts` | Calculates the minimum balance, the available balance and the expected destination increase. |
| `report.ts` | Renders the console and the JSON report. |
| `index.ts` | Command line interface. |
| `types.ts` | Shared types. |

## Tests

```bash
npm test -- examples/account-merge-readiness
```

The tests use synthetic fixtures and a fake data source, so no network access
is required.
