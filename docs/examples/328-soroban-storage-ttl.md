# ISSUE-328 — Soroban TTL inspection, extension and restore

**Default:** run the registered `328-soroban-storage-ttl` example. With no `CONTRACT_ID`, it makes no network requests. For read-only inspection:

```powershell
$env:CONTRACT_ID='C...VALID_CONTRACT_ID'
$env:SOROBAN_RPC_URL='https://soroban-testnet.stellar.org'
$env:STELLAR_NETWORK_PASSPHRASE='Test SDF Network ; September 2015'
$env:TTL_THRESHOLD='10000'
```

`inspectEntries` takes **known** ledger keys. The example checks the contract instance key using `Contract.getFootprint()` and `getLedgerEntries` and displays ledger-based `liveUntilLedgerSeq`, not an absolute date. A missing key may be archived, unsupported or simply absent; RPC does **not** enumerate arbitrary contract state. For a WASM contract, obtain a code key from the instance executable's WASM hash; persistent and temporary contract data require schema-aware keys.

`buildTtlTransaction` demonstrates two different operations: `extendFootprintTtl` uses a **read-only** footprint for live entries, while `restoreFootprint` uses a **read-write** footprint for archived persistent entries. Temporary entries cannot be restored after archival. Network TTL limits, the availability of contract code, and resource limits need checking. Use `prepareTtlTransaction` to simulate and calculate Soroban resources and fees. Funded-account preparation and signing must use an account from the chosen network. `submitTtlTransaction` requires explicit opt-in and an authorized signer, and a send response hash is **not** confirmation of execution; poll the result separately.

Expected read-only output:

```text
Soroban TTL read-only inspection: https://soroban-testnet.stellar.org, contract C...
Instance storage: {"state":"expiring-soon","liveUntilLedger":123456,"ledgersRemaining":500}
Extending/restoring needs known keys, simulation, a funded signer, and explicit opt-in. No submission performed.
```

Requires a compatible Soroban RPC endpoint and a valid contract ID for a live read. Tests use mocks. No automatic TTL-changing transactions are submitted.

References: [Stellar state archival guide](https://developers.stellar.org/docs/build/guides/archival/extend-persistent-entry-js), [Soroban RPC](https://stellar.github.io/js-stellar-sdk/reference/network-rpc/).
