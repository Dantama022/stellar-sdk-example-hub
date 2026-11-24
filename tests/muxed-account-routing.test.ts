/**
 * Tests for Example 262: Stellar Muxed Account Address Parsing and Payment Routing
 *
 * All addresses are deterministic and statically derived.
 * No network requests are made; transactions are built locally and never submitted.
 */

import { Account, MuxedAccount, Networks } from '@stellar/stellar-sdk';

import {
  parseAddress,
  describeAddressInfo,
  resolveRecipient,
  validatePaymentRequest,
  buildPaymentTransaction,
  buildRoutingReport,
  formatRoutingReport,
  MOCK_RECIPIENT_TABLE,
  resolveAsset,
  type CustomerRecord,
  type PaymentRequest,
} from '../src/examples/262-muxed-account-routing';

// ---------------------------------------------------------------------------
// Deterministic test fixtures
// ---------------------------------------------------------------------------

// Deterministic test keypairs (public keys only — no secrets)
const BASE_ACCOUNT = 'GCN7PAR5MAAUHMVV5GGUFVH6LOZWWISGHUVG4TEFEI46PP4NCZCRFZYF';
const SOURCE_ACCOUNT = 'GAEHGI5A4VZ3RAANJNLPOYHWHX4NMDU6COVQWOLX5VPTSDMQDKBDRHYT';
const ISSUER = 'GDVQQGHC4DC7FXNDS4S3E7KXR3EEOF7X4ZYGH7O45SYAM2S2TR2N4JPK';

// Build deterministic muxed addresses from BASE_ACCOUNT
const baseAcc = new Account(BASE_ACCOUNT, '0');
const MUXED_ID_1001 = new MuxedAccount(baseAcc, '1001').accountId(); // registered
const MUXED_ID_1002 = new MuxedAccount(baseAcc, '1002').accountId(); // registered
const MUXED_ID_5555 = new MuxedAccount(baseAcc, '5555').accountId(); // NOT registered
const MUXED_ID_MAX = new MuxedAccount(baseAcc, '18446744073709551615').accountId(); // u64 max

// ---------------------------------------------------------------------------
// 1. parseAddress — regular G... account
// ---------------------------------------------------------------------------

describe('parseAddress — regular account', () => {
  it('parses a valid G... address', () => {
    const info = parseAddress(BASE_ACCOUNT);
    expect(info.originalAddress).toBe(BASE_ACCOUNT);
    expect(info.isMuxed).toBe(false);
    expect(info.baseAccountId).toBe(BASE_ACCOUNT);
    expect(info.muxedId).toBeUndefined();
  });

  it('baseAccountId equals the original address for a regular account', () => {
    const info = parseAddress(BASE_ACCOUNT);
    expect(info.baseAccountId).toBe(info.originalAddress);
  });
});

// ---------------------------------------------------------------------------
// 2. parseAddress — muxed M... account
// ---------------------------------------------------------------------------

describe('parseAddress — muxed account', () => {
  it('parses a valid M... address', () => {
    const info = parseAddress(MUXED_ID_1001);
    expect(info.isMuxed).toBe(true);
    expect(info.originalAddress).toBe(MUXED_ID_1001);
    expect(info.baseAccountId).toBe(BASE_ACCOUNT);
    expect(info.muxedId).toBe('1001');
  });

  it('extracts the multiplexing ID correctly for ID 1002', () => {
    const info = parseAddress(MUXED_ID_1002);
    expect(info.muxedId).toBe('1002');
    expect(info.baseAccountId).toBe(BASE_ACCOUNT);
  });

  it('handles the maximum u64 multiplexing ID', () => {
    const info = parseAddress(MUXED_ID_MAX);
    expect(info.muxedId).toBe('18446744073709551615');
    expect(info.isMuxed).toBe(true);
  });

  it('preserves the original M... address in originalAddress', () => {
    const info = parseAddress(MUXED_ID_1001);
    expect(info.originalAddress).toBe(MUXED_ID_1001);
  });

  it('baseAccountId for a muxed address is the underlying G... key', () => {
    const info = parseAddress(MUXED_ID_1001);
    expect(info.baseAccountId).toBe(BASE_ACCOUNT);
    // Must not be the muxed address itself
    expect(info.baseAccountId).not.toBe(MUXED_ID_1001);
  });
});

// ---------------------------------------------------------------------------
// 3. parseAddress — invalid / unsupported addresses
// ---------------------------------------------------------------------------

describe('parseAddress — invalid addresses', () => {
  it('throws for an empty string', () => {
    expect(() => parseAddress('')).toThrow('non-empty string');
  });

  it('throws for obviously malformed input', () => {
    expect(() => parseAddress('GARBAGE')).toThrow();
  });

  it('throws for a string that looks like a G... address but has the wrong checksum', () => {
    // Flip one character to corrupt the checksum
    const corrupt = BASE_ACCOUNT.slice(0, -1) + (BASE_ACCOUNT.endsWith('Q') ? 'A' : 'Q');
    expect(() => parseAddress(corrupt)).toThrow();
  });

  it('throws for a numeric string', () => {
    expect(() => parseAddress('12345')).toThrow();
  });

  it('throws for null-like values coerced to string', () => {
    expect(() => parseAddress(undefined as unknown as string)).toThrow();
  });

  it('throws for a contract address (C...)', () => {
    // Contract addresses start with C but are not valid Ed25519 or Med25519 keys
    expect(() => parseAddress('CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 4. describeAddressInfo
// ---------------------------------------------------------------------------

describe('describeAddressInfo', () => {
  it('describes a regular account without a multiplexing ID line', () => {
    const info = parseAddress(BASE_ACCOUNT);
    const description = describeAddressInfo(info);
    expect(description).toMatch(/regular account/i);
    expect(description).not.toMatch(/multiplexing/i);
  });

  it('describes a muxed account with both underlying account and multiplexing ID', () => {
    const info = parseAddress(MUXED_ID_1001);
    const description = describeAddressInfo(info);
    expect(description).toMatch(/muxed account/i);
    expect(description).toContain(BASE_ACCOUNT);
    expect(description).toContain('1001');
  });
});

// ---------------------------------------------------------------------------
// 5. resolveRecipient — known muxed IDs
// ---------------------------------------------------------------------------

describe('resolveRecipient — known muxed IDs', () => {
  it('resolves a known muxed ID to the correct customer', () => {
    const info = parseAddress(MUXED_ID_1001);
    const result = resolveRecipient(info);
    expect(result.errors).toHaveLength(0);
    expect(result.customer).not.toBeNull();
    expect(result.customer!.customerId).toBe('cust-alice-001');
  });

  it('produces no errors for a registered muxed ID', () => {
    const info = parseAddress(MUXED_ID_1002);
    const result = resolveRecipient(info);
    expect(result.errors).toHaveLength(0);
    expect(result.customer!.displayName).toBe('Bob');
  });
});

// ---------------------------------------------------------------------------
// 6. resolveRecipient — unknown muxed ID
// ---------------------------------------------------------------------------

describe('resolveRecipient — unknown muxed ID', () => {
  it('produces an error for an unregistered multiplexing ID', () => {
    const info = parseAddress(MUXED_ID_5555);
    const result = resolveRecipient(info);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toMatch(/unknown multiplexing id/i);
    expect(result.customer).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 7. resolveRecipient — regular account (no muxed ID)
// ---------------------------------------------------------------------------

describe('resolveRecipient — regular account', () => {
  it('returns null customer and a warning (not an error) for a regular address', () => {
    const info = parseAddress(BASE_ACCOUNT);
    const result = resolveRecipient(info);
    expect(result.errors).toHaveLength(0);
    expect(result.customer).toBeNull();
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 8. resolveRecipient — duplicate internal mapping
// ---------------------------------------------------------------------------

describe('resolveRecipient — duplicate mapping', () => {
  it('errors when two muxed IDs map to the same customerId', () => {
    const duplicateTable: Record<string, CustomerRecord> = {
      '1001': { customerId: 'cust-shared', displayName: 'Alice' },
      '2001': { customerId: 'cust-shared', displayName: 'Alice Clone' },
    };
    const muxed2001 = new MuxedAccount(baseAcc, '2001').accountId();
    const info = parseAddress(muxed2001);
    const result = resolveRecipient(info, duplicateTable);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toMatch(/ambiguous recipient/i);
  });
});

// ---------------------------------------------------------------------------
// 9. validatePaymentRequest
// ---------------------------------------------------------------------------

describe('validatePaymentRequest', () => {
  const validRequest: PaymentRequest = {
    sourceAccountId: SOURCE_ACCOUNT,
    destinationAddress: BASE_ACCOUNT,
    asset: 'native',
    amount: '10',
    networkPassphrase: Networks.TESTNET,
    sequenceNumber: '0',
  };

  it('accepts a valid request with zero errors', () => {
    const errors = validatePaymentRequest(validRequest);
    expect(errors).toHaveLength(0);
  });

  it('rejects an invalid destination address', () => {
    const errors = validatePaymentRequest({ ...validRequest, destinationAddress: 'BADADDR' });
    expect(errors.some((e) => /invalid destination/i.test(e))).toBe(true);
  });

  it('rejects an invalid source account', () => {
    const errors = validatePaymentRequest({ ...validRequest, sourceAccountId: 'NOT-A-KEY' });
    expect(errors.some((e) => /invalid source/i.test(e))).toBe(true);
  });

  it('rejects a zero amount', () => {
    const errors = validatePaymentRequest({ ...validRequest, amount: '0' });
    expect(errors.some((e) => /amount/i.test(e))).toBe(true);
  });

  it('rejects a negative-looking amount string', () => {
    const errors = validatePaymentRequest({ ...validRequest, amount: '-5' });
    expect(errors.some((e) => /amount/i.test(e))).toBe(true);
  });

  it('rejects an amount with more than seven decimal places', () => {
    const errors = validatePaymentRequest({ ...validRequest, amount: '1.00000001' });
    expect(errors.some((e) => /amount/i.test(e))).toBe(true);
  });

  it('accepts a muxed destination', () => {
    const errors = validatePaymentRequest({ ...validRequest, destinationAddress: MUXED_ID_1001 });
    expect(errors).toHaveLength(0);
  });

  it('rejects an invalid network passphrase', () => {
    const errors = validatePaymentRequest({
      ...validRequest,
      networkPassphrase: 'made up passphrase',
    });
    expect(errors.some((e) => /unrecognised network passphrase/i.test(e))).toBe(true);
  });

  it('rejects a malformed asset string', () => {
    const errors = validatePaymentRequest({ ...validRequest, asset: 'BADASSET' });
    expect(errors.some((e) => /invalid asset/i.test(e))).toBe(true);
  });

  it('accepts a valid issued asset', () => {
    const errors = validatePaymentRequest({ ...validRequest, asset: `USD:${ISSUER}` });
    expect(errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 10. buildPaymentTransaction — regular destination
// ---------------------------------------------------------------------------

describe('buildPaymentTransaction — regular destination', () => {
  const request: PaymentRequest = {
    sourceAccountId: SOURCE_ACCOUNT,
    destinationAddress: BASE_ACCOUNT,
    asset: 'native',
    amount: '25',
    networkPassphrase: Networks.TESTNET,
    sequenceNumber: '0',
  };

  it('builds a payment to a regular account', () => {
    const summary = buildPaymentTransaction(request);
    expect(summary.destination).toBe(BASE_ACCOUNT);
    expect(summary.destinationType).toBe('regular');
    expect(summary.amount).toBe('25');
    expect(summary.transactionXdr).toBeTruthy();
  });

  it('records the network label in the summary', () => {
    const summary = buildPaymentTransaction(request);
    expect(summary.network).toMatch(/testnet/i);
  });
});

// ---------------------------------------------------------------------------
// 11. buildPaymentTransaction — muxed destination
// ---------------------------------------------------------------------------

describe('buildPaymentTransaction — muxed destination', () => {
  const request: PaymentRequest = {
    sourceAccountId: SOURCE_ACCOUNT,
    destinationAddress: MUXED_ID_1002,
    asset: 'native',
    amount: '10.5',
    networkPassphrase: Networks.TESTNET,
    sequenceNumber: '1',
  };

  it('builds a payment to a muxed account', () => {
    const summary = buildPaymentTransaction(request);
    expect(summary.destination).toBe(MUXED_ID_1002);
    expect(summary.destinationType).toBe('muxed');
  });

  it('preserves the original muxed address as the destination — does not replace it with the base account', () => {
    const summary = buildPaymentTransaction(request);
    // The destination in the summary must be the M... address, not BASE_ACCOUNT
    expect(summary.destination).toBe(MUXED_ID_1002);
    expect(summary.destination).not.toBe(BASE_ACCOUNT);
  });

  it('produces valid transaction XDR', () => {
    const summary = buildPaymentTransaction(request);
    expect(typeof summary.transactionXdr).toBe('string');
    expect(summary.transactionXdr.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 12. buildPaymentTransaction — issued asset
// ---------------------------------------------------------------------------

describe('buildPaymentTransaction — issued asset', () => {
  it('builds a payment with an issued asset to a muxed account', () => {
    const summary = buildPaymentTransaction({
      sourceAccountId: SOURCE_ACCOUNT,
      destinationAddress: MUXED_ID_1001,
      asset: `USD:${ISSUER}`,
      amount: '100',
      networkPassphrase: Networks.TESTNET,
      sequenceNumber: '2',
    });
    expect(summary.destinationType).toBe('muxed');
    expect(summary.asset).toContain('USD');
    expect(summary.transactionXdr).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 13. buildPaymentTransaction — rejects invalid requests
// ---------------------------------------------------------------------------

describe('buildPaymentTransaction — rejects invalid requests', () => {
  it('throws WorkflowError for an invalid destination', () => {
    expect(() =>
      buildPaymentTransaction({
        sourceAccountId: SOURCE_ACCOUNT,
        destinationAddress: 'BAD',
        asset: 'native',
        amount: '1',
        networkPassphrase: Networks.TESTNET,
      }),
    ).toThrow(/payment validation failed/i);
  });

  it('throws WorkflowError for a zero amount', () => {
    expect(() =>
      buildPaymentTransaction({
        sourceAccountId: SOURCE_ACCOUNT,
        destinationAddress: BASE_ACCOUNT,
        asset: 'native',
        amount: '0',
        networkPassphrase: Networks.TESTNET,
      }),
    ).toThrow();
  });

  it('throws WorkflowError for an unrecognised network passphrase', () => {
    expect(() =>
      buildPaymentTransaction({
        sourceAccountId: SOURCE_ACCOUNT,
        destinationAddress: BASE_ACCOUNT,
        asset: 'native',
        amount: '1',
        networkPassphrase: 'fake passphrase',
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 14. buildRoutingReport — full end-to-end
// ---------------------------------------------------------------------------

describe('buildRoutingReport', () => {
  const baseRequest: PaymentRequest = {
    sourceAccountId: SOURCE_ACCOUNT,
    destinationAddress: MUXED_ID_1001,
    asset: 'native',
    amount: '50',
    networkPassphrase: Networks.TESTNET,
    sequenceNumber: '0',
  };

  it('produces a successful report for a known muxed destination', () => {
    const report = buildRoutingReport(baseRequest);
    expect(report.addressType).toBe('muxed');
    expect(report.baseAccountId).toBe(BASE_ACCOUNT);
    expect(report.muxedId).toBe('1001');
    expect(report.resolvedCustomer!.customerId).toBe('cust-alice-001');
    expect(report.validationPassed).toBe(true);
    expect(report.paymentConstructed).toBe(true);
    expect(report.transactionXdr).toBeTruthy();
    expect(report.errors).toHaveLength(0);
  });

  it('marks addressType as invalid for a malformed address', () => {
    const report = buildRoutingReport({ ...baseRequest, destinationAddress: 'JUNK' });
    expect(report.addressType).toBe('invalid');
    expect(report.validationPassed).toBe(false);
    expect(report.paymentConstructed).toBe(false);
    expect(report.errors.length).toBeGreaterThan(0);
  });

  it('fails validation for an unknown multiplexing ID', () => {
    const report = buildRoutingReport({ ...baseRequest, destinationAddress: MUXED_ID_5555 });
    expect(report.validationPassed).toBe(false);
    expect(report.paymentConstructed).toBe(false);
    expect(report.errors.some((e) => /unknown multiplexing id/i.test(e))).toBe(true);
  });

  it('issues a warning (not an error) for a regular account destination', () => {
    const report = buildRoutingReport({ ...baseRequest, destinationAddress: BASE_ACCOUNT });
    expect(report.warnings.length).toBeGreaterThan(0);
    // No multiplexing-ID error — regular payment is still valid
    expect(report.errors).toHaveLength(0);
    expect(report.validationPassed).toBe(true);
  });

  it('fails for an invalid amount', () => {
    const report = buildRoutingReport({ ...baseRequest, amount: '0' });
    expect(report.validationPassed).toBe(false);
    expect(report.errors.some((e) => /amount/i.test(e))).toBe(true);
  });

  it('fails for a network passphrase mismatch', () => {
    const report = buildRoutingReport({
      ...baseRequest,
      networkPassphrase: 'wrong passphrase here',
    });
    expect(report.validationPassed).toBe(false);
    expect(report.errors.some((e) => /passphrase/i.test(e))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 15. Guard — muxed destination must not be replaced with base account
// ---------------------------------------------------------------------------

describe('muxed destination preservation', () => {
  it('the payment summary destination is the original M... address, not the underlying G... address', () => {
    const summary = buildPaymentTransaction({
      sourceAccountId: SOURCE_ACCOUNT,
      destinationAddress: MUXED_ID_1001,
      asset: 'native',
      amount: '1',
      networkPassphrase: Networks.TESTNET,
      sequenceNumber: '0',
    });
    expect(summary.destination).toBe(MUXED_ID_1001);
    expect(summary.destination).not.toBe(BASE_ACCOUNT);
  });

  it('the routing report originalDestination is the M... address', () => {
    const report = buildRoutingReport({
      sourceAccountId: SOURCE_ACCOUNT,
      destinationAddress: MUXED_ID_1002,
      asset: 'native',
      amount: '5',
      networkPassphrase: Networks.TESTNET,
      sequenceNumber: '0',
    });
    expect(report.originalDestination).toBe(MUXED_ID_1002);
    expect(report.originalDestination).not.toBe(BASE_ACCOUNT);
  });
});

// ---------------------------------------------------------------------------
// 16. resolveAsset
// ---------------------------------------------------------------------------

describe('resolveAsset', () => {
  it('resolves "native" to the native asset', () => {
    const asset = resolveAsset('native');
    expect(asset.isNative()).toBe(true);
  });

  it('resolves "XLM" to the native asset', () => {
    const asset = resolveAsset('XLM');
    expect(asset.isNative()).toBe(true);
  });

  it('resolves a CODE:ISSUER string to an issued asset', () => {
    const asset = resolveAsset(`USD:${ISSUER}`);
    expect(asset.isNative()).toBe(false);
    expect(asset.code).toBe('USD');
    expect(asset.issuer).toBe(ISSUER);
  });
});

// ---------------------------------------------------------------------------
// 17. formatRoutingReport
// ---------------------------------------------------------------------------

describe('formatRoutingReport', () => {
  it('includes all key fields in the formatted output', () => {
    const report = buildRoutingReport({
      sourceAccountId: SOURCE_ACCOUNT,
      destinationAddress: MUXED_ID_1001,
      asset: 'native',
      amount: '10',
      networkPassphrase: Networks.TESTNET,
      sequenceNumber: '0',
    });
    const output = formatRoutingReport(report);
    expect(output).toContain(MUXED_ID_1001);
    expect(output).toContain('muxed');
    expect(output).toContain(BASE_ACCOUNT);
    expect(output).toContain('1001');
    expect(output).toContain('Alice');
    expect(output).toMatch(/testnet/i);
  });

  it('includes error lines when validation fails', () => {
    const report = buildRoutingReport({
      sourceAccountId: SOURCE_ACCOUNT,
      destinationAddress: MUXED_ID_5555,
      asset: 'native',
      amount: '10',
      networkPassphrase: Networks.TESTNET,
      sequenceNumber: '0',
    });
    const output = formatRoutingReport(report);
    expect(output).toMatch(/errors/i);
  });
});

// ---------------------------------------------------------------------------
// 18. MOCK_RECIPIENT_TABLE integrity
// ---------------------------------------------------------------------------

describe('MOCK_RECIPIENT_TABLE', () => {
  it('has no duplicate customerIds across different muxed IDs', () => {
    const customerIds = Object.values(MOCK_RECIPIENT_TABLE).map((r) => r.customerId);
    const unique = new Set(customerIds);
    expect(unique.size).toBe(customerIds.length);
  });

  it('has at least three registered customers', () => {
    expect(Object.keys(MOCK_RECIPIENT_TABLE).length).toBeGreaterThanOrEqual(3);
  });
});
