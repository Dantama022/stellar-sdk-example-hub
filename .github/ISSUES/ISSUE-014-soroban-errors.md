# ISSUE-014: Parse and Format Soroban RPC Errors

**EPIC:** 2 — Soroban Examples
**Labels:** `enhancement`, `good first issue`, `epic-examples-soroban`
**Difficulty:** easy

## Description

Soroban contract failures return complex XDR errors. Developers need a utility script showing how to parse Soroban simulation errors and decode `errorResultXdr` fields to diagnose contract panic, unauthorized callers, or invalid storage keys.

## Tasks

- [ ] Create `src/examples/18-soroban-errors.ts`
- [ ] Construct a failing contract call (e.g. invalid arguments)
- [ ] Catch error, extract XDR details, and parse using `xdr.TransactionResult` or `xdr.ScVal`
- [ ] Format and display error messages in console
- [ ] Register script in runner

## Acceptance Criteria

- Executable via runner: `npm run run-example 18-soroban-errors`
- Displays parsed human-readable Soroban error details (error code, category) instead of raw XDR dump
