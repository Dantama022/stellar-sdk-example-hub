# ISSUE-011: Implement Batching Operations in a Single Transaction

**EPIC:** 1 — SDK Examples
**Labels:** `enhancement`, `good first issue`, `epic-examples`
**Difficulty:** easy

## Description

Stellar allows bundling up to 100 discrete operations inside a single transaction envelope. This guarantees atomic execution (all operations succeed or all fail). We need an example script illustrating batching multiple operations (e.g. multiple payment transfers) in one transaction builder.

## Tasks

- [ ] Create `src/examples/16-batched-operations.ts`
- [ ] Add multiple `Operation.payment` calls to a single `TransactionBuilder` instance
- [ ] Sign and submit transaction
- [ ] Register script in runner

## Acceptance Criteria

- Running `npm run run-example 16-batched-operations` executes batched operations atomically
- Logs display list of payments executed in the single ledger transaction
