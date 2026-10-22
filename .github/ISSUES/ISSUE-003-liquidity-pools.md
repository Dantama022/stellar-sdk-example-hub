# ISSUE-003: Add Liquidity Pool Deposit/Withdraw Example

**EPIC:** 1 — SDK Examples
**Labels:** `enhancement`, `epic-examples`
**Difficulty:** medium

## Description

Demonstrate interacting with Liquidity Pools (AMM) on Stellar. The script should illustrate depositing assets into a pool, receiving liquidity pool tokens, and subsequently withdrawing assets from the pool.

## Tasks

- [ ] Create `src/examples/08-liquidity-pools.ts`
- [ ] Add trustline for the liquidity pool share asset
- [ ] Implement `Operation.liquidityPoolDeposit`
- [ ] Implement `Operation.liquidityPoolWithdraw`
- [ ] Register script in runner

## Acceptance Criteria

- Executable via runner: `npm run run-example 08-liquidity-pools`
- Successfully completes deposit and withdraw steps on testnet
- Well-commented code explaining AMM parameters (min/max price, slippage)
