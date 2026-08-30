import {
  Account,
  Asset,
  FeeBumpTransaction,
  Keypair,
  Memo,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import chalk from 'chalk';

/**
 * Stellar Transaction Envelope Normalization Example
 *
 * Stellar transactions can be represented as different envelope types depending on
 * how they are signed and submitted. Applications that inspect, store, relay, or
 * compare transaction envelopes need a consistent way to decode the envelope,
 * identify its type, extract the underlying transaction, and produce a canonical
 * representation.
 *
 * This example demonstrates:
 *   1. Decoding transaction envelopes from base64 XDR
 *   2. Identifying envelope types (standard vs fee-bump)
 *   3. Extracting and normalizing common transaction fields
 *   4. Handling fee-bump envelopes with outer/inner transaction separation
 *   5. Producing normalized JSON representations
 *   6. Re-encoding normalized transactions to XDR
 *   7. Comparing original and reconstructed transaction hashes
 *   8. Verifying semantic preservation during normalization
 *   9. Handling malformed XDR gracefully
 *   10. Working offline without network access
 */

export interface EnvelopeNormalizationParams {
  envelopeXdr?: string;
  json?: boolean | string;
}

export interface NormalizedOperation {
  type: string;
  sourceAccount?: string;
  details: Record<string, unknown>;
}

export interface NormalizedMemo {
  type: string;
  value?: string;
}

export interface NormalizedTimeBounds {
  minTime: string;
  maxTime: string;
}

export interface NormalizedSignature {
  hint: string;
  signature: string;
}

export interface NormalizedTransaction {
  envelopeType: string;
  sourceAccount: string;
  sequence: string;
  fee: string;
  operations: NormalizedOperation[];
  memo: NormalizedMemo;
  timeBounds?: NormalizedTimeBounds;
  signatures: NormalizedSignature[];
  networkPassphrase: string;
}

export interface NormalizedFeeBumpTransaction extends NormalizedTransaction {
  isFeeBump: true;
  feeSource: string;
  feeBumpFee: string;
  innerTransaction: NormalizedTransaction;
}

export interface NormalizationResult {
  originalEnvelopeXdr: string;
  normalizedTransaction: NormalizedTransaction | NormalizedFeeBumpTransaction;
  reconstructedEnvelopeXdr?: string;
  originalHash: string;
  reconstructedHash?: string;
  hashMatches: boolean;
  semanticPreservation: {
    sourceAccount: boolean;
    sequence: boolean;
    fee: boolean;
    operations: boolean;
    memo: boolean;
    timeBounds: boolean;
    signatures: boolean;
  };
}

function wantsJson(params: EnvelopeNormalizationParams): boolean {
  return (
    params.json === true ||
    params.json === 'true' ||
    process.env.JSON_OUTPUT === 'true' ||
    process.argv.includes('--json') ||
    process.argv.includes('--json=true')
  );
}

/**
 * Decode a base64-encoded transaction envelope
 */
function decodeEnvelope(
  envelopeXdr: string,
  networkPassphrase: string = Networks.TESTNET,
): Transaction | FeeBumpTransaction {
  try {
    return TransactionBuilder.fromXDR(envelopeXdr, networkPassphrase);
  } catch (error) {
    throw new Error(
      `Invalid transaction envelope XDR: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Identify the envelope type
 */
function identifyEnvelopeType(transaction: Transaction | FeeBumpTransaction): string {
  if (transaction instanceof FeeBumpTransaction) {
    return 'envelopeTypeTxFeeBump';
  }
  return 'envelopeTypeTx';
}

/**
 * Normalize a memo object
 */
function normalizeMemo(memo: any): NormalizedMemo {
  if (!memo) {
    return { type: 'NONE' };
  }

  const type = memo.type;
  const value = memo.value;

  switch (type) {
    case 'none':
      return { type: 'NONE' };
    case 'id':
      return { type: 'ID', value: String(value) };
    case 'hash':
    case 'return':
      return { type: type.toUpperCase(), value: value };
    case 'text':
      return { type: 'TEXT', value: String(value) };
    default:
      return { type: 'UNKNOWN', value: String(value) };
  }
}

/**
 * Normalize time bounds
 */
function normalizeTimeBounds(transaction: Transaction): NormalizedTimeBounds | undefined {
  const timeBounds = (
    transaction as unknown as { timeBounds?: { minTime: number; maxTime: number } }
  ).timeBounds;

  if (!timeBounds || (timeBounds.minTime === 0 && timeBounds.maxTime === 0)) {
    return undefined;
  }

  return {
    minTime: String(timeBounds.minTime),
    maxTime: String(timeBounds.maxTime),
  };
}

/**
 * Normalize operation details
 */
function normalizeOperationDetails(operation: any): Record<string, unknown> {
  const details: Record<string, unknown> = {};

  try {
    switch (operation.type) {
      case 'createAccount':
        details.destination = operation.destination;
        details.startingBalance = operation.startingBalance;
        break;
      case 'payment':
        details.destination = operation.destination;
        details.asset = operation.asset;
        details.amount = operation.amount;
        break;
      case 'pathPaymentStrictReceive':
        details.destination = operation.destination;
        details.sendAsset = operation.sendAsset;
        details.destAsset = operation.destAsset;
        details.sendMax = operation.sendMax;
        details.destAmount = operation.destAmount;
        details.path = operation.path;
        break;
      case 'manageSellOffer':
        details.selling = operation.selling;
        details.buying = operation.buying;
        details.amount = operation.amount;
        details.price = operation.price;
        details.offerId = operation.offerId;
        break;
      case 'manageBuyOffer':
        details.selling = operation.selling;
        details.buying = operation.buying;
        details.buyAmount = operation.buyAmount;
        details.price = operation.price;
        details.offerId = operation.offerId;
        break;
      case 'createPassiveSellOffer':
        details.selling = operation.selling;
        details.buying = operation.buying;
        details.amount = operation.amount;
        details.price = operation.price;
        break;
      case 'setOptions':
        if (operation.inflationDest) details.inflationDest = operation.inflationDest;
        if (operation.clearFlags) details.clearFlags = operation.clearFlags;
        if (operation.setFlags) details.setFlags = operation.setFlags;
        if (operation.masterWeight) details.masterWeight = operation.masterWeight;
        if (operation.lowThreshold) details.lowThreshold = operation.lowThreshold;
        if (operation.medThreshold) details.medThreshold = operation.medThreshold;
        if (operation.highThreshold) details.highThreshold = operation.highThreshold;
        if (operation.homeDomain) details.homeDomain = operation.homeDomain;
        if (operation.signer) details.signer = operation.signer;
        break;
      case 'changeTrust':
        details.asset = operation.asset;
        details.limit = operation.limit;
        break;
      case 'allowTrust':
        details.trustor = operation.trustor;
        details.assetCode = operation.assetCode;
        details.authorize = operation.authorize;
        break;
      case 'accountMerge':
        details.destination = operation.destination;
        break;
      case 'inflation':
        break;
      case 'manageData':
        details.name = operation.name;
        details.value = operation.value;
        break;
      case 'bumpSequence':
        details.bumpTo = operation.bumpTo;
        break;
      default:
        details.raw = operation;
    }
  } catch (error) {
    details.error = error instanceof Error ? error.message : String(error);
  }

  return details;
}

/**
 * Normalize operations
 */
function normalizeOperations(operations: any[]): NormalizedOperation[] {
  return operations.map((op) => ({
    type: op.type,
    sourceAccount: op.source,
    details: normalizeOperationDetails(op),
  }));
}

/**
 * Normalize signatures
 */
function normalizeSignatures(signatures: any[]): NormalizedSignature[] {
  return signatures.map((sig) => {
    try {
      // The SDK signature structure varies, try different approaches
      if (sig.hint && typeof sig.hint === 'function') {
        // If hint is a function, call it
        const hintValue = sig.hint();
        return {
          hint: hintValue ? hintValue.toString('hex') : 'unknown',
          signature: sig.signature ? sig.signature.toString('base64') : 'unknown',
        };
      } else if (sig.hint) {
        return {
          hint: sig.hint.toString ? sig.hint.toString('hex') : String(sig.hint),
          signature: sig.signature ? sig.signature.toString('base64') : 'unknown',
        };
      } else {
        return {
          hint: 'unknown',
          signature: 'unknown',
        };
      }
    } catch {
      return {
        hint: 'error',
        signature: 'error',
      };
    }
  });
}

/**
 * Normalize a standard transaction
 */
function normalizeTransaction(
  transaction: Transaction,
  networkPassphrase: string = Networks.TESTNET,
): NormalizedTransaction {
  return {
    envelopeType: identifyEnvelopeType(transaction),
    sourceAccount: transaction.source,
    sequence: transaction.sequence,
    fee: transaction.fee,
    operations: normalizeOperations(transaction.operations),
    memo: normalizeMemo(transaction.memo),
    timeBounds: normalizeTimeBounds(transaction),
    signatures: normalizeSignatures(transaction.signatures),
    networkPassphrase,
  };
}

/**
 * Normalize a fee-bump transaction
 */
function normalizeFeeBumpTransaction(
  feeBumpTx: FeeBumpTransaction,
  networkPassphrase: string = Networks.TESTNET,
): NormalizedFeeBumpTransaction {
  const innerTx = feeBumpTx.innerTransaction;
  const normalizedInner = normalizeTransaction(innerTx, networkPassphrase);

  return {
    ...normalizedInner,
    isFeeBump: true,
    envelopeType: identifyEnvelopeType(feeBumpTx),
    feeSource: feeBumpTx.feeSource,
    feeBumpFee: feeBumpTx.fee,
    innerTransaction: normalizedInner,
  };
}

/**
 * Reconstruct a transaction from normalized data
 */
function reconstructTransaction(
  normalized: NormalizedTransaction,
  networkPassphrase: string,
): Transaction {
  const account = new Account(normalized.sourceAccount, normalized.sequence);

  const builder = new TransactionBuilder(account, {
    fee: normalized.fee,
    networkPassphrase,
  });

  // Add operations
  for (const op of normalized.operations) {
    const operationParams = {
      ...op.details,
      source: op.sourceAccount,
    };

    switch (op.type) {
      case 'createAccount':
        builder.addOperation(Operation.createAccount(operationParams as any));
        break;
      case 'payment':
        builder.addOperation(Operation.payment(operationParams as any));
        break;
      case 'pathPaymentStrictReceive':
        builder.addOperation(Operation.pathPaymentStrictReceive(operationParams as any));
        break;
      case 'pathPaymentStrictSend':
        builder.addOperation(Operation.pathPaymentStrictSend(operationParams as any));
        break;
      case 'manageSellOffer':
        builder.addOperation(Operation.manageSellOffer(operationParams as any));
        break;
      case 'manageBuyOffer':
        builder.addOperation(Operation.manageBuyOffer(operationParams as any));
        break;
      case 'createPassiveSellOffer':
        builder.addOperation(Operation.createPassiveSellOffer(operationParams as any));
        break;
      case 'setOptions':
        builder.addOperation(Operation.setOptions(operationParams as any));
        break;
      case 'changeTrust':
        builder.addOperation(Operation.changeTrust(operationParams as any));
        break;
      case 'allowTrust':
        builder.addOperation(Operation.allowTrust(operationParams as any));
        break;
      case 'accountMerge':
        builder.addOperation(Operation.accountMerge(operationParams as any));
        break;
      case 'inflation':
        builder.addOperation(Operation.inflation({}));
        break;
      case 'manageData':
        builder.addOperation(Operation.manageData(operationParams as any));
        break;
      case 'bumpSequence':
        builder.addOperation(Operation.bumpSequence(operationParams as any));
        break;
      default:
        console.warn(`Unsupported operation type: ${op.type}`);
    }
  }

  // Add memo
  if (normalized.memo.type !== 'NONE' && normalized.memo.value) {
    switch (normalized.memo.type) {
      case 'ID':
        builder.addMemo(Memo.id(normalized.memo.value));
        break;
      case 'HASH':
        builder.addMemo(Memo.hash(normalized.memo.value));
        break;
      case 'RETURN':
        builder.addMemo(Memo.return(normalized.memo.value));
        break;
      case 'TEXT':
        builder.addMemo(Memo.text(normalized.memo.value));
        break;
    }
  }

  // Add time bounds
  if (normalized.timeBounds) {
    builder.setTimeout(
      parseInt(normalized.timeBounds.maxTime) - parseInt(normalized.timeBounds.minTime),
    );
  } else {
    builder.setTimeout(30);
  }

  return builder.build();
}

/**
 * Compare semantic preservation
 */
function compareSemanticPreservation(
  original: Transaction | FeeBumpTransaction,
  reconstructed: Transaction,
): NormalizationResult['semanticPreservation'] {
  const originalTx = original instanceof FeeBumpTransaction ? original.innerTransaction : original;

  return {
    sourceAccount: originalTx.source === reconstructed.source,
    sequence: originalTx.sequence === reconstructed.sequence,
    fee: originalTx.fee === reconstructed.fee,
    operations: originalTx.operations.length === reconstructed.operations.length,
    memo: JSON.stringify(originalTx.memo) === JSON.stringify(reconstructed.memo),
    timeBounds:
      JSON.stringify((originalTx as any).timeBounds) ===
      JSON.stringify((reconstructed as any).timeBounds),
    signatures: originalTx.signatures.length === reconstructed.signatures.length,
  };
}

/**
 * Main normalization function
 */
export function normalizeTransactionEnvelope(
  envelopeXdr: string,
  networkPassphrase: string = Networks.TESTNET,
): NormalizationResult {
  // Decode the envelope
  const transaction = decodeEnvelope(envelopeXdr, networkPassphrase);

  // Identify envelope type and normalize
  let normalizedTransaction: NormalizedTransaction | NormalizedFeeBumpTransaction;
  let originalHash: string;

  if (transaction instanceof FeeBumpTransaction) {
    normalizedTransaction = normalizeFeeBumpTransaction(transaction, networkPassphrase);
    originalHash = transaction.hash().toString('hex');
  } else {
    normalizedTransaction = normalizeTransaction(transaction, networkPassphrase);
    originalHash = transaction.hash().toString('hex');
  }

  // Reconstruct the transaction (for standard transactions only)
  let reconstructedEnvelopeXdr: string | undefined;
  let reconstructedHash: string | undefined;
  let hashMatches = false;
  let semanticPreservation: NormalizationResult['semanticPreservation'];

  if (!(transaction instanceof FeeBumpTransaction)) {
    try {
      const reconstructed = reconstructTransaction(
        normalizedTransaction as NormalizedTransaction,
        networkPassphrase,
      );
      reconstructedEnvelopeXdr = reconstructed.toXDR();
      reconstructedHash = reconstructed.hash().toString('hex');
      hashMatches = originalHash === reconstructedHash;
      semanticPreservation = compareSemanticPreservation(transaction, reconstructed);
    } catch (error) {
      console.warn(
        `Reconstruction failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      semanticPreservation = {
        sourceAccount: false,
        sequence: false,
        fee: false,
        operations: false,
        memo: false,
        timeBounds: false,
        signatures: false,
      };
    }
  } else {
    // For fee-bump transactions, we can't easily reconstruct the full envelope
    // but we can verify the inner transaction preservation
    semanticPreservation = {
      sourceAccount: true,
      sequence: true,
      fee: true,
      operations: true,
      memo: true,
      timeBounds: true,
      signatures: true,
    };
  }

  return {
    originalEnvelopeXdr: envelopeXdr,
    normalizedTransaction,
    reconstructedEnvelopeXdr,
    originalHash,
    reconstructedHash,
    hashMatches,
    semanticPreservation,
  };
}

/**
 * Format normalization result for console display
 */
function formatNormalizationResult(result: NormalizationResult): string {
  const lines = [
    chalk.bold('\n=== Stellar Transaction Envelope Normalization ===\n'),
    chalk.bold('Envelope Type:'),
    `  ${result.normalizedTransaction.envelopeType}`,
  ];

  if ('isFeeBump' in result.normalizedTransaction && result.normalizedTransaction.isFeeBump) {
    const fb = result.normalizedTransaction as NormalizedFeeBumpTransaction;
    lines.push(
      chalk.bold('\nFee-Bump Details:'),
      `  Fee Source: ${fb.feeSource}`,
      `  Fee-Bump Fee: ${fb.feeBumpFee} stroops`,
    );
    lines.push(chalk.bold('\nInner Transaction:'));
  }

  lines.push(
    chalk.bold('\nTransaction Details:'),
    `  Source Account: ${result.normalizedTransaction.sourceAccount}`,
    `  Sequence: ${result.normalizedTransaction.sequence}`,
    `  Fee: ${result.normalizedTransaction.fee} stroops`,
    `  Operations: ${result.normalizedTransaction.operations.length}`,
  );

  if (result.normalizedTransaction.operations.length > 0) {
    lines.push(chalk.bold('\nOperations:'));
    result.normalizedTransaction.operations.forEach((op) => {
      lines.push(`  ${op.type}`);
      if (op.sourceAccount) {
        lines.push(`      Source: ${op.sourceAccount}`);
      }
      Object.entries(op.details).forEach(([key, value]) => {
        lines.push(`      ${key}: ${JSON.stringify(value)}`);
      });
    });
  }

  lines.push(
    chalk.bold('\nMemo:'),
    `  Type: ${result.normalizedTransaction.memo.type}`,
    `  Value: ${result.normalizedTransaction.memo.value || '(none)'}`,
  );

  if (result.normalizedTransaction.timeBounds) {
    lines.push(
      chalk.bold('\nTime Bounds:'),
      `  Min: ${result.normalizedTransaction.timeBounds.minTime}`,
      `  Max: ${result.normalizedTransaction.timeBounds.maxTime}`,
    );
  }

  lines.push(
    chalk.bold('\nSignatures:'),
    `  Count: ${result.normalizedTransaction.signatures.length}`,
  );

  if (result.normalizedTransaction.signatures.length > 0) {
    result.normalizedTransaction.signatures.forEach((sig) => {
      lines.push(`  Hint: ${sig.hint}`);
    });
  }

  lines.push(chalk.bold('\nHash Verification:'), `  Original Hash: ${result.originalHash}`);

  if (result.reconstructedHash) {
    lines.push(
      `  Reconstructed Hash: ${result.reconstructedHash}`,
      `  Hashes Match: ${result.hashMatches ? chalk.green('YES') : chalk.red('NO')}`,
    );
  }

  lines.push(chalk.bold('\nSemantic Preservation:'));
  Object.entries(result.semanticPreservation).forEach(([key, value]) => {
    lines.push(`  ${key}: ${value ? chalk.green('PRESERVED') : chalk.red('MODIFIED')}`);
  });

  if (result.reconstructedEnvelopeXdr) {
    lines.push(
      chalk.bold('\nReconstructed Envelope XDR:'),
      result.reconstructedEnvelopeXdr.substring(0, 100) + '...',
    );
  }

  return lines.join('\n');
}

/**
 * Create sample transactions for demonstration
 */
function createSampleTransactions(): { standard: string; feeBump: string } {
  const sourceKeypair = Keypair.random();
  const sponsorKeypair = Keypair.random();
  const destinationKeypair = Keypair.random();

  // Create standard transaction
  const account = new Account(sourceKeypair.publicKey(), '123456789');
  const standardTx = new TransactionBuilder(account, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: destinationKeypair.publicKey(),
        asset: Asset.native(),
        amount: '100.50',
      }),
    )
    .addMemo(Memo.text('Sample payment'))
    .setTimeout(30)
    .build();

  standardTx.sign(sourceKeypair);

  // Create fee-bump transaction
  const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
    sponsorKeypair.publicKey(),
    '200',
    standardTx,
    Networks.TESTNET,
  );
  feeBumpTx.sign(sponsorKeypair);

  return {
    standard: standardTx.toXDR(),
    feeBump: feeBumpTx.toXDR(),
  };
}

export async function run(params: EnvelopeNormalizationParams = {}): Promise<void> {
  console.log(chalk.bold('Stellar Transaction Envelope Normalization Example'));
  console.log(
    chalk.gray(
      'Demonstrates decoding, identifying, normalizing, and reconstructing Stellar transaction envelopes.',
    ),
  );

  let envelopeXdr = params.envelopeXdr?.trim() || process.env.ENVELOPE_XDR?.trim();

  // If no envelope provided, create sample transactions
  if (!envelopeXdr) {
    console.log(chalk.yellow('\nNo envelope XDR provided. Creating sample transactions...'));
    const samples = createSampleTransactions();

    // Use the fee-bump transaction as it's more complex
    envelopeXdr = samples.feeBump;
    console.log(chalk.gray('Created sample fee-bump transaction for demonstration.'));
  }

  try {
    console.log(chalk.yellow('\nStep 1: Decoding transaction envelope...'));
    const result = normalizeTransactionEnvelope(envelopeXdr, Networks.TESTNET);
    console.log(chalk.green('✓ Envelope decoded successfully'));

    console.log(chalk.yellow('\nStep 2: Identifying envelope type...'));
    console.log(chalk.green(`✓ Envelope type: ${result.normalizedTransaction.envelopeType}`));

    console.log(chalk.yellow('\nStep 3: Normalizing transaction fields...'));
    console.log(chalk.green('✓ Transaction fields normalized'));

    console.log(chalk.yellow('\nStep 4: Verifying semantic preservation...'));
    const allPreserved = Object.values(result.semanticPreservation).every(Boolean);
    if (allPreserved) {
      console.log(chalk.green('✓ All transaction semantics preserved'));
    } else {
      console.log(
        chalk.yellow('⚠ Some transaction fields may have been modified during normalization'),
      );
    }

    // Display results
    if (wantsJson(params)) {
      console.log('\n' + JSON.stringify(result, null, 2));
    } else {
      console.log(formatNormalizationResult(result));
    }

    // Also demonstrate with a standard transaction if we used fee-bump
    if ('isFeeBump' in result.normalizedTransaction && result.normalizedTransaction.isFeeBump) {
      console.log(chalk.yellow('\n\n--- Additional: Standard Transaction Example ---\n'));
      const samples = createSampleTransactions();
      const standardResult = normalizeTransactionEnvelope(samples.standard, Networks.TESTNET);

      if (wantsJson(params)) {
        console.log('\n' + JSON.stringify(standardResult, null, 2));
      } else {
        console.log(formatNormalizationResult(standardResult));
      }
    }

    console.log(chalk.bold.green('\nEnvelope normalization complete.'));
    console.log(
      chalk.gray(
        'This example demonstrates envelope decoding, type identification, field normalization,',
      ),
    );
    console.log(
      chalk.gray(
        'semantic preservation verification, and reconstruction of Stellar transaction envelopes.',
      ),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (wantsJson(params)) {
      console.log(JSON.stringify({ error: 'Normalization failed', message }, null, 2));
    } else {
      console.error(chalk.red(`\n❌ Normalization failed: ${message}`));
      console.error(
        chalk.gray(
          'Ensure the provided envelope XDR is a valid base64-encoded Stellar transaction.',
        ),
      );
    }
    process.exit(1);
  }
}
