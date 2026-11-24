# Stellar Payment Examples

This directory contains payment-related examples for the Stellar SDK Example Hub.

---

## 262 — Muxed Account Address Parsing and Payment Routing

**File:** [`src/examples/262-muxed-account-routing.ts`](../../src/examples/262-muxed-account-routing.ts)
**Tests:** [`tests/muxed-account-routing.test.ts`](../../tests/muxed-account-routing.test.ts)

### What it covers

Muxed accounts let one on-chain Stellar account serve many logical recipients. A muxed
address (M...) encodes a regular G... public key (the *underlying account*) together with a
64-bit *multiplexing ID*. Exchanges and payment services use this to attribute deposits and
withdrawals to individual customers without funding a separate Stellar account for each one.

This example demonstrates:

1. **Address parsing and validation** — accepting both regular (G...) and muxed (M...)
   addresses, detecting invalid or unsupported input, and extracting the underlying account
   ID and multiplexing ID using the SDK's `StrKey` and `MuxedAccount` APIs.

2. **Address inspection** — displaying the original address, underlying account, multiplexing
   ID, and address type in human-readable form.

3. **Payment construction** — building unsigned XLM and issued-asset payment transactions for
   both regular and muxed destinations. The original M... address is passed directly to the
   Payment operation so the multiplexing ID is preserved in the transaction XDR.

4. **Recipient mapping** — a mock lookup table maps multiplexing IDs to internal customer
   records. Unknown IDs and duplicate mappings are detected and produce fatal errors.

5. **Payment safety checks** — destination address, source account, amount, asset format, and
   network passphrase are all validated before any transaction is built.

6. **Routing report** — a structured `RoutingReport` and formatted console output cover every
   field required by the issue: original destination, address type, underlying account ID,
   multiplexing ID, resolved customer, asset, amount, network, validation results, and
   payment construction status.

### Key concepts

| Concept | Description |
|---|---|
| `M...` address | A muxed Stellar address encoding a G... public key + 64-bit multiplexing ID |
| `G...` address | A regular Stellar account public key |
| Multiplexing ID | A 64-bit integer used to route a payment to an internal recipient — **not an authentication credential** |
| Underlying account | The G... public key shared by all muxed addresses on a given account |
| Recipient table | An application-level mapping from multiplexing IDs to internal customer records |

### Important notes

**Preserve the muxed destination.** Never silently replace an M... destination address with
its underlying G... account. Doing so discards the multiplexing ID and may cause the payment
to be attributed to the wrong internal customer. Always use the original M... address as the
Payment operation destination.

**Multiplexing IDs are routing metadata, not credentials.** A correctly formatted muxed ID
does not prove that the presenter is the intended recipient. Authenticate customers through
your application's own auth layer independently of the muxed address.

**Compatibility.** Not every Stellar service, wallet, or third-party integration supports
muxed destinations equally. Confirm that the target Horizon instance and downstream services
accept muxed accounts before deploying to production.

**Trustlines for issued assets.** For non-native asset payments, the destination account must
hold a trustline for that asset. This example assumes the trustline already exists. In
production, verify via Horizon before constructing the transaction.

### Running the example

```bash
# From the workspace root
npm run run-example -- 262-muxed-account-routing
```

### Running the tests

```bash
npm test -- --testPathPattern muxed-account-routing
```

### Exported API

| Export | Description |
|---|---|
| `parseAddress(address)` | Parse a G... or M... address into `AddressInfo` |
| `describeAddressInfo(info)` | Human-readable address summary |
| `resolveRecipient(info, table?)` | Resolve a multiplexing ID to an internal customer |
| `validatePaymentRequest(request)` | Validate a payment request before construction |
| `buildPaymentTransaction(request)` | Build an unsigned payment transaction |
| `buildRoutingReport(request, table?)` | Full routing report combining all steps |
| `formatRoutingReport(report)` | Format a routing report for console output |
| `resolveAsset(assetStr)` | Parse `"native"` or `"CODE:ISSUER"` into an `Asset` |
| `MOCK_RECIPIENT_TABLE` | Sample multiplexing-ID-to-customer mapping |

### Interfaces

```typescript
interface AddressInfo {
  originalAddress: string;   // the address as supplied
  isMuxed: boolean;          // true for M... addresses
  baseAccountId: string;     // underlying G... public key
  muxedId?: string;          // present for muxed addresses only
}

interface CustomerRecord {
  customerId: string;        // internal application reference
  displayName: string;       // human-readable name
}

interface RoutingReport {
  originalDestination: string;
  addressType: 'regular' | 'muxed' | 'invalid';
  baseAccountId: string | null;
  muxedId: string | null;
  resolvedCustomer: CustomerRecord | null;
  asset: string;
  amount: string;
  network: string;
  validationPassed: boolean;
  paymentConstructed: boolean;
  transactionXdr: string | null;
  warnings: string[];
  errors: string[];
}
```
