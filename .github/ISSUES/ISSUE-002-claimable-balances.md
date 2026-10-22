# ISSUE-002: Implement Claimable Balances Example (Create/Claim)

**EPIC:** 1 — SDK Examples
**Labels:** `enhancement`, `epic-examples`
**Difficulty:** medium

## Description

Claimable balances allow sending assets to accounts that might not have trustlines yet. We need a script demonstrating how to:
1. Create a claimable balance with specific claimants and conditions (e.g. absolute time bounds or relative delays).
2. Claim the claimable balance from the claimant's account.

## Tasks

- [ ] Create `src/examples/07-claimable-balances.ts`
- [ ] Add `Operation.createClaimableBalance` operation
- [ ] Add `Operation.claimClaimableBalance` operation
- [ ] Incorporate claimant conditions (`Claimant.predicateBeforeAbsoluteTime` or similar)
- [ ] Verify testnet execution and register in `runner.ts`

## Acceptance Criteria

- Running `npm run run-example 07-claimable-balances` creates and subsequently claims the balance
- Clear console statements track balance creation ID and state changes
