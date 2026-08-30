import { Account, Keypair, Memo, Networks, TransactionBuilder, xdr } from '@stellar/stellar-sdk';
import chalk from 'chalk';

/**
 * Stellar Transaction Memo Inspection Example
 *
 * Stellar transactions can include optional memos that applications use to attach
 * identifiers or additional context to payments. Exchanges, wallets, payment processors,
 * and accounting systems commonly rely on memos to associate transactions with users
 * or deposits.
 *
 * This example demonstrates:
 *   1. Constructing transactions with each memo type (Text, ID, Hash, Return)
 *   2. Decoding memos from existing transaction envelopes
 *   3. Validating memo values before transaction construction
 *   4. Validating memo size limits
 *   5. Converting user input into the correct memo type
 *   6. Handling invalid memo values gracefully
 *   7. Handling oversized text memos gracefully
 *   8. Explaining when each memo type should be used
 *   9. JSON output support
 *
 * Memo Types:
 *   - MemoText: UTF-8 string, max 28 bytes (commonly used for user IDs, references)
 *   - MemoID: 64-bit unsigned integer (used for numeric identifiers)
 *   - MemoHash: 32-byte hash (used for hash-based identifiers, often hex-encoded)
 *   - MemoReturn: 32-byte hash (used for payments expecting a return, often hex-encoded)
 */

export interface MemoInspectionParams {
  json?: boolean | string;
}

export interface MemoInfo {
  type: string;
  rawValue: string;
  decodedValue: string;
  encodedRepresentation: string;
  sizeBytes: number;
  valid: boolean;
  error?: string;
}

export interface MemoInspectionReport {
  memos: MemoInfo[];
  validationResults: {
    textMemo: { valid: boolean; maxSize: number; error?: string };
    idMemo: { valid: boolean; maxValue: string; error?: string };
    hashMemo: { valid: boolean; size: number; error?: string };
    returnMemo: { valid: boolean; size: number; error?: string };
  };
  usageGuidelines: string[];
}

// Memo size limits from Stellar protocol
const MEMO_TEXT_MAX_BYTES = 28;
const MEMO_HASH_SIZE = 32; // bytes
const MEMO_ID_MAX = BigInt('18446744073709551615'); // 2^64 - 1

function wantsJson(params: MemoInspectionParams): boolean {
  return (
    params.json === true ||
    params.json === 'true' ||
    process.env.JSON_OUTPUT === 'true' ||
    process.argv.includes('--json') ||
    process.argv.includes('--json=true')
  );
}

/**
 * Calculate byte length of a UTF-8 string
 */
function utf8ByteLength(str: string): number {
  return new Blob([str]).size;
}

/**
 * Validate and construct a MemoText
 */
function validateAndConstructTextMemo(value: string): MemoInfo {
  const byteLength = utf8ByteLength(value);

  if (byteLength === 0) {
    return {
      type: 'MemoText',
      rawValue: value,
      decodedValue: value,
      encodedRepresentation: '(empty)',
      sizeBytes: 0,
      valid: false,
      error: 'MemoText cannot be empty',
    };
  }

  if (byteLength > MEMO_TEXT_MAX_BYTES) {
    return {
      type: 'MemoText',
      rawValue: value,
      decodedValue: value,
      encodedRepresentation: '(oversized)',
      sizeBytes: byteLength,
      valid: false,
      error: `MemoText exceeds ${MEMO_TEXT_MAX_BYTES} byte limit (is ${byteLength} bytes)`,
    };
  }

  try {
    const memoXdr = xdr.Memo.memoText(Buffer.from(value, 'utf-8'));
    return {
      type: 'MemoText',
      rawValue: value,
      decodedValue: value,
      encodedRepresentation: memoXdr.toXDR('base64'),
      sizeBytes: byteLength,
      valid: true,
    };
  } catch (error) {
    return {
      type: 'MemoText',
      rawValue: value,
      decodedValue: value,
      encodedRepresentation: '(construction failed)',
      sizeBytes: byteLength,
      valid: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Validate and construct a MemoID
 */
function validateAndConstructIdMemo(value: string | number | bigint): MemoInfo {
  let numValue: bigint;

  try {
    if (typeof value === 'bigint') {
      numValue = value;
    } else if (typeof value === 'number') {
      if (!Number.isInteger(value) || value < 0) {
        return {
          type: 'MemoID',
          rawValue: String(value),
          decodedValue: String(value),
          encodedRepresentation: '(invalid)',
          sizeBytes: 8,
          valid: false,
          error: 'MemoID must be a non-negative integer',
        };
      }
      numValue = BigInt(value);
    } else {
      numValue = BigInt(value);
    }
  } catch {
    return {
      type: 'MemoID',
      rawValue: String(value),
      decodedValue: String(value),
      encodedRepresentation: '(invalid)',
      sizeBytes: 8,
      valid: false,
      error: 'MemoID must be a valid integer',
    };
  }

  if (numValue < 0) {
    return {
      type: 'MemoID',
      rawValue: String(value),
      decodedValue: String(value),
      encodedRepresentation: '(invalid)',
      sizeBytes: 8,
      valid: false,
      error: 'MemoID cannot be negative',
    };
  }

  if (numValue > MEMO_ID_MAX) {
    return {
      type: 'MemoID',
      rawValue: String(value),
      decodedValue: String(value),
      encodedRepresentation: '(overflow)',
      sizeBytes: 8,
      valid: false,
      error: `MemoID exceeds maximum value of ${MEMO_ID_MAX}`,
    };
  }

  try {
    const memoXdr = xdr.Memo.memoId(xdr.Uint64.fromString(numValue.toString()));
    return {
      type: 'MemoID',
      rawValue: String(value),
      decodedValue: numValue.toString(),
      encodedRepresentation: memoXdr.toXDR('base64'),
      sizeBytes: 8,
      valid: true,
    };
  } catch (error) {
    return {
      type: 'MemoID',
      rawValue: String(value),
      decodedValue: String(value),
      encodedRepresentation: '(construction failed)',
      sizeBytes: 8,
      valid: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Validate and construct a MemoHash from hex string
 */
function validateAndConstructHashMemo(hexValue: string): MemoInfo {
  // Remove 0x prefix if present
  const cleanHex = hexValue.startsWith('0x') ? hexValue.slice(2) : hexValue;

  if (cleanHex.length === 0) {
    return {
      type: 'MemoHash',
      rawValue: hexValue,
      decodedValue: cleanHex,
      encodedRepresentation: '(empty)',
      sizeBytes: 0,
      valid: false,
      error: 'MemoHash cannot be empty',
    };
  }

  // Validate hex format
  if (!/^[0-9a-fA-F]*$/.test(cleanHex)) {
    return {
      type: 'MemoHash',
      rawValue: hexValue,
      decodedValue: cleanHex,
      encodedRepresentation: '(invalid hex)',
      sizeBytes: cleanHex.length / 2,
      valid: false,
      error: 'MemoHash must be a valid hexadecimal string',
    };
  }

  const byteLength = cleanHex.length / 2;

  if (byteLength !== MEMO_HASH_SIZE) {
    return {
      type: 'MemoHash',
      rawValue: hexValue,
      decodedValue: cleanHex,
      encodedRepresentation: '(invalid size)',
      sizeBytes: byteLength,
      valid: false,
      error: `MemoHash must be exactly ${MEMO_HASH_SIZE} bytes (is ${byteLength} bytes)`,
    };
  }

  try {
    const memoXdr = xdr.Memo.memoHash(Buffer.from(cleanHex, 'hex'));
    return {
      type: 'MemoHash',
      rawValue: hexValue,
      decodedValue: cleanHex,
      encodedRepresentation: memoXdr.toXDR('base64'),
      sizeBytes: byteLength,
      valid: true,
    };
  } catch (error) {
    return {
      type: 'MemoHash',
      rawValue: hexValue,
      decodedValue: cleanHex,
      encodedRepresentation: '(construction failed)',
      sizeBytes: byteLength,
      valid: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Validate and construct a MemoReturn from hex string
 */
function validateAndConstructReturnMemo(hexValue: string): MemoInfo {
  // Remove 0x prefix if present
  const cleanHex = hexValue.startsWith('0x') ? hexValue.slice(2) : hexValue;

  if (cleanHex.length === 0) {
    return {
      type: 'MemoReturn',
      rawValue: hexValue,
      decodedValue: cleanHex,
      encodedRepresentation: '(empty)',
      sizeBytes: 0,
      valid: false,
      error: 'MemoReturn cannot be empty',
    };
  }

  // Validate hex format
  if (!/^[0-9a-fA-F]*$/.test(cleanHex)) {
    return {
      type: 'MemoReturn',
      rawValue: hexValue,
      decodedValue: cleanHex,
      encodedRepresentation: '(invalid hex)',
      sizeBytes: cleanHex.length / 2,
      valid: false,
      error: 'MemoReturn must be a valid hexadecimal string',
    };
  }

  const byteLength = cleanHex.length / 2;

  if (byteLength !== MEMO_HASH_SIZE) {
    return {
      type: 'MemoReturn',
      rawValue: hexValue,
      decodedValue: cleanHex,
      encodedRepresentation: '(invalid size)',
      sizeBytes: byteLength,
      valid: false,
      error: `MemoReturn must be exactly ${MEMO_HASH_SIZE} bytes (is ${byteLength} bytes)`,
    };
  }

  try {
    const memoXdr = xdr.Memo.memoReturn(Buffer.from(cleanHex, 'hex'));
    return {
      type: 'MemoReturn',
      rawValue: hexValue,
      decodedValue: cleanHex,
      encodedRepresentation: memoXdr.toXDR('base64'),
      sizeBytes: byteLength,
      valid: true,
    };
  } catch (error) {
    return {
      type: 'MemoReturn',
      rawValue: hexValue,
      decodedValue: cleanHex,
      encodedRepresentation: '(construction failed)',
      sizeBytes: byteLength,
      valid: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Convert user input to appropriate memo type
 */
function convertUserInputToMemo(input: string, type: string): MemoInfo {
  switch (type.toLowerCase()) {
    case 'text':
      return validateAndConstructTextMemo(input);
    case 'id':
      return validateAndConstructIdMemo(input);
    case 'hash':
      return validateAndConstructHashMemo(input);
    case 'return':
      return validateAndConstructReturnMemo(input);
    default:
      return {
        type: 'Unknown',
        rawValue: input,
        decodedValue: input,
        encodedRepresentation: '(invalid type)',
        sizeBytes: 0,
        valid: false,
        error: `Unknown memo type: ${type}`,
      };
  }
}

/**
 * Create a transaction with a memo
 */
function createTransactionWithMemo(memo: Memo): string {
  const keypair = Keypair.random();
  const account = new Account(keypair.publicKey(), '0');

  const transaction = new TransactionBuilder(account, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addMemo(memo)
    .setTimeout(30)
    .build();

  return transaction.toXDR();
}

/**
 * Format memo info for console display
 */
function formatMemoInfo(info: MemoInfo): string {
  const statusColor = info.valid ? chalk.green : chalk.red;
  const lines = [
    chalk.bold(`\n  ${info.type}`),
    `  Status: ${statusColor(info.valid ? 'VALID' : 'INVALID')}`,
    `  Raw value: ${info.rawValue}`,
    `  Decoded value: ${info.decodedValue}`,
    `  Size: ${info.sizeBytes} bytes`,
  ];

  if (info.valid) {
    lines.push(`  Encoded (base64): ${info.encodedRepresentation.substring(0, 50)}...`);
  } else {
    lines.push(chalk.red(`  Error: ${info.error}`));
  }

  return lines.join('\n');
}

/**
 * Format the full inspection report for console display
 */
function formatInspectionReport(report: MemoInspectionReport): string {
  const lines = [
    chalk.bold('\n=== Stellar Transaction Memo Inspection Report ===\n'),
    chalk.bold('Memo Type Demonstrations:'),
  ];

  for (const memo of report.memos) {
    lines.push(formatMemoInfo(memo));
  }

  lines.push(chalk.bold('\nValidation Results:'));
  lines.push(
    `  MemoText: ${report.validationResults.textMemo.valid ? chalk.green('VALID') : chalk.red('INVALID')}`,
  );
  lines.push(`    Max size: ${report.validationResults.textMemo.maxSize} bytes`);
  if (report.validationResults.textMemo.error) {
    lines.push(chalk.red(`    Error: ${report.validationResults.textMemo.error}`));
  }

  lines.push(
    `  MemoID: ${report.validationResults.idMemo.valid ? chalk.green('VALID') : chalk.red('INVALID')}`,
  );
  lines.push(`    Max value: ${report.validationResults.idMemo.maxValue}`);
  if (report.validationResults.idMemo.error) {
    lines.push(chalk.red(`    Error: ${report.validationResults.idMemo.error}`));
  }

  lines.push(
    `  MemoHash: ${report.validationResults.hashMemo.valid ? chalk.green('VALID') : chalk.red('INVALID')}`,
  );
  lines.push(`    Required size: ${report.validationResults.hashMemo.size} bytes`);
  if (report.validationResults.hashMemo.error) {
    lines.push(chalk.red(`    Error: ${report.validationResults.hashMemo.error}`));
  }

  lines.push(
    `  MemoReturn: ${report.validationResults.returnMemo.valid ? chalk.green('VALID') : chalk.red('INVALID')}`,
  );
  lines.push(`    Required size: ${report.validationResults.returnMemo.size} bytes`);
  if (report.validationResults.returnMemo.error) {
    lines.push(chalk.red(`    Error: ${report.validationResults.returnMemo.error}`));
  }

  lines.push(chalk.bold('\nUsage Guidelines:'));
  for (const guideline of report.usageGuidelines) {
    lines.push(`  - ${guideline}`);
  }

  return lines.join('\n');
}

export async function run(params: MemoInspectionParams = {}): Promise<void> {
  console.log(chalk.bold('Stellar Transaction Memo Inspection Example'));
  console.log(
    chalk.gray(
      'Demonstrates construction, inspection, decoding, and validation of Stellar transaction memos.',
    ),
  );

  const report: MemoInspectionReport = {
    memos: [],
    validationResults: {
      textMemo: { valid: true, maxSize: MEMO_TEXT_MAX_BYTES },
      idMemo: { valid: true, maxValue: MEMO_ID_MAX.toString() },
      hashMemo: { valid: true, size: MEMO_HASH_SIZE },
      returnMemo: { valid: true, size: MEMO_HASH_SIZE },
    },
    usageGuidelines: [
      'MemoText: Use for human-readable identifiers like user IDs, invoice numbers, or short references (max 28 UTF-8 bytes)',
      'MemoID: Use for numeric identifiers when you need a compact 64-bit unsigned integer representation',
      'MemoHash: Use for hash-based identifiers (32 bytes), often for referencing external systems or cryptographic commitments',
      'MemoReturn: Use for payments expecting a return (32 bytes), similar to MemoHash but semantically distinct for return payments',
      'MemoNone: Use when no memo is needed (default)',
      'Always validate memo size limits before constructing transactions to avoid submission failures',
      'Exchanges and payment processors typically require memos to associate deposits with user accounts',
    ],
  };

  // ──────────────────────────────────────────────────────────────────────────
  // Step 1: Demonstrate valid memo constructions
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 1: Constructing valid memos of each type...'));

  // Valid MemoText
  const validTextMemo = validateAndConstructTextMemo('REF-12345');
  report.memos.push(validTextMemo);
  console.log(chalk.green('✓ MemoText: REF-12345'));

  // Valid MemoID
  const validIdMemo = validateAndConstructIdMemo(123456789);
  report.memos.push(validIdMemo);
  console.log(chalk.green('✓ MemoID: 123456789'));

  // Valid MemoHash (32 bytes = 64 hex chars)
  const validHash = '0'.repeat(64);
  const validHashMemo = validateAndConstructHashMemo(validHash);
  report.memos.push(validHashMemo);
  console.log(chalk.green('✓ MemoHash: 64 hex characters (32 bytes)'));

  // Valid MemoReturn (32 bytes = 64 hex chars)
  const validReturn = 'f'.repeat(64);
  const validReturnMemo = validateAndConstructReturnMemo(validReturn);
  report.memos.push(validReturnMemo);
  console.log(chalk.green('✓ MemoReturn: 64 hex characters (32 bytes)'));

  // ──────────────────────────────────────────────────────────────────────────
  // Step 2: Demonstrate invalid memo handling
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 2: Demonstrating invalid memo handling...'));

  // Oversized MemoText
  const oversizedText = 'A'.repeat(29); // 29 bytes exceeds 28 byte limit
  const oversizedMemo = validateAndConstructTextMemo(oversizedText);
  report.memos.push(oversizedMemo);
  console.log(chalk.red('✗ MemoText: 29 characters (exceeds 28 byte limit)'));
  if (!oversizedMemo.valid) {
    report.validationResults.textMemo.valid = false;
    report.validationResults.textMemo.error = oversizedMemo.error;
  }

  // Invalid MemoID (negative)
  const invalidIdMemo = validateAndConstructIdMemo(-1);
  report.memos.push(invalidIdMemo);
  console.log(chalk.red('✗ MemoID: -1 (negative values not allowed)'));
  if (!invalidIdMemo.valid) {
    report.validationResults.idMemo.valid = false;
    report.validationResults.idMemo.error = invalidIdMemo.error;
  }

  // Invalid MemoHash (wrong size)
  const invalidHash = 'abcd'; // Only 2 bytes instead of 32
  const invalidHashMemo = validateAndConstructHashMemo(invalidHash);
  report.memos.push(invalidHashMemo);
  console.log(chalk.red('✗ MemoHash: 4 hex characters (2 bytes, must be 32 bytes)'));
  if (!invalidHashMemo.valid) {
    report.validationResults.hashMemo.valid = false;
    report.validationResults.hashMemo.error = invalidHashMemo.error;
  }

  // Invalid MemoReturn (non-hex)
  const invalidReturnMemo = validateAndConstructReturnMemo('not-hex!!');
  report.memos.push(invalidReturnMemo);
  console.log(chalk.red('✗ MemoReturn: "not-hex!!" (invalid hexadecimal)'));
  if (!invalidReturnMemo.valid) {
    report.validationResults.returnMemo.valid = false;
    report.validationResults.returnMemo.error = invalidReturnMemo.error;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 3: Create transactions with memos
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 3: Creating transactions with memos...'));

  const textMemo = Memo.text('PAYMENT-REF-001');
  const txWithTextMemo = createTransactionWithMemo(textMemo);
  console.log(chalk.green('✓ Transaction created with MemoText'));

  const idMemo = Memo.id('9876543210');
  const txWithIdMemo = createTransactionWithMemo(idMemo);
  console.log(chalk.green('✓ Transaction created with MemoID'));

  const hashMemo = Memo.hash('0'.repeat(64));
  const txWithHashMemo = createTransactionWithMemo(hashMemo);
  console.log(chalk.green('✓ Transaction created with MemoHash'));

  const returnMemo = Memo.return('a'.repeat(64));
  const txWithReturnMemo = createTransactionWithMemo(returnMemo);
  console.log(chalk.green('✓ Transaction created with MemoReturn'));

  // ──────────────────────────────────────────────────────────────────────────
  // Step 4: Decode memos from transaction envelopes
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 4: Decoding memos from transaction envelopes...'));

  const parsedTextTx = TransactionBuilder.fromXDR(txWithTextMemo, Networks.TESTNET) as any;
  const textMemoFromTx = parsedTextTx.memo;
  const textValue = textMemoFromTx.value;
  const textEncoded = Buffer.isBuffer(textValue)
    ? textValue.toString('hex')
    : String(textValue ?? '');
  console.log(chalk.green(`✓ Decoded from transaction: ${textMemoFromTx.type} = "${textEncoded}"`));

  const parsedIdTx = TransactionBuilder.fromXDR(txWithIdMemo, Networks.TESTNET) as any;
  const idMemoFromTx = parsedIdTx.memo;
  const idValue = idMemoFromTx.value;
  const idEncoded = Buffer.isBuffer(idValue) ? idValue.toString('hex') : String(idValue ?? '');
  console.log(chalk.green(`✓ Decoded from transaction: ${idMemoFromTx.type} = "${idEncoded}"`));

  const parsedHashTx = TransactionBuilder.fromXDR(txWithHashMemo, Networks.TESTNET) as any;
  const hashMemoFromTx = parsedHashTx.memo;
  const hashValue = hashMemoFromTx.value;
  const hashEncoded = Buffer.isBuffer(hashValue)
    ? hashValue.toString('hex')
    : String(hashValue ?? '');
  console.log(chalk.green(`✓ Decoded from transaction: ${hashMemoFromTx.type} = "${hashEncoded}"`));

  const parsedReturnTx = TransactionBuilder.fromXDR(txWithReturnMemo, Networks.TESTNET) as any;
  const returnMemoFromTx = parsedReturnTx.memo;
  const returnValue = returnMemoFromTx.value;
  const returnEncoded = Buffer.isBuffer(returnValue)
    ? returnValue.toString('hex')
    : String(returnValue ?? '');
  console.log(
    chalk.green(`✓ Decoded from transaction: ${returnMemoFromTx.type} = "${returnEncoded}"`),
  );

  // ──────────────────────────────────────────────────────────────────────────
  // Step 5: Demonstrate user input conversion
  // ──────────────────────────────────────────────────────────────────────────
  console.log(chalk.yellow('\nStep 5: Converting user input to memo types...'));

  const userInput = '12345';
  const asText = convertUserInputToMemo(userInput, 'text');
  const asId = convertUserInputToMemo(userInput, 'id');
  console.log(
    chalk.green(`✓ Input "${userInput}" as MemoText: ${asText.valid ? 'valid' : 'invalid'}`),
  );
  console.log(chalk.green(`✓ Input "${userInput}" as MemoID: ${asId.valid ? 'valid' : 'invalid'}`));

  // ──────────────────────────────────────────────────────────────────────────
  // Step 6: Display comprehensive report
  // ──────────────────────────────────────────────────────────────────────────
  if (wantsJson(params)) {
    console.log('\n' + JSON.stringify(report, null, 2));
  } else {
    console.log(formatInspectionReport(report));
  }

  console.log(chalk.bold.green('\nMemo inspection complete.'));
  console.log(
    chalk.gray(
      'This example demonstrates all memo types, validation, decoding, and best practices for using memos in Stellar transactions.',
    ),
  );
}
