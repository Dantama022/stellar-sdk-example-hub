# ISSUE-004: Add Fee-Bump Transaction Example

**EPIC:** 1 — SDK Examples
**Labels:** `enhancement`, `good first issue`, `epic-examples`
**Difficulty:** easy

## Description

Fee-bumps allow one account to sponsor transaction fees for another. This is key for gasless UX in wallets. We need an example showing how to construct a fee-bump transaction wrapping an inner transaction, signing it, and submitting.

## Tasks

- [ ] Create `src/examples/09-fee-bump.ts`
- [ ] Build an inner transaction (e.g. payment) signed by source account
- [ ] Wrap it in `TransactionBuilder.buildFeeBumpTransaction` sponsored by a sponsor account
- [ ] Sign the fee bump with the sponsor key and submit
- [ ] Register in runner

## Acceptance Criteria

- Running `npm run run-example 09-fee-bump` submits the transaction
- Inner account balance remains unchanged (fee is deducted from sponsor account)
- Code annotations explain fee-bump structures
