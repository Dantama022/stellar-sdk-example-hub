# Transaction Memo and Data Management Examples

This document provides an overview of the Stellar SDK examples related to transaction memos, account data management, fee estimation, and transaction validation.

## Overview

The repository contains comprehensive examples demonstrating:

1. **Transaction Memo Types** - How to attach metadata to transactions
2. **Account Data Entries** - Managing key-value data on accounts
3. **Fee Estimation** - Calculating transaction fees based on network conditions
4. **Transaction Validation** - Pre-flight checks before submission
5. **Fee-Bump Transactions** - Sponsoring transaction fees

## Example Files

### 1. Transaction Memo Handling (`86-transaction-memo-handling.ts`)

Demonstrates all supported Stellar memo types:

- **MEMO_TEXT**: Up to 28 bytes of UTF-8 text
- **MEMO_ID**: Uint64 identifier (common for exchanges)
- **MEMO_HASH**: 32-byte hash value
- **MEMO_RETURN**: 32-byte hash for return/refund scenarios

**Key Functions:**
```typescript
buildMemo(type: string, value: string): Memo
describeMemo(memo: Memo): string
buildTransactionWithMemo(memo: Memo, sourceAccountId: string): string
```

**Use Cases:**
- Associating payments with internal records
- Exchange deposit identification
- Invoice references
- Payment correlation

**Important Notes:**
- Memos are public and permanent on the ledger
- Never store sensitive information (names, emails, secrets)
- MEMO_TEXT is limited to 28 bytes
- Memos do not verify recipient identity

### 2. Account Data Entries (`47-account-data-entries.ts`)

Demonstrates managing custom key-value data on Stellar accounts.

**Operations:**
- Create data entries
- Read existing entries
- Update values
- Remove entries

**Key Functions:**
```typescript
decodeDataValue(base64Value: string): string | null
estimateMinimumBalanceXlm(subentryCount: number): string
getDecodedDataEntry(dataEntries: Record<string, string>, key: string): string | null
```

**Limitations:**
- Key size: Maximum 64 bytes
- Value size: Maximum 64 bytes
- Each entry increases minimum balance by 1 base reserve (0.5 XLM)
- Values are base64 encoded on the network

**Use Cases:**
- Application configuration storage
- Metadata association
- Domain verification data
- Custom account attributes

### 3. Transaction Fee Estimation (`85-transaction-fee-estimation.ts`)

Retrieves network fee statistics and calculates recommended fees.

**Key Functions:**
```typescript
estimateFees(stats, operationCount): FeeEstimate
formatFeeEstimate(estimate: FeeEstimate): string
```

**Fee Levels:**
- **Low (p50)**: May take longer during high load
- **Recommended (p90)**: Good balance of cost and speed
- **High (p99)**: Fast inclusion even under load

**Calculation:**
```
Total Fee = Base Fee per Operation × Operation Count
```

**Use Cases:**
- Dynamic fee selection based on network conditions
- Priority-based fee configuration
- Cost optimization

### 4. Transaction Preflight Validation (`135-transaction-preflight-validation.ts`)

Validates transactions before submission to avoid common errors.

**Validation Checks:**

**Offline (Deterministic):**
- Fee sufficiency (base fee × operation count)
- Signature presence
- XDR structure validity

**Network-Dependent:**
- Source account existence
- Sequence number correctness
- Account balance sufficiency

**Output:**
```typescript
{
  passedChecks: string[],
  warnings: string[],
  errors: string[]
}
```

**Use Cases:**
- Pre-submission validation
- Error prevention
- User feedback before signing
- Transaction debugging

### 5. Fee-Bump Transactions (`09-fee-bump.ts`)

Demonstrates wrapping transactions to have a different account pay the fee.

**Architecture:**
1. Create and sign inner transaction with source account
2. Wrap with fee-bump envelope specifying sponsor account
3. Sign fee-bump with sponsor account
4. Submit composite transaction

**Key Distinction:**
- **Fee-bump**: Changes who pays the transaction fee
- **Sponsorship**: Changes who pays reserve requirements

**Use Cases:**
- Transaction rescue (replacing stuck low-fee transactions)
- Service provider fee payment
- Freemium models
- User onboarding without XLM

## Running the Examples

### Prerequisites
```bash
npm install
```

### Run Individual Examples
```bash
# Transaction memos
npm run dev 86-transaction-memo-handling

# Account data
npm run dev 47-account-data-entries

# Fee estimation
npm run dev 85-transaction-fee-estimation

# Transaction validation
npm run dev 135-transaction-preflight-validation

# Fee-bump
npm run dev 09-fee-bump
```

### Environment Variables
```bash
# Optional: Custom Horizon endpoint
HORIZON_URL=https://horizon-testnet.stellar.org

# Optional: Custom data entry values
DATA_ENTRY_KEY=my_key
DATA_ENTRY_INITIAL=initial_value
DATA_ENTRY_UPDATED=updated_value
```

## Best Practices

### Memos
- Use MEMO_ID for numeric identifiers (exchanges, payment systems)
- Use MEMO_TEXT for human-readable references (short descriptions)
- Use MEMO_HASH for cryptographic proofs or document hashes
- Never include PII or sensitive data
- Document memo format in your API

### Account Data
- Plan for reserve costs (0.5 XLM per entry)
- Use consistent key naming conventions
- Consider entry count limits
- Remove unused entries to reclaim reserves
- Validate data sizes before operations

### Fees
- Query fee stats before building high-value transactions
- Use p90 or p99 during network congestion
- Monitor ledger capacity usage
- Consider fee-bump as a backup strategy
- Test with base fee in development

### Validation
- Always validate before signing
- Check sequence numbers carefully
- Verify source account has sufficient balance
- Consider time bounds for time-sensitive operations
- Handle validation errors gracefully

## Common Patterns

### Payment with Memo
```typescript
const tx = new TransactionBuilder(sourceAccount, {
  fee: BASE_FEE,
  networkPassphrase: Networks.TESTNET,
})
  .addOperation(Operation.payment({
    destination: destinationPublicKey,
    asset: Asset.native(),
    amount: '10',
  }))
  .addMemo(Memo.id('123456'))
  .setTimeout(30)
  .build();
```

### Setting Account Data
```typescript
const tx = new TransactionBuilder(sourceAccount, {
  fee: BASE_FEE,
  networkPassphrase: Networks.TESTNET,
})
  .addOperation(Operation.manageData({
    name: 'config',
    value: 'version=1',
  }))
  .setTimeout(30)
  .build();
```

### Fee-Bump Rescue
```typescript
// Original transaction stuck with low fee
const innerTx = /* existing signed transaction */;

// Wrap with higher fee
const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
  sponsorPublicKey,
  higherFee,
  innerTx,
  Networks.TESTNET,
);
feeBumpTx.sign(sponsorKeypair);
await server.submitTransaction(feeBumpTx);
```

## Related Examples

- `02-payment.ts` - Basic payment transactions
- `14-time-locked-escrow.ts` - Time-bounded transactions
- `16-batched-operations.ts` - Multiple operations in one transaction
- `17-offline-signing.ts` - Building and signing offline
- `46-transaction-detail-inspection.ts` - Inspecting submitted transactions

## Additional Resources

- [Stellar Documentation - Transactions](https://developers.stellar.org/docs/fundamentals-and-concepts/stellar-data-structures/transactions)
- [Stellar Documentation - Operations](https://developers.stellar.org/docs/fundamentals-and-concepts/list-of-operations)
- [Stellar SDK Documentation](https://stellar.github.io/js-stellar-sdk/)
- [Network Fee Guide](https://developers.stellar.org/docs/encyclopedia/fees-resource-limits-metering)

## SDK Version

These examples use:
- `@stellar/stellar-sdk` v13.0.0+
- Node.js 18.0.0+
- TypeScript 5.3+

## Contributing

See [CONTRIBUTING.md](../CONTRIBUTING.md) for guidelines on adding new examples or improving existing ones.

## License

MIT License - See [LICENSE](../LICENSE) for details.
