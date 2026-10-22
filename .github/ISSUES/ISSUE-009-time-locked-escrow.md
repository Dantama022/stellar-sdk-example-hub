# ISSUE-009: Implement Time-Locked Escrow Account Example

**EPIC:** 1 — SDK Examples
**Labels:** `enhancement`, `epic-examples`
**Difficulty:** medium

## Description

A time-locked escrow locks funds until a specified future date. This is implemented using Stellar transaction timebounds. We want a script showing how to build an escrow transaction with timebounds, sign it, save it, and attempt to submit it before and after the locked period.

## Tasks

- [ ] Create `src/examples/14-time-locked-escrow.ts`
- [ ] Construct transaction with `timebounds` options (`minTime` and `maxTime`)
- [ ] Try submitting before the time bound (verify failure)
- [ ] Print clear step guide for resolving time bounds in client scripts
- [ ] Register script in runner

## Acceptance Criteria

- Demonstrates time bounds failure and explains transaction validation
- Runs via `npm run run-example 14-time-locked-escrow`
