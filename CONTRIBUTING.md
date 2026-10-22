# Contributing to Stellar SDK Example Hub

We welcome developer contributions to expand our catalog of runnable Stellar examples.

## How to Add a New Example

To submit a new example, follow these steps:

1. **Create the Script**: Add a new TypeScript file under `src/examples/` naming it with the sequence format (e.g. `src/examples/06-claimable-balances.ts`).
2. **Implement the Contract/Logic**:
   - The file must export a default async function or a `run()` function.
   - Include robust inline commentary explaining each step (building, signing, submitting, and response structure).
3. **Register the Example**: Add the file to the index catalog inside `src/runner.ts` so it shows up in the CLI menu.
4. **Document it**: Add a short description of the new script in the `README.md` catalog section.
5. **Verify**: Run the script locally to confirm it successfully runs on Testnet.

## Development Setup

### Code Quality
Ensure formatting and type checks pass:
- Format code: `npm run format`
- Lint code: `npm run lint`
- Run Jest tests: `npm test`
- Run TypeScript checks: `npm run typecheck`

Make sure all tests pass before submitting your Pull Request!
