# Issue #576 — Stellar Account ManageData Validator

Pure local validation plus optional **read-only** Horizon account inspection; no transactions or keys.

## Run

From repository root, with dependencies already installed:

```sh
npx --no-install ts-node examples/account-data/data-entry-inspector.ts <G-ACCOUNT> example.key example-value testnet
```

The CLI treats an omitted value as removal. For programmatic use, call `validateDataInput(key, value)` or `validateAccountData({accountId, key, value}, 'testnet', baseReserveStroops)`. A string value is UTF-8; `{ encoding: 'base64', data: '...' }`, `{ encoding: 'hex', data: '...' }`, and `Uint8Array` are supported. `undefined` means **remove**; `''` is a valid empty value. Invalid hex, base64, and unpaired Unicode surrogates are rejected rather than silently converted.

Stellar ManageData names and values are limited to **64 encoded bytes each**, not 64 JavaScript characters. Both are checked independently. Example: `'é'.repeat(32)` is 64 UTF-8 bytes; `'é'.repeat(33)` exceeds the maximum. See [Stellar Manage Data operation](https://developers.stellar.org/docs/data/apis/horizon/api-reference/resources/operations/object/manage-data).

## Example local report (illustrative)

```json
{
  "key": "example.key", "operation": "create", "existingKey": false,
  "encodedKeyBytes": 11, "encodedValueBytes": 5,
  "localValid": true,
  "warnings": ["Network transaction fee and authorization checks are separate; local validation does not guarantee success."]
}
```

`account.data` maps keys to base64-encoded data values. Creation, update and removal are inferred from that snapshot; a missing data map is reported as unknown. The base reserve must be caller supplied and verified; creation potentially adds one reserve unit, while modifications generally do not, but sponsorship and ledger state can alter outcomes. Fees and liabilities are evaluated separately. A successful local check **does not mean the network will accept the operation**.
