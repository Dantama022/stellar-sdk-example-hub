# ISSUE-015: Add Stellar Horizon Event Stream Streamer Example

**EPIC:** 1 — SDK Examples
**Labels:** `enhancement`, `epic-examples`
**Difficulty:** medium

## Description

Horizon allows streaming ledger close events, payments, or operations in real-time using Server-Sent Events (SSE). We need a script illustrating how to use the SDK stream methods to listen to live payments on testnet.

## Tasks

- [ ] Create `src/examples/19-horizon-streaming.ts`
- [ ] Connect to `server.payments().cursor('now').stream(...)`
- [ ] Display incoming payment details in console in real-time
- [ ] Implement clean shutdown logic (close stream on Ctrl+C)
- [ ] Register script in runner

## Acceptance Criteria

- Running `npm run run-example 19-horizon-streaming` connects and prints live testnet payments
- Closes connection cleanly upon receipt of SIGINT
- Provides error recovery and reconnection logs
