# ISSUE-013: Implement Offline Transaction Signer Example

**EPIC:** 1 — SDK Examples
**Labels:** `enhancement`, `epic-examples`
**Difficulty:** medium

## Description

Demonstrate an offline/cold-wallet transaction signature flow. The script should construct an unsigned Transaction envelope XDR, output it, and in a separate execution flow (simulating an offline system), read the XDR, sign it with a keypair, and output the signed Transaction Envelope XDR ready for submission.

## Tasks

- [ ] Create `src/examples/17-offline-signing.ts`
- [ ] Implement phase 1: Build unsigned envelope, export XDR
- [ ] Implement phase 2: Load XDR, sign offline with keypair, export signed XDR
- [ ] Explains security benefits of cold-wallet transaction handling
- [ ] Register script in runner

## Acceptance Criteria

- Runs via runner: `npm run run-example 17-offline-signing`
- Successfully builds, signs, and outputs valid signed XDR matching input properties
