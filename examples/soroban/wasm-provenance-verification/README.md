# Soroban WASM reproducible build and artifact provenance verification

Check that a Soroban contract WASM file is the one you meant to use: record how it was built, hash it, compare it with a **trusted** expected checksum, and optionally confirm a deployed contract runs byte-identical code. No private keys, secrets or live-network credentials are needed, and nothing is deployed.

This is different from the repo's `wasm-provenance` analyzer, which reads producer metadata from inside a WASM file. This example verifies a *build*.

## Workflow

1. **Record provenance** in `provenance.json` (see `provenance.example.json`): source repository and full commit, contract path, `rustc` and build-tool versions, target, build command, artifact path, expected SHA-256.
2. **Build** from that commit with the documented toolchain (optional: `--build`).
3. **Hash** the artifact with SHA-256 (streamed, standard `node:crypto`).
4. **Compare** with the expected checksum. A mismatch or a missing artifact fails with a clear message.
5. **Compare with the deployed contract** (optional): read the contract's executable hash from the network and compare.

## Three identifiers that are not interchangeable

| Identifier | What it is |
|---|---|
| Local artifact checksum | SHA-256 of a `.wasm` file on your disk |
| Deployed executable hash | SHA-256 of the WASM a deployed instance runs, stored in its instance ledger entry |
| Contract address (`C...`) | The identity of a deployed instance; says nothing about which code runs |

A match between the first two means the deployed instance runs byte-identical WASM to your file. Looking it up: build the instance ledger key with `new Contract(id).getFootprint()`, read it with `getLedgerEntries`, and read `executable().wasmHash()` from the `ScContractInstance`. Stellar Asset Contracts run built-in code with no uploaded WASM, so there is nothing to compare (`not-comparable`).

## Setup

```bash
cd examples/soroban/wasm-provenance-verification
npm install
npm run typecheck
npm test
```

Requires Node 18+. A real build needs the Rust toolchain and the Stellar CLI; the tests use a scripted command runner and a mocked RPC, so they need neither. Uses `@stellar/stellar-sdk` 13.x.

## Usage

```bash
# Verify a local artifact against the expected checksum
npx ts-node src/verify.ts --metadata provenance.json

# Take the expected checksum from a trusted place instead of the metadata file
npx ts-node src/verify.ts --metadata provenance.json --expected-sha256 <hex from the signed release>

# Build first (allow-listed commands only), then verify
npx ts-node src/verify.ts --metadata provenance.json --build

# Also confirm what a deployed contract is running
npx ts-node src/verify.ts --metadata provenance.json \
  --contract-id CABC... --rpc-url https://soroban-testnet.stellar.org

# Machine-readable report
npx ts-node src/verify.ts --metadata provenance.json --json
```

Exit codes: **0** verified, **1** verification failed (checksum or deployed mismatch), **2** could not verify (bad usage or metadata, missing artifact, build failure, or an inconclusive deployed comparison).

Example summary:

```
Source revision:   recorded a1b2..., working tree a1b2...
Toolchain:         rustc 1.84.0 / stellar 22.1.0 / wasm32v1-none
  installed:       rustc 1.84.0 / stellar 22.1.0
Local checksum:    93a4...9476
Expected checksum: 93a4...9476
Integrity:         MATCH
Deployed compare:  match
Result:            VERIFIED
```

## What the result does and does not mean

- **Integrity is not authenticity.** A match proves byte-level equality with the checksum you supplied. It does not prove the source is safe or that the code was reviewed.
- **The expected checksum must come from a trusted source**: a reviewed release, a signed build record, or an independent rebuild. A checksum stored beside an untrusted artifact proves nothing, because whoever replaced the artifact can replace the checksum. Prefer `--expected-sha256` from outside the artifact's directory.
- **Reproducibility is fragile.** Compiler version, dependency resolution (`Cargo.lock`), build flags, target and environment can all change the output. The report compares installed `rustc` and build-tool versions with the recorded ones and warns on differences; a different toolchain may legitimately produce different bytes. Update `provenance.json` when you intentionally change the toolchain, and commit `Cargo.lock`.
- The source revision check reads `git rev-parse HEAD` and warns when it differs from the recorded commit or the tree has uncommitted changes.

## Safety

The build command in the metadata is data from a file, so it is not executed blindly: only documented Soroban builds (`stellar contract build ...`, `soroban contract build ...`, `cargo build --target wasm32... --release ...`) are allowed, and they run without a shell. Metadata containing credential-looking fields is rejected.

## Files

| File | Responsibility |
|---|---|
| `src/provenance.ts` | Metadata type and validation |
| `src/toolchain.ts` | Installed tool versions, source revision, injectable command runner |
| `src/hash.ts` | SHA-256 of files and buffers |
| `src/build.ts` | Allow-listed build step |
| `src/deployed.ts` | Deployed executable lookup and comparison |
| `src/verify.ts` | Verification, report and CLI |
