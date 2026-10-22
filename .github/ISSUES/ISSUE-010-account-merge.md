# ISSUE-010: Implement Account Merge Operation Example

**EPIC:** 1 — SDK Examples
**Labels:** `enhancement`, `good first issue`, `epic-examples`
**Difficulty:** easy

## Description

The `accountMerge` operation deletes a Stellar account and transfers its entire remaining native XLM balance to a destination account. We need an example script illustrating this operation.

## Tasks

- [ ] Create `src/examples/15-account-merge.ts`
- [ ] Initialize and fund a temporary account
- [ ] Build transaction containing `Operation.accountMerge` from temporary account to destination
- [ ] Submit transaction and verify temporary account no longer exists (404 on Horizon lookup)
- [ ] Register script in runner

## Acceptance Criteria

- Running `npm run run-example 15-account-merge` successfully merges the account
- Explains the reserve refund mechanism and warnings about merging accounts with active trustlines
