# ISSUE-005: Add Soroban Event Stream Subscription Example

**EPIC:** 2 — Soroban Examples
**Labels:** `enhancement`, `epic-examples-soroban`
**Difficulty:** medium

## Description

Soroban contracts emit events that off-chain indexers and frontend apps need to consume. We need a script demonstrating how to poll or stream events for a specific contract ID using Soroban RPC's `getEvents` method.

## Tasks

- [ ] Create `src/examples/10-soroban-events.ts`
- [ ] Connect to `rpc.Server` and call `getEvents`
- [ ] Parse topics (symbol, integer, address formats) and data payloads
- [ ] Register script in runner

## Acceptance Criteria

- Running `npm run run-example 10-soroban-events` listens for and decodes contract events
- Displays parsed topics and payloads in console
- Unit tests or mock configs verify parsing utility
