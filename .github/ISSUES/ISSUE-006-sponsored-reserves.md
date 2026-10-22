# ISSUE-006: Implement Sponsored Account Creation (Sponsorship logic)

**EPIC:** 1 — SDK Examples
**Labels:** `enhancement`, `epic-examples`
**Difficulty:** medium

## Description

Stellar supports "sponsoring" the reserve requirement of another account (minimum balance). This is useful for user onboarding. We need an example script demonstrating:
1. `beginSponsoringFutureReserves`
2. Creating the account (or establishing trustlines/data entries)
3. `endSponsoringFutureReserves`

## Tasks

- [ ] Create `src/examples/11-sponsored-reserves.ts`
- [ ] Incorporate reserve sponsorship operations
- [ ] Submit transaction and verify signer thresholds/reserves
- [ ] Register script in runner

## Acceptance Criteria

- Running `npm run run-example 11-sponsored-reserves` completes the sponsorship flow on testnet
- Comments explain requirements, limitations, and signing rules
