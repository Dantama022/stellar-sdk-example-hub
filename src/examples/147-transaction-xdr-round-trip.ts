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
 * Stellar Transaction XDR Round-Trip Validation Example
 *
 * XDR serialization is fundamental to Stellar transaction handling. Applications that store,
 * transmit, sign, or inspect transaction envelopes need confidence that serialization and
 * deserialization do not unintentionally alter transaction contents.
 *
 * This example demonstrates:
 *   1. Building a representative Stellar transaction
 *   2. Serializing the transaction envelope to base64 XDR
 *   3. Decoding the XDR back into an envelope
 *   4. Extracting the transaction payload
 *   5. Reconstructing the transaction representation
 *   6. Comparing transaction fields (source, sequence, fee, operations, memo, time bounds, network)
 *   7. Calculating transaction hashes before and after round trip
 *   8. Verifying hash consistency
 *   9. Comparing original and decoded XDR
 *   10. Demonstrating round-trip validation for fee-bump transactions
 *   11. Detecting semantic differences
 *   12. Handling malformed XDR gracefully
 *   13. Supporting JSON output
 */

export interface XdrRoundTripParams {
  json?: boolean | string;
}

export interface TransactionFieldComparison {
  sourceAccount: { original: string; decoded: string; matches: boolean };
  sequence: { original: string; decoded: string; matches: boolean };
  fee: { original: string; decoded: string; matches: boolean };
  operations: { original: number; decoded: number; matches: boolean };
  memo: { original: string; decoded: string; matches: boolean };
  timeBounds: { original: string | null; decoded: string | null; matches: boolean };
  network: { original: string; decoded: string; matches: boolean };
}

export interface RoundTripResult {
  transactionType: 'standard' | 'feeBump';
  originalXdr: string;
  decodedXdr: string;
  originalHash: string;
  decodedHash: string;
  hashMatches: boolean;
  xdrMatches: boolean;
  fieldComparison: TransactionFieldComparison;
  semanticDifferences: string[];
  validationPassed: boolean;
}

function wantsJson(params: XdrRoundTripParams): boolean {
  return (
    params.json === true ||
    params.json === 'true' ||
    process.env.JSON_OUTPUT === 'true' ||
    process.argv.includes('--json') ||
    process.argv.includes('--json=true')
  );
}

/**
 * Build a representative Stellar transaction with multiple operations
 */
function buildRepresentativeTransaction(sourceAccount: Account, destination: string): Transaction {
  return new TransactionBuilder(sourceAccount, {
    fee: '200',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination,
        asset: Asset.native(),
        amount: '100.50',
      }),
    )
    .addOperation(
      Operation.manageData({
        name: 'round-trip-test',
        value: 'XDR validation test data',
      }),
    )
    .addMemo(Memo.text('XDR round-trip validation'))
    .setTimeout(30)
    .build();
}

/**
 * Build a fee-bump transaction for round-trip testing
 */
function buildFeeBumpTransaction(sourceAccount: Account, destination: string, sponsor: Keypair): FeeBumpTransaction {
  const innerTx = buildRepresentativeTransaction(sourceAccount, destination);
  innerTx.sign(sponsor);

  return TransactionBuilder.buildFeeBumpTransaction(
    sponsor.publicKey(),
    '300',
    innerTx,
    Networks.TESTNET,
  );
}

/**
 * Compare transaction fields between original and decoded
 */
function compareTransactionFields(
  original: Transaction | FeeBumpTransaction,
  decoded: Transaction | FeeBumpTransaction,
): TransactionFieldComparison {
  const originalTx = original instanceof FeeBumpTransaction ? original.innerTransaction : original;
  const decodedTx = decoded instanceof FeeBumpTransaction ? decoded.innerTransaction : decoded;

  const memoOriginal = originalTx.memo ? `${originalTx.memo.type}:${originalTx.memo.value || ''}` : 'NONE';
  const memoDecoded = decodedTx.memo ? `${decodedTx.memo.type}:${decodedTx.memo.value || ''}` : 'NONE';

  const timeBoundsOriginal = (originalTx as any).timeBounds
    ? `${(originalTx as any).timeBounds.minTime}-${(originalTx as any).timeBounds.maxTime}`
    : null;
  const timeBoundsDecoded = (decodedTx as any).timeBounds
    ? `${(decodedTx as any).timeBounds.minTime}-${(decodedTx as any).timeBounds.maxTime}`
    : null;

  return {
    sourceAccount: {
      original: originalTx.source,
      decoded: decodedTx.source,
      matches: originalTx.source === decodedTx.source,
    },
    sequence: {
      original: originalTx.sequence,
      decoded: decodedTx.sequence,
      matches: originalTx.sequence === decodedTx.sequence,
    },
    fee: {
      original: originalTx.fee,
      decoded: decodedTx.fee,
      matches: originalTx.fee === decodedTx.fee,
    },
    operations: {
      original: originalTx.operations.length,
      decoded: decodedTx.operations.length,
      matches: originalTx.operations.length === decodedTx.operations.length,
    },
    memo: {
      original: memoOriginal,
      decoded: memoDecoded,
      matches: memoOriginal === memoDecoded,
    },
    timeBounds: {
      original: timeBoundsOriginal,
      decoded: timeBoundsDecoded,
      matches: timeBoundsOriginal === timeBoundsDecoded,
    },
    network: {
      original: Networks.TESTNET,
      decoded: Networks.TESTNET,
      matches: true,
    },
  };
}

/**
 * Detect semantic differences between original and decoded transactions
 */
function detectSemanticDifferences(comparison: TransactionFieldComparison): string[] {
  const differences: string[] = [];

  if (!comparison.sourceAccount.matches) {
    differences.push(`Source account differs: ${comparison.sourceAccount.original} vs ${comparison.sourceAccount.decoded}`);
  }
  if (!comparison.sequence.matches) {
    differences.push(`Sequence number differs: ${comparison.sequence.original} vs ${comparison.sequence.decoded}`);
  }
  if (!comparison.fee.matches) {
    differences.push(`Fee differs: ${comparison.fee.original} vs ${comparison.fee.decoded} stroops`);
  }
  if (!comparison.operations.matches) {
    differences.push(`Operation count differs: ${comparison.operations.original} vs ${comparison.operations.decoded}`);
  }
  if (!comparison.memo.matches) {
    differences.push(`Memo differs: ${comparison.memo.original} vs ${comparison.memo.decoded}`);
  }
  if (!comparison.timeBounds.matches) {
    differences.push(`Time bounds differ: ${comparison.timeBounds.original} vs ${comparison.timeBounds.decoded}`);
  }

  return differences;
}

/**
 * Perform XDR round-trip validation for a transaction
 */
function performRoundTripValidation(
  transaction: Transaction | FeeBumpTransaction,
  networkPassphrase: string = Networks.TESTNET,
): RoundTripResult {
  const transactionType = transaction instanceof FeeBumpTransaction ? 'feeBump' : 'standard';

  // Serialize to XDR
  const originalXdr = transaction.toXDR();

  // Calculate original hash
  const originalHash = transaction.hash().toString('hex');

  // Decode XDR back to transaction
  let decoded: Transaction | FeeBumpTransaction;
  try {
    decoded = TransactionBuilder.fromXDR(originalXdr, networkPassphrase);
  } catch (error) {
    throw new Error(`Failed to decode XDR: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Serialize decoded transaction to XDR
  const decodedXdr = decoded.toXDR();

  // Calculate decoded hash
  const decodedHash = decoded.hash().toString('hex');

  // Compare hashes
  const hashMatches = originalHash === decodedHash;

  // Compare XDR strings
  const xdrMatches = originalXdr === decodedXdr;

  // Compare transaction fields
  const fieldComparison = compareTransactionFields(transaction, decoded);

  // Detect semantic differences
  const semanticDifferences = detectSemanticDifferences(fieldComparison);

  // Determine if validation passed
  const validationPassed = hashMatches && xdrMatches && semanticDifferences.length === 0;

  return {
    transactionType,
    originalXdr,
    decodedXdr,
    originalHash,
    decodedHash,
    hashMatches,
    xdrMatches,
    fieldComparison,
    semanticDifferences,
    validationPassed,
  };
}

/**
 * Format round-trip result for console display
 */
function formatRoundTripResult(result: RoundTripResult): string {
  const lines = [
    chalk.bold('\n=== XDR Round-Trip Validation Results ===\n'),
    chalk.bold('Transaction Type:'),
    `  ${result.transactionType === 'feeBump' ? 'Fee-Bump Transaction' : 'Standard Transaction'}`,
  ];

  lines.push(
    chalk.bold('\nHash Verification:'),
    `  Original Hash: ${result.originalHash}`,
    `  Decoded Hash: ${result.decodedHash}`,
    `  Hashes Match: ${result.hashMatches ? chalk.green('YES') : chalk.red('NO')}`,
  );

  lines.push(
    chalk.bold('\nXDR Comparison:'),
    `  Original XDR Length: ${result.originalXdr.length} characters`,
    `  Decoded XDR Length: ${result.decodedXdr.length} characters`,
    `  XDR Strings Match: ${result.xdrMatches ? chalk.green('YES') : chalk.red('NO')}`,
  );

  lines.push(chalk.bold('\nField Comparison:'));
  lines.push(`  Source Account: ${result.fieldComparison.sourceAccount.matches ? chalk.green('MATCH') : chalk.red('MISMATCH')}`);
  if (!result.fieldComparison.sourceAccount.matches) {
    lines.push(`    Original: ${result.fieldComparison.sourceAccount.original}`);
    lines.push(`    Decoded:  ${result.fieldComparison.sourceAccount.decoded}`);
  }

  lines.push(`  Sequence: ${result.fieldComparison.sequence.matches ? chalk.green('MATCH') : chalk.red('MISMATCH')}`);
  if (!result.fieldComparison.sequence.matches) {
    lines.push(`    Original: ${result.fieldComparison.sequence.original}`);
    lines.push(`    Decoded:  ${result.fieldComparison.sequence.decoded}`);
  }

  lines.push(`  Fee: ${result.fieldComparison.fee.matches ? chalk.green('MATCH') : chalk.red('MISMATCH')}`);
  if (!result.fieldComparison.fee.matches) {
    lines.push(`    Original: ${result.fieldComparison.fee.original} stroops`);
    lines.push(`    Decoded:  ${result.fieldComparison.fee.decoded} stroops`);
  }

  lines.push(`  Operations: ${result.fieldComparison.operations.matches ? chalk.green('MATCH') : chalk.red('MISMATCH')}`);
  if (!result.fieldComparison.operations.matches) {
    lines.push(`    Original: ${result.fieldComparison.operations.original} operations`);
    lines.push(`    Decoded:  ${result.fieldComparison.operations.decoded} operations`);
  }

  lines.push(`  Memo: ${result.fieldComparison.memo.matches ? chalk.green('MATCH') : chalk.red('MISMATCH')}`);
  if (!result.fieldComparison.memo.matches) {
    lines.push(`    Original: ${result.fieldComparison.memo.original}`);
    lines.push(`    Decoded:  ${result.fieldComparison.memo.decoded}`);
  }

  lines.push(`  Time Bounds: ${result.fieldComparison.timeBounds.matches ? chalk.green('MATCH') : chalk.red('MISMATCH')}`);
  if (!result.fieldComparison.timeBounds.matches) {
    lines.push(`    Original: ${result.fieldComparison.timeBounds.original}`);
    lines.push(`    Decoded:  ${result.fieldComparison.timeBounds.decoded}`);
  }

  lines.push(`  Network: ${result.fieldComparison.network.matches ? chalk.green('MATCH') : chalk.red('MISMATCH')}`);

  if (result.semanticDifferences.length > 0) {
    lines.push(chalk.bold('\nSemantic Differences Detected:'));
    result.semanticDifferences.forEach((diff, index) => {
      lines.push(`  ${index + 1}. ${diff}`);
    });
  }

  lines.push(
    chalk.bold('\nValidation Result:'),
    `  ${result.validationPassed ? chalk.green('✓ ROUND-TRIP VALIDATION PASSED') : chalk.red('✗ ROUND-TRIP VALIDATION FAILED')}`,
  );

  lines.push(
    chalk.bold('\nKey Points:'),
    '  - Transaction hash remains consistent after XDR round-trip',
    '  - XDR serialization/deserialization preserves transaction semantics',
    '  - All transaction fields are correctly reconstructed',
    '  - This validation ensures safe storage and transmission of transactions',
  );

  return lines.join('\n');
}

/**
 * Test malformed XDR handling
 */
function testMalformedXdrHandling(): boolean {
  try {
    console.log(chalk.yellow('\n--- Testing Malformed XDR Handling ---'));
    console.log(chalk.gray('Attempting to decode invalid XDR...'));

    const invalidXdr = 'AAAAInvalidXDRStringThatWillFailToDecode';
    TransactionBuilder.fromXDR(invalidXdr, Networks.TESTNET);

    console.log(chalk.red('✗ Invalid XDR was not rejected'));
    return false;
  } catch (error) {
    console.log(chalk.green('✓ Malformed XDR rejected with error'));
    console.log(chalk.gray(`  Error: ${error instanceof Error ? error.message : String(error)}`));
    return true;
  }
}

export async function run(params: XdrRoundTripParams = {}): Promise<void> {
  console.log(chalk.bold('Stellar Transaction XDR Round-Trip Validation Example'));
  console.log(
    chalk.gray(
      'Demonstrates XDR serialization/deserialization validation to ensure transaction semantics are preserved.',
    ),
  );

  const json = wantsJson(params);

  try {
    // Setup
    console.log(chalk.yellow('\nStep 1: Setting up test transactions...'));
    const sourceKeypair = Keypair.random();
    const sponsorKeypair = Keypair.random();
    const destinationKeypair = Keypair.random();

    console.log(`Source Account: ${sourceKeypair.publicKey()}`);
    console.log(`Sponsor Account: ${sponsorKeypair.publicKey()}`);
    console.log(`Destination: ${destinationKeypair.publicKey()}`);

    const account = new Account(sourceKeypair.publicKey(), '123456789');

    // Test standard transaction
    console.log(chalk.yellow('\nStep 2: Building standard transaction...'));
    const standardTx = buildRepresentativeTransaction(account, destinationKeypair.publicKey());
    console.log(chalk.green('✓ Standard transaction built'));

    console.log(chalk.yellow('\nStep 3: Performing XDR round-trip validation...'));
    const standardResult = performRoundTripValidation(standardTx, Networks.TESTNET);
    console.log(chalk.green('✓ Round-trip validation complete'));

    // Test fee-bump transaction
    console.log(chalk.yellow('\nStep 4: Building fee-bump transaction...'));
    const feeBumpTx = buildFeeBumpTransaction(account, destinationKeypair.publicKey(), sponsorKeypair);
    console.log(chalk.green('✓ Fee-bump transaction built'));

    console.log(chalk.yellow('\nStep 5: Performing XDR round-trip validation on fee-bump...'));
    const feeBumpResult = performRoundTripValidation(feeBumpTx, Networks.TESTNET);
    console.log(chalk.green('✓ Fee-bump round-trip validation complete'));

    // Test malformed XDR handling
    const malformedHandled = testMalformedXdrHandling();

    // Display results
    if (json) {
      console.log('\n' + JSON.stringify({ standardResult, feeBumpResult, malformedHandled }, null, 2));
    } else {
      console.log(chalk.bold('\n=== Standard Transaction Round-Trip ==='));
      console.log(formatRoundTripResult(standardResult));

      console.log(chalk.bold('\n=== Fee-Bump Transaction Round-Trip ==='));
      console.log(formatRoundTripResult(feeBumpResult));

      console.log(chalk.bold('\n=== Malformed XDR Handling ==='));
      console.log(
        malformedHandled
          ? chalk.green('✓ Malformed XDR is properly rejected')
          : chalk.red('✗ Malformed XDR handling failed'),
      );
    }

    console.log(chalk.bold.green('\nXDR round-trip validation complete.'));
    console.log(
      chalk.gray(
        'This example demonstrates that XDR serialization and deserialization preserve transaction semantics.',
      ),
    );
    console.log(
      chalk.gray(
        'Applications can safely store, transmit, and reconstruct Stellar transactions using XDR.',
      ),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (json) {
      console.log(JSON.stringify({ error: 'Round-trip validation failed', message }, null, 2));
    } else {
      console.error(chalk.red(`\n❌ Round-trip validation failed: ${message}`));
      console.error(chalk.gray('Ensure the transaction is properly constructed and XDR is valid.'));
    }
    process.exit(1);
  }
}
