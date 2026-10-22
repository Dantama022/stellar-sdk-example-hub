# ISSUE-012: Add Interactive CLI Prompts in Example Runner

**EPIC:** 3 — Runner Improvements
**Labels:** `enhancement`, `epic-runner`
**Difficulty:** medium

## Description

The central runner `src/runner.ts` currently prints lists of options but does not prompt interactively. We want to implement an interactive prompt flow using `inquirer` so that running `npm run dev` displays a selectable list of examples to execute.

## Tasks

- [ ] Add `inquirer` to dependencies
- [ ] Implement interactive choice selection menu in `src/runner.ts`
- [ ] Ask for parameters dynamically if an example requires custom overrides
- [ ] Render clear summaries of scripts selected

## Acceptance Criteria

- Running `npm run dev` (without arguments) triggers the interactive choice prompt
- Selecting an item triggers its execution correctly
- Exit choice terminates process cleanly
