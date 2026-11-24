# Soroban Token Balance & Allowance Inspection

A **read-only** example that reads a token holder's balance and, optionally, the allowance
they granted to a spender, from any Soroban token contract. Raw amounts are kept as exact
`bigint` values and formatted using the token's decimals.

Nothing is signed or submitted. The example never calls `transfer`, `transfer_from`,
`approve`, `mint`, `burn`, or any other state-changing method.

## How Soroban tokens expose balances and allowances

Soroban tokens follow the token interface described in
[SEP-41](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0041.md) and the
[Stellar token interface docs](https://developers.stellar.org/docs/tokens/token-interface).
The read-only methods used here are:

| Method | Signature | Purpose |
| --- | --- | --- |
| `balance` | `balance(id: Address) -> i128` | Tokens held by `id` |
| `allowance` | `allowance(from: Address, spender: Address) -> i128` | Amount `spender` may still spend from `from` |
| `decimals` | `decimals() -> u32` | Number of fractional digits |

(`name` and `symbol` also exist but aren't needed here.) Stellar Asset Contracts (SACs,
the Soroban wrapper around classic assets) implement this interface in the host. Custom
Wasm tokens implement it themselves, and **not every contract does**, so this example checks
before assuming.

### How the calls are made

`simulateTransaction` on the Soroban RPC runs a contract call against current ledger state and
returns the result without applying it. We build an unsigned transaction with
`Contract.call(...)` from a throwaway source account (simulation doesn't require it to exist; only
a public key is generated, no secret is created or stored) and read `result.retval`.

### Detecting the interface

1. The contract instance is fetched. No instance means `CONTRACT_NOT_FOUND`.
2. SACs are known to implement the interface.
3. For Wasm contracts, the `contractspecv0` custom section of the Wasm is parsed to list
   exported functions (name and argument count). A missing `balance` stops the run with
   `UNSUPPORTED_INTERFACE`; a missing `allowance` marks the allowance `unsupported`.
4. If the spec can't be read, a warning is added and support is learned by invoking: the host's
   "non-existent contract function" error is mapped to `METHOD_NOT_FOUND`.

## Raw vs. formatted amounts, and why decimals matter

On-chain amounts are integers in the token's smallest unit. The contract doesn't store `1.5`; it
stores `15000000` and a separate `decimals` value of `7`. So:

```
formatted = raw / 10^decimals     15000000 / 10^7 = 1.5
```

- **Raw** is the source of truth. It's returned as `bigint` and printed as a decimal string.
  `i128` values can have 39 digits; a JS `number` is only exact up to 2^53 − 1, so converting
  would silently corrupt large balances. This example never does.
- **Formatted** is for display. It's computed with string/bigint math, so it is exact too.
- Decimals vary per token (SACs use 7, many tokens use 6 or 18). Formatting with the wrong
  value is off by orders of magnitude. Decimals are read from the contract by default, or
  supplied with `--decimals` (an explicit value wins). If neither works, the result keeps the
  exact raw amount, leaves `formatted` unset, and adds a warning.

## Balance vs. allowance

- **Balance**: what an address *holds*.
- **Allowance**: what another address is *permitted to spend on the owner's behalf*
  (granted with `approve`). It does not move tokens and can be larger than the balance.

An allowance of zero (`status: "ok"`, `raw: 0`) is a real answer: nothing is approved (or the
approval expired, since `allowance` reports `0` for an expired approval). It is
reported differently from:

- `status: "unsupported"`: the contract has no `allowance` method.
- `status: "failed"`: the call errored or returned something unexpected.

In both of those cases `amount` is absent. The *owner* in this example is the inspected account.

## Running against Testnet

Requires Node.js 18+.

```bash
cd examples/soroban/token-inspection
npm install
npm test            # mocked, offline
npm run typecheck

# <TOKEN_CONTRACT> is a C... token contract on Testnet, <ACCOUNT> a G... or C... address
npx ts-node index.ts <TOKEN_CONTRACT> <ACCOUNT>
npx ts-node index.ts <TOKEN_CONTRACT> <ACCOUNT> --spender <SPENDER>
npx ts-node index.ts <TOKEN_CONTRACT> <ACCOUNT> --decimals 7
```

| Option | Default | Notes |
| --- | --- | --- |
| `--network testnet\|mainnet` | `testnet` | Verified against the RPC's passphrase; a mismatch is an error |
| `--rpc-url URL` | public SDF Testnet RPC | Also `SOROBAN_RPC_URL`. Use your own provider for mainnet |
| `--spender ADDRESS` | none | Enables allowance inspection |
| `--decimals N` | read from contract | Integer 0–38 |

To get a Testnet token, deploy the [Stellar Asset Contract](https://developers.stellar.org/docs/tokens/stellar-asset-contract)
for any Testnet asset (`stellar contract asset deploy --asset CODE:ISSUER --network testnet`) and use the
resulting contract ID. No secret keys are needed or accepted by this example.

Exit codes: `0` ok or partial, `1` error, `2` bad CLI usage.

### Example output

```json
{
  "status": "ok",
  "network": "testnet",
  "networkPassphrase": "Test SDF Network ; September 2015",
  "tokenContract": "C...",
  "account": "G...",
  "balance": { "raw": "15000000", "formatted": "1.5" },
  "decimals": 7,
  "decimalsSource": "contract",
  "allowance": {
    "owner": "G...",
    "spender": "G...",
    "status": "ok",
    "amount": { "raw": "0", "formatted": "0" }
  },
  "interface": { "source": "stellar_asset", "methods": { "balance": true, "allowance": true, "decimals": true } },
  "warnings": []
}
```

`status` is `ok`, `partial` (balance retrieved, but decimals or allowance unavailable), or `error`
(with `error.code`/`error.message`).

## Error codes

`INVALID_CONTRACT_ADDRESS`, `INVALID_ACCOUNT_ADDRESS`, `INVALID_SPENDER_ADDRESS`,
`NETWORK_MISMATCH`, `RPC_UNAVAILABLE`, `CONTRACT_NOT_FOUND`, `UNSUPPORTED_INTERFACE`,
`METHOD_NOT_FOUND` (per-method; surfaces as `unsupported` allowance), `INVOCATION_FAILED`,
`UNEXPECTED_RETURN_TYPE` (including negative amounts), `INVALID_DECIMALS`, `FORMAT_ERROR`.

## Read-only scope

Included (all via simulation): `balance`, `allowance`, `decimals`, plus ledger reads for the
contract instance and Wasm.

Intentionally excluded: `approve`, `transfer`, `transfer_from`, `burn`, `burn_from`, `mint`,
and anything else that changes balances or allowances. There is no signing, no
`sendTransaction`, and no secret-key handling.

Limitations: muxed (`M...`) addresses aren't accepted; `allowance` doesn't return the approval's
expiration ledger (the standard interface doesn't expose it); contracts with archived state will fail
to simulate with a message to restore first (this example doesn't restore).

## Layout

| File | Responsibility |
| --- | --- |
| `config.ts` | Networks, address validation |
| `invoke.ts` | RPC client, read-only simulation |
| `spec.ts` | Wasm contract-spec parsing |
| `balance.ts` / `allowance.ts` | The token calls |
| `decode.ts` | ScVal → `bigint` / `number` |
| `format.ts` | Decimals validation and amount formatting |
| `inspector.ts` | Orchestration and result assembly |
| `token-inspection.test.ts` | Offline tests with a mocked RPC client |
