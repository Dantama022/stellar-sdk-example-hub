# ISSUE-008: Add Soroban Smart Contract Deployment Example

**EPIC:** 2 — Soroban Examples
**Labels:** `enhancement`, `epic-examples-soroban`
**Difficulty:** hard

## Description

Demonstrate programmatically uploading contract Wasm bytes and deploying a contract instance using the JavaScript SDK. This is essential for CI/CD pipeline automation and advanced testing frameworks.

## Tasks

- [ ] Create `src/examples/13-soroban-deploy.ts`
- [ ] Load a sample precompiled contract `.wasm` file
- [ ] Construct upload operation: `Operation.uploadContractWasm`
- [ ] Construct instantiate operation: `Operation.createContract`
- [ ] Handle transaction simulation, resource assembly, and submission
- [ ] Print resulting Contract ID
- [ ] Register script in runner

## Acceptance Criteria

- Code reads WASM file bytes, uploads, instantiates, and logs the Contract ID
- Interactive execution via `npm run run-example 13-soroban-deploy`
