# Network Health Monitoring

`319-network-health-monitoring` checks configured Horizon and Soroban RPC endpoints using lightweight read-only requests. It never constructs, signs, or submits a transaction and never mutates network state.

## What it checks

- **Horizon:** `GET /` and validates the root metadata response (`network_passphrase`, Horizon version, protocol version, core version).
- **Soroban RPC:** JSON-RPC `getHealth` with an empty `params` object and validates the result shape.

Each endpoint result contains:

- Name and endpoint kind
- Sanitized endpoint URL (credentials and query parameters removed)
- `healthy`, `degraded`, or `unhealthy` status
- Response time in milliseconds
- Diagnostic message
- Failure kind: `timeout`, `transport`, `http`, `malformed-response`, `rpc-error`, or `null`
- Safe selected details such as network passphrase, versions, or latest ledger

## Configuration

| Option | Environment variable | Default |
| :--- | :--- | :--- |
| `--network testnet\|mainnet` | — | `testnet` |
| `--horizon-url <url>` | `HORIZON_URL` | Network preset |
| `--soroban-rpc-url <url>` | `SOROBAN_RPC_URL` | Network preset |
| `--timeout <ms>` | — | `5000` |
| `--degraded-threshold <ms>` | — | `2000` |
| `--checks <n>` | — | `1` |
| `--interval <ms>` | — | `1000` |
| `--json` | `JSON_OUTPUT=true` | Human-readable output |

Explicit CLI flags take priority over environment variables, which take priority over the selected network preset.

```bash
npx ts-node src/examples/319-network-health-monitoring.ts --network testnet
npx ts-node src/examples/319-network-health-monitoring.ts --network mainnet --json
npx ts-node src/examples/319-network-health-monitoring.ts \
  --horizon-url https://horizon-testnet.stellar.org \
  --soroban-rpc-url https://soroban-testnet.stellar.org \
  --timeout 5000 --degraded-threshold 2000
```

Repeated checks are sequential:

```bash
npx ts-node src/examples/319-network-health-monitoring.ts \
  --checks 3 --interval 5000 --json
```

A later round starts only after the previous round completes. If the process receives `SIGINT`, no further rounds are started.

## Status classification

- **Healthy:** the endpoint returned a valid expected response within the degraded threshold.
- **Degraded:** the endpoint responded validly but was slower than the degraded threshold, or Soroban RPC reported a non-`healthy` status.
- **Unhealthy:** the request timed out, failed at the transport layer, returned a non-2xx HTTP response, returned malformed JSON/shape, or returned a JSON-RPC error.

Overall status is:

- `healthy` when every configured endpoint is healthy
- `degraded` when some endpoints are healthy and others are degraded/unhealthy, or all are degraded
- `unhealthy` when every configured endpoint is unhealthy

One failing endpoint does not prevent the remaining configured checks from completing.

## Sample output

```text
=== Network Health Check ===
Checked at: 2026-11-23T14:25:26.872Z
  Horizon      healthy      412ms  https://horizon-testnet.stellar.org
    Horizon root metadata returned a valid response.
    networkPassphrase: Test SDF Network ; September 2015
    protocolVersion: 30
  Soroban RPC  healthy      985ms  https://soroban-testnet.stellar.org
    Soroban RPC getHealth returned a healthy response.
    rpcStatus: healthy
    latestLedger: 5884057

Overall: healthy (2 healthy, 0 degraded, 0 unhealthy)
Warning: Endpoint availability does not prove ledger finality, transaction success, or complete Stellar network health.
```

## Limitations

- Endpoint availability does not prove ledger finality, transaction success, or complete Stellar network health.
- A single provider or endpoint does not represent the entire Stellar network.
- Provider rate limits may apply. Avoid aggressive polling intervals.
- Health methods are read-only and intentionally minimal; they are not a substitute for ledger monitoring, event streaming, or transaction confirmation checks.
- Custom proxies or gateways may return valid-looking responses; validate that you are monitoring the endpoint you intended to monitor.
