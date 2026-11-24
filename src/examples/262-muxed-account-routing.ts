/**
 * Example 262: Stellar Muxed Account Address Parsing and Payment Routing
 *
 * Muxed accounts let one on-chain Stellar account serve many logical recipients.
 * A muxed address (M...) encodes a regular G... public key together with a 64-bit
 * multiplexing ID. Exchanges and payment services use this to attribute deposits
 * and withdrawals to individual customers without funding a separate Stellar
 * account for each one.
 *
 * This example demonstrates:
 *   1. Parsing and validating both regular (G...) and muxed (M...) addresses.
 *   2. Extracting the underlying account ID and multiplexing ID from muxed addresses.
 *   3. Building XLM and issued-asset payment transactions for both address types.
 *   4. Mapping multiplexing IDs to internal customer records with safety checks.
 *   5. Payment safety validation before transaction construction.
 *   6. Generating a structured routing report.
 *
 * IMPORTANT: Multiplexing IDs are routing metadata, not authentication credentials.
 * Never treat a multiplexing ID as proof of identity — apply application-level
 * authentication separately.
 *
 * Compatibility note: Not every Stellar service or wallet accepts muxed
 * destinations. Confirm that the target Horizon instance and any third-party
 * services support muxed accounts before using them in production.
 */

import {
  Account,
  Asset,
  MuxedAccount,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { WorkflowError, amountUnits } from '../utils/example-input';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** All information extracted from a parsed Stellar address. */
export interface AddressInfo {
  /** The original address string as supplied by the caller. */
  originalAddress: string;
  /** Whether the address encodes a muxed account (M...) or a regular account (G...). */
  isMuxed: boolean;
  /** The underlying Ed25519 public key (G... format). */
  baseAccountId: string;
  /** The multiplexing ID, present only for muxed addresses. */
  muxedId?: string;
}

/** An internal customer record used by the mock lookup table. */
export interface CustomerRecord {
  /** Application-level customer reference — kept separate from Stellar addresses. */
  customerId: string;
  /** Human-readable display name for reporting. */
  displayName: string;
}

/** Result of resolving a destination address to an internal customer. */
export interface RecipientResolution {
  addressInfo: AddressInfo;
  customer: CustomerRecord | null;
  /** Non-fatal warnings that the caller should log or surface. */
  warnings: string[];
  /** Fatal errors that must block payment construction. */
  errors: string[];
}

/** Inputs used to construct a payment. */
export interface PaymentRequest {
  /** Source account G... public key (must already exist on-chain in production). */
  sourceAccountId: string;
  /** Destination address — either G... or M... */
  destinationAddress: string;
  /** Asset to send: 'native' or 'CODE:ISSUER'. */
  asset: string;
  /** Decimal amount string with up to seven decimal places. */
  amount: string;
  /** Stellar network passphrase. */
  networkPassphrase: string;
  /** Current sequence number for the source account (string). */
  sequenceNumber?: string;
}

/** Summary produced after building a payment transaction. */
export interface PaymentSummary {
  destination: string;
  destinationType: 'regular' | 'muxed';
  asset: string;
  amount: string;
  network: string;
  transactionXdr: string;
}

/** Full routing report combining address info, recipient, and payment outcome. */
export interface RoutingReport {
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

// ---------------------------------------------------------------------------
// 1. Address parsing and validation
// ---------------------------------------------------------------------------

/**
 * Parse a Stellar address into its components.
 *
 * Returns an AddressInfo for valid G... and M... addresses.
 * Throws WorkflowError for malformed or unsupported input.
 *
 * The SDK's StrKey methods are used for validation — manual StrKey decoding is
 * intentionally avoided so that any future encoding changes in the SDK are
 * picked up automatically.
 */
export function parseAddress(address: string): AddressInfo {
  if (!address || typeof address !== 'string') {
    throw new WorkflowError('Address must be a non-empty string.');
  }

  const trimmed = address.trim();

  // Muxed account (M...)
  if (StrKey.isValidMed25519PublicKey(trimmed)) {
    const muxed = MuxedAccount.fromAddress(trimmed, '0');
    return {
      originalAddress: trimmed,
      isMuxed: true,
      baseAccountId: muxed.baseAccount().accountId(),
      muxedId: muxed.id(),
    };
  }

  // Regular account (G...)
  if (StrKey.isValidEd25519PublicKey(trimmed)) {
    return {
      originalAddress: trimmed,
      isMuxed: false,
      baseAccountId: trimmed,
    };
  }

  throw new WorkflowError(
    `Unsupported or malformed address: "${trimmed}". ` +
      'Expected a G... (Ed25519) or M... (muxed Ed25519) Stellar address.',
  );
}

/**
 * Display a human-readable summary of parsed address info.
 */
export function describeAddressInfo(info: AddressInfo): string {
  if (info.isMuxed) {
    return (
      `Muxed account\n` +
      `  Original address:    ${info.originalAddress}\n` +
      `  Underlying account:  ${info.baseAccountId}\n` +
      `  Multiplexing ID:     ${info.muxedId}`
    );
  }
  return (
    `Regular account\n` +
    `  Address:             ${info.originalAddress}`
  );
}

// ---------------------------------------------------------------------------
// 2. Recipient mapping
// ---------------------------------------------------------------------------

/**
 * A mock lookup table mapping multiplexing IDs to internal customer records.
 *
 * In a real application this would be backed by a database or identity store.
 * Customer IDs are intentionally different from Stellar addresses or muxed IDs
 * to reinforce the separation between routing metadata and customer identity.
 *
 * Note: Multiplexing IDs are not authentication credentials. An application
 * must authenticate customers through its own auth layer; a correctly formatted
 * muxed ID alone does not prove who sent or should receive a payment.
 */
export const MOCK_RECIPIENT_TABLE: Record<string, CustomerRecord> = {
  '1001': { customerId: 'cust-alice-001', displayName: 'Alice' },
  '1002': { customerId: 'cust-bob-002', displayName: 'Bob' },
  '1003': { customerId: 'cust-carol-003', displayName: 'Carol' },
  '9999': { customerId: 'cust-dave-004', displayName: 'Dave' },
};

/**
 * Resolve an AddressInfo to an internal customer record.
 *
 * Rules:
 *  - Regular accounts do not carry a multiplexing ID; they resolve to null
 *    with a note, which is not an error — payments to regular accounts are valid.
 *  - Muxed accounts are looked up by multiplexing ID.
 *  - An unknown multiplexing ID is a fatal error: routing to the wrong customer
 *    is worse than not routing at all.
 *  - Duplicate internal mappings (same customerId mapped to multiple muxed IDs)
 *    are detected and produce a fatal error; they indicate a misconfigured table.
 */
export function resolveRecipient(
  info: AddressInfo,
  table: Record<string, CustomerRecord> = MOCK_RECIPIENT_TABLE,
): RecipientResolution {
  const warnings: string[] = [];
  const errors: string[] = [];

  if (!info.isMuxed) {
    warnings.push(
      'Destination is a regular account with no multiplexing ID. ' +
        'No internal customer lookup was performed. ' +
        'This is acceptable for non-custodial payments, but custodial systems ' +
        'should require a muxed address so deposits can be attributed.',
    );
    return { addressInfo: info, customer: null, warnings, errors };
  }

  const muxedId = info.muxedId!;
  const customer = table[muxedId] ?? null;

  if (!customer) {
    errors.push(
      `Unknown multiplexing ID "${muxedId}". ` +
        'This ID is not registered in the recipient table. ' +
        'Routing to an unrecognised ID risks attributing the payment to the wrong customer. ' +
        'Reject this payment and ask the sender to supply a registered destination address.',
    );
    return { addressInfo: info, customer: null, warnings, errors };
  }

  // Detect duplicate mappings: more than one muxed ID pointing at the same customerId.
  const duplicates = Object.entries(table).filter(
    ([id, rec]) => id !== muxedId && rec.customerId === customer.customerId,
  );

  if (duplicates.length > 0) {
    const duplicateIds = duplicates.map(([id]) => id).join(', ');
    errors.push(
      `Ambiguous recipient: customer "${customer.customerId}" is also mapped to ` +
        `multiplexing ID(s) ${duplicateIds}. ` +
        'Remove duplicate entries from the recipient table before accepting payments.',
    );
    return { addressInfo: info, customer, warnings, errors };
  }

  return { addressInfo: info, customer, warnings, errors };
}

// ---------------------------------------------------------------------------
// 3. Payment safety validation
// ---------------------------------------------------------------------------

/** Known Stellar network passphrases used in network-mismatch detection. */
const KNOWN_NETWORKS: Record<string, string> = {
  [Networks.TESTNET]: 'Testnet',
  [Networks.PUBLIC]: 'Mainnet (Public)',
  [Networks.FUTURENET]: 'Futurenet',
  [Networks.SANDBOX]: 'Sandbox',
  [Networks.STANDALONE]: 'Standalone',
};

/**
 * Validate a PaymentRequest before constructing a transaction.
 *
 * Returns an array of error strings. An empty array means the request is valid.
 */
export function validatePaymentRequest(request: PaymentRequest): string[] {
  const errors: string[] = [];

  // Destination address
  try {
    parseAddress(request.destinationAddress);
  } catch {
    errors.push(`Invalid destination address: "${request.destinationAddress}".`);
  }

  // Source account
  if (!StrKey.isValidEd25519PublicKey(request.sourceAccountId)) {
    errors.push(`Invalid source account: "${request.sourceAccountId}".`);
  }

  // Amount — must be a positive decimal with at most seven decimal places
  if (!/^\d+(\.\d{1,7})?$/.test(request.amount)) {
    errors.push(
      `Invalid amount "${request.amount}": must be a decimal with up to seven decimal places.`,
    );
  } else {
    try {
      const units = amountUnits(request.amount);
      if (units <= 0n) {
        errors.push(`Amount "${request.amount}" must be greater than zero.`);
      } else if (units > 9223372036854775807n) {
        errors.push(`Amount "${request.amount}" exceeds the maximum Stellar int64 value.`);
      }
    } catch {
      errors.push(`Amount "${request.amount}" could not be parsed.`);
    }
  }

  // Asset format
  if (!/^(native|XLM)$/i.test(request.asset)) {
    const parts = request.asset.split(':');
    if (
      parts.length !== 2 ||
      !/^[A-Za-z0-9]{1,12}$/.test(parts[0]) ||
      !StrKey.isValidEd25519PublicKey(parts[1])
    ) {
      errors.push(
        `Invalid asset "${request.asset}": must be "native" or "CODE:ISSUER" ` +
          'where ISSUER is a valid G... public key.',
      );
    }
  }

  // Network passphrase — warn on unrecognised passphrases
  if (!KNOWN_NETWORKS[request.networkPassphrase]) {
    errors.push(
      `Unrecognised network passphrase. ` +
        `Known passphrases: ${Object.values(KNOWN_NETWORKS).join(', ')}. ` +
        'Using a custom passphrase is only valid for private networks.',
    );
  }

  return errors;
}

// ---------------------------------------------------------------------------
// 4. Payment construction
// ---------------------------------------------------------------------------

/**
 * Resolve an asset string into an Asset object.
 */
export function resolveAsset(assetStr: string): Asset {
  if (/^(native|XLM)$/i.test(assetStr)) return Asset.native();
  const parts = assetStr.split(':');
  return new Asset(parts[0], parts[1]);
}

/**
 * Build an unsigned payment transaction for a regular or muxed destination.
 *
 * Key design decision: the original muxed destination address is preserved
 * verbatim as the payment operation destination. The SDK encodes this into
 * the transaction XDR as a MuxedAccount so the multiplexing ID is retained
 * on-chain. Never silently replace a muxed address with its underlying G...
 * account — that discards the routing metadata and may cause the payment to
 * be attributed to the wrong internal customer.
 *
 * The function accepts an optional sequenceNumber so callers can pass a
 * deterministic value in tests without hitting the network.
 *
 * Asset trustline note: for issued assets, the destination must hold a
 * trustline for that asset. This example assumes the trustline exists; in
 * production, verify via Horizon before constructing the transaction.
 */
export function buildPaymentTransaction(request: PaymentRequest): PaymentSummary {
  const validationErrors = validatePaymentRequest(request);
  if (validationErrors.length > 0) {
    throw new WorkflowError(
      `Payment validation failed:\n${validationErrors.map((e) => `  • ${e}`).join('\n')}`,
    );
  }

  const info = parseAddress(request.destinationAddress);
  const asset = resolveAsset(request.asset);
  const sequenceNumber = request.sequenceNumber ?? '0';

  const sourceAccount = new Account(request.sourceAccountId, sequenceNumber);

  const tx = new TransactionBuilder(sourceAccount, {
    fee: '100',
    networkPassphrase: request.networkPassphrase,
  })
    .addOperation(
      Operation.payment({
        // Pass the original address directly — the SDK preserves the muxed
        // encoding in the XDR when the destination is an M... address.
        destination: request.destinationAddress,
        asset,
        amount: request.amount,
      }),
    )
    .setTimeout(30)
    .build();

  const networkLabel = KNOWN_NETWORKS[request.networkPassphrase] ?? 'custom network';

  const summary: PaymentSummary = {
    destination: request.destinationAddress,
    destinationType: info.isMuxed ? 'muxed' : 'regular',
    asset: asset.isNative() ? 'XLM (native)' : `${asset.code}:${asset.issuer}`,
    amount: request.amount,
    network: networkLabel,
    transactionXdr: tx.toXDR(),
  };

  return summary;
}

// ---------------------------------------------------------------------------
// 5. Routing report
// ---------------------------------------------------------------------------

/**
 * Generate a full payment routing report for a given destination and payment.
 *
 * This combines address parsing, recipient resolution, validation, and
 * (if validation passes) payment construction into one structured output.
 */
export function buildRoutingReport(
  request: PaymentRequest,
  table: Record<string, CustomerRecord> = MOCK_RECIPIENT_TABLE,
): RoutingReport {
  const report: RoutingReport = {
    originalDestination: request.destinationAddress,
    addressType: 'invalid',
    baseAccountId: null,
    muxedId: null,
    resolvedCustomer: null,
    asset: request.asset,
    amount: request.amount,
    network: KNOWN_NETWORKS[request.networkPassphrase] ?? 'custom network',
    validationPassed: false,
    paymentConstructed: false,
    transactionXdr: null,
    warnings: [],
    errors: [],
  };

  // Step 1: parse the address
  let info: AddressInfo;
  try {
    info = parseAddress(request.destinationAddress);
    report.addressType = info.isMuxed ? 'muxed' : 'regular';
    report.baseAccountId = info.baseAccountId;
    report.muxedId = info.muxedId ?? null;
  } catch (err) {
    report.errors.push(err instanceof Error ? err.message : String(err));
    return report;
  }

  // Step 2: resolve recipient
  const resolution = resolveRecipient(info, table);
  report.resolvedCustomer = resolution.customer;
  report.warnings.push(...resolution.warnings);
  report.errors.push(...resolution.errors);

  // Step 3: validate the full payment request
  const validationErrors = validatePaymentRequest(request);
  report.errors.push(...validationErrors);

  if (report.errors.length > 0) {
    return report;
  }

  report.validationPassed = true;

  // Step 4: build the payment transaction
  try {
    const summary = buildPaymentTransaction(request);
    report.paymentConstructed = true;
    report.transactionXdr = summary.transactionXdr;
  } catch (err) {
    report.errors.push(err instanceof Error ? err.message : String(err));
  }

  return report;
}

/**
 * Format a RoutingReport for human-readable console output.
 */
export function formatRoutingReport(report: RoutingReport): string {
  const lines: string[] = [
    '=== Payment Routing Report ===',
    `Original destination:    ${report.originalDestination}`,
    `Address type:            ${report.addressType}`,
    `Underlying account ID:   ${report.baseAccountId ?? 'n/a'}`,
    `Multiplexing ID:         ${report.muxedId ?? 'n/a'}`,
    `Resolved customer:       ${
      report.resolvedCustomer
        ? `${report.resolvedCustomer.displayName} (${report.resolvedCustomer.customerId})`
        : 'none'
    }`,
    `Asset:                   ${report.asset}`,
    `Amount:                  ${report.amount}`,
    `Network:                 ${report.network}`,
    `Validation passed:       ${report.validationPassed ? 'yes' : 'no'}`,
    `Payment constructed:     ${report.paymentConstructed ? 'yes' : 'no'}`,
  ];

  if (report.warnings.length > 0) {
    lines.push('', 'Warnings:');
    report.warnings.forEach((w) => lines.push(`  ⚠  ${w}`));
  }

  if (report.errors.length > 0) {
    lines.push('', 'Errors:');
    report.errors.forEach((e) => lines.push(`  ✗  ${e}`));
  }

  if (report.transactionXdr) {
    lines.push('', `Transaction XDR (unsigned):`);
    lines.push(`  ${report.transactionXdr}`);
    lines.push('  (transaction built for inspection only — not signed or submitted)');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 6. Example runner
// ---------------------------------------------------------------------------

export async function run(): Promise<void> {
  console.log('Starting Muxed Account Address Parsing and Payment Routing Example...');
  console.log(
    '\nMuxed accounts allow one on-chain Stellar account to serve many logical\n' +
      'recipients. Each M... address encodes a regular G... public key (the\n' +
      'underlying account) and a 64-bit multiplexing ID.\n',
  );

  // --- deterministic keys for demonstration ---
  const BASE_ACCOUNT = 'GCN7PAR5MAAUHMVV5GGUFVH6LOZWWISGHUVG4TEFEI46PP4NCZCRFZYF';
  const SOURCE_ACCOUNT = 'GAEHGI5A4VZ3RAANJNLPOYHWHX4NMDU6COVQWOLX5VPTSDMQDKBDRHYT';
  const ISSUER = 'GDVQQGHC4DC7FXNDS4S3E7KXR3EEOF7X4ZYGH7O45SYAM2S2TR2N4JPK';

  // 1. Parse a regular account
  console.log('--- 1. Parsing a regular (G...) account ---');
  const regularInfo = parseAddress(BASE_ACCOUNT);
  console.log(describeAddressInfo(regularInfo));

  // 2. Build and parse a muxed address
  console.log('\n--- 2. Building and parsing muxed accounts ---');
  const baseAcc = new Account(BASE_ACCOUNT, '0');
  for (const id of ['1001', '1002', '9999', '18446744073709551615']) {
    const muxedAddr = new MuxedAccount(baseAcc, id).accountId();
    const info = parseAddress(muxedAddr);
    console.log(`\nMuxed ID ${id}:`);
    console.log(describeAddressInfo(info));
  }

  // 3. Recipient resolution
  console.log('\n--- 3. Recipient mapping ---');
  const knownMuxed = new MuxedAccount(baseAcc, '1001').accountId();
  const unknownMuxed = new MuxedAccount(baseAcc, '5555').accountId();

  const knownResolution = resolveRecipient(parseAddress(knownMuxed));
  console.log(
    `\nKnown muxed (ID 1001): resolved to ${knownResolution.customer?.displayName ?? 'none'}`,
  );

  const unknownResolution = resolveRecipient(parseAddress(unknownMuxed));
  console.log(`\nUnknown muxed (ID 5555): errors — ${unknownResolution.errors.join('; ')}`);

  const regularResolution = resolveRecipient(parseAddress(BASE_ACCOUNT));
  console.log(`\nRegular account: warnings — ${regularResolution.warnings[0]}`);

  // 4. Payment construction — regular destination
  console.log('\n--- 4. Building a payment to a regular account ---');
  const regularPayment = buildPaymentTransaction({
    sourceAccountId: SOURCE_ACCOUNT,
    destinationAddress: BASE_ACCOUNT,
    asset: 'native',
    amount: '25',
    networkPassphrase: Networks.TESTNET,
    sequenceNumber: '0',
  });
  console.log(`Destination:  ${regularPayment.destination} (${regularPayment.destinationType})`);
  console.log(`Asset:        ${regularPayment.asset}`);
  console.log(`Amount:       ${regularPayment.amount}`);
  console.log(`Network:      ${regularPayment.network}`);
  console.log('Transaction XDR (unsigned — not submitted):');
  console.log(`  ${regularPayment.transactionXdr}`);

  // 5. Payment construction — muxed destination
  console.log('\n--- 5. Building a payment to a muxed account ---');
  const muxedDest = new MuxedAccount(baseAcc, '1002').accountId();
  const muxedPayment = buildPaymentTransaction({
    sourceAccountId: SOURCE_ACCOUNT,
    destinationAddress: muxedDest,
    asset: 'native',
    amount: '10.5',
    networkPassphrase: Networks.TESTNET,
    sequenceNumber: '1',
  });
  console.log(`Destination:  ${muxedPayment.destination} (${muxedPayment.destinationType})`);
  console.log(`Asset:        ${muxedPayment.asset}`);
  console.log(`Amount:       ${muxedPayment.amount}`);
  console.log('Transaction XDR (unsigned — not submitted):');
  console.log(`  ${muxedPayment.transactionXdr}`);

  // 6. Issued-asset payment
  console.log('\n--- 6. Building an issued-asset payment to a muxed account ---');
  console.log(
    'Note: in production, verify the destination holds a trustline before constructing.',
  );
  const muxedForAsset = new MuxedAccount(baseAcc, '1003').accountId();
  const assetPayment = buildPaymentTransaction({
    sourceAccountId: SOURCE_ACCOUNT,
    destinationAddress: muxedForAsset,
    asset: `USD:${ISSUER}`,
    amount: '100',
    networkPassphrase: Networks.TESTNET,
    sequenceNumber: '2',
  });
  console.log(`Destination:  ${assetPayment.destination} (${assetPayment.destinationType})`);
  console.log(`Asset:        ${assetPayment.asset}`);
  console.log(`Amount:       ${assetPayment.amount}`);

  // 7. Safety checks — validation rejects bad input
  console.log('\n--- 7. Payment safety checks ---');
  const badErrors = validatePaymentRequest({
    sourceAccountId: SOURCE_ACCOUNT,
    destinationAddress: 'NOT-A-VALID-ADDRESS',
    asset: 'native',
    amount: '0',
    networkPassphrase: Networks.TESTNET,
  });
  console.log('Validation errors for bad request:');
  badErrors.forEach((e) => console.log(`  ✗ ${e}`));

  // 8. Routing reports
  console.log('\n--- 8. Routing reports ---');
  const dest1002 = new MuxedAccount(baseAcc, '1002').accountId();
  const report = buildRoutingReport({
    sourceAccountId: SOURCE_ACCOUNT,
    destinationAddress: dest1002,
    asset: 'native',
    amount: '50',
    networkPassphrase: Networks.TESTNET,
    sequenceNumber: '3',
  });
  console.log('\n' + formatRoutingReport(report));

  // 9. Guard against accidentally stripping the muxed ID
  console.log('\n--- 9. Guard: never silently replace a muxed destination with its base account ---');
  const muxedExample = new MuxedAccount(baseAcc, '1001').accountId();
  const muxedInfo = parseAddress(muxedExample);
  console.log(`Original muxed address:  ${muxedInfo.originalAddress}`);
  console.log(`Underlying G... account: ${muxedInfo.baseAccountId}`);
  console.log(
    '⚠  Routing a payment to the underlying G... account instead of the M... address\n' +
      '   discards the multiplexing ID. The payment will credit the base account holder\n' +
      '   rather than the intended internal recipient. Always use the original M... address\n' +
      '   as the Payment operation destination unless you explicitly intend to pay the\n' +
      '   base account and have communicated that to users.',
  );

  console.log('\nMuxed account routing example completed successfully.');
}
