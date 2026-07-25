import { Horizon, Networks, TransactionBuilder, xdr } from '@stellar/stellar-sdk';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const TRANSACTION_HASH_PATTERN = /^[0-9a-fA-F]{64}$/;

export interface TransactionInspectionParams {
  transactionHash?: string;
}

/**
 * Horizon's SDK response parser converts links into callable functions.
 *
 * Transaction records contain both:
 * - A numeric `ledger` response field
 * - A `_links.ledger` Horizon link
 *
 * When those names collide, the SDK stores the original numeric value as
 * `ledger_attr` and replaces `ledger` with the link function.
 */
export interface HorizonTransactionRecordLike {
  id: string;
  hash: string;
  successful: boolean;
  ledger: number | string | (() => Promise<unknown>);
  ledger_attr?: number | string;
  created_at: string;
  source_account: string;
  source_account_sequence: string;
  fee_charged: string | number;
  max_fee: string | number;
  operation_count: number;
  memo_type: string;
  memo?: string;
  envelope_xdr: string;
  result_xdr: string;
  result_meta_xdr?: string;
  fee_meta_xdr?: string;
}

export interface TransactionInspectionSummary {
  hash: string;
  sourceAccount: string;
  sourceSequence: string;
  feeCharged: string;
  maximumFee: string;
  operationCount: number;
  ledger: number;
  createdAt: string;
  successful: boolean;
  statusLabel: 'SUCCESS' | 'FAILED';
  resultCode: string;
  memoType: string;
  memoValue: string | null;
  envelopeXdr: string;
  resultXdr: string;
  resultMetaXdr: string | null;
  feeMetaXdr: string | null;
}

interface UnknownRecord {
  [key: string]: unknown;
}

/**
 * Checks whether an unknown value is a non-null object.
 */
function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null;
}

/**
 * Validates a Stellar transaction hash.
 *
 * Stellar transaction hashes are 32-byte SHA-256 hashes represented by
 * exactly 64 hexadecimal characters.
 */
export function isValidTransactionHash(hash: string): boolean {
  return TRANSACTION_HASH_PATTERN.test(hash);
}

/**
 * Normalizes an XDR enum name such as txSuccess into the Horizon-style
 * result-code form tx_success.
 */
export function normalizeResultCodeName(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/**
 * Reads the original numeric ledger sequence from a Horizon transaction.
 *
 * The SDK normally stores it in ledger_attr because the `_links.ledger`
 * function occupies the ledger property. The ordinary ledger property is
 * retained as a fallback for raw or mocked Horizon records.
 */
export function getLedgerSequence(record: HorizonTransactionRecordLike): number {
  const ledgerValue = record.ledger_attr ?? record.ledger;

  if (typeof ledgerValue === 'number' && Number.isInteger(ledgerValue) && ledgerValue >= 0) {
    return ledgerValue;
  }

  if (typeof ledgerValue === 'string' && /^\d+$/.test(ledgerValue)) {
    const parsedLedger = Number(ledgerValue);

    if (Number.isSafeInteger(parsedLedger)) {
      return parsedLedger;
    }
  }

  throw new Error('Horizon returned an invalid ledger sequence for this transaction.');
}

/**
 * Decodes the transaction-level result code stored in result_xdr.
 *
 * Common transaction-level values include:
 * - tx_success
 * - tx_failed
 * - tx_bad_seq
 * - tx_bad_auth
 * - tx_insufficient_fee
 *
 * If decoding is unavailable, the successful field still provides a clear
 * success or failure state.
 */
export function decodeTransactionResultCode(resultXdr: string, successful: boolean): string {
  try {
    const transactionResult = xdr.TransactionResult.fromXDR(resultXdr, 'base64');

    const resultSwitch = transactionResult.result().switch() as unknown;

    if (isRecord(resultSwitch) && typeof resultSwitch.name === 'string') {
      return normalizeResultCodeName(resultSwitch.name);
    }

    return successful ? 'tx_success' : 'tx_failed';
  } catch {
    return successful ? 'tx_success' : 'tx_failed';
  }
}

/**
 * Extracts an HTTP status code from different error shapes that may be
 * returned by Horizon transports.
 */
export function getHorizonStatusCode(error: unknown): number | null {
  if (!isRecord(error)) {
    return null;
  }

  if (typeof error.status === 'number') {
    return error.status;
  }

  if (typeof error.statusCode === 'number') {
    return error.statusCode;
  }

  if (!isRecord(error.response)) {
    return null;
  }

  if (typeof error.response.status === 'number') {
    return error.response.status;
  }

  if (typeof error.response.statusCode === 'number') {
    return error.response.statusCode;
  }

  return null;
}

/**
 * Detects the NotFoundError produced by the Stellar SDK for Horizon 404
 * responses.
 */
export function isHorizonNotFoundError(error: unknown): boolean {
  if (error instanceof Error && error.name === 'NotFoundError') {
    return true;
  }

  return getHorizonStatusCode(error) === 404;
}

/**
 * Returns a readable message for an unknown caught value.
 */
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Converts a Horizon transaction record into a smaller, structured summary.
 */
export function createTransactionSummary(
  record: HorizonTransactionRecordLike,
): TransactionInspectionSummary {
  return {
    hash: record.hash,
    sourceAccount: record.source_account,
    sourceSequence: record.source_account_sequence,
    feeCharged: String(record.fee_charged),
    maximumFee: String(record.max_fee),
    operationCount: record.operation_count,
    ledger: getLedgerSequence(record),
    createdAt: record.created_at,
    successful: record.successful,
    statusLabel: record.successful ? 'SUCCESS' : 'FAILED',
    resultCode: decodeTransactionResultCode(record.result_xdr, record.successful),
    memoType: record.memo_type,
    memoValue:
      record.memo_type === 'none' || record.memo === undefined || record.memo.length === 0
        ? null
        : record.memo,
    envelopeXdr: record.envelope_xdr,
    resultXdr: record.result_xdr,
    resultMetaXdr: record.result_meta_xdr ?? null,
    feeMetaXdr: record.fee_meta_xdr ?? null,
  };
}

/**
 * Attempts to decode the transaction envelope and returns its SDK class name.
 *
 * The complete envelope XDR is also displayed so developers can preserve it
 * for deeper protocol-level inspection.
 */
export function getEnvelopeType(envelopeXdr: string, networkPassphrase: string): string {
  try {
    const decodedTransaction = TransactionBuilder.fromXDR(envelopeXdr, networkPassphrase);

    return decodedTransaction.constructor.name;
  } catch {
    return 'Unable to decode envelope type';
  }
}

/**
 * Prints the transaction metadata in clear sections suitable for debugging
 * logs and audit workflows.
 */
export function displayTransactionDetails(
  summary: TransactionInspectionSummary,
  networkPassphrase: string,
): void {
  console.log('\n========================================');
  console.log('        TRANSACTION INSPECTION');
  console.log('========================================');

  console.log('\n--- Transaction Identity ---');
  console.log(`Transaction hash: ${summary.hash}`);
  console.log(`Source account: ${summary.sourceAccount}`);
  console.log(`Source account sequence: ${summary.sourceSequence}`);

  console.log('\n--- Ledger Information ---');
  console.log(`Ledger sequence: ${summary.ledger}`);
  console.log(`Transaction timestamp: ${summary.createdAt}`);
  console.log(`Operation count: ${summary.operationCount}`);

  console.log('\n--- Fee Information ---');
  console.log(`Fee charged: ${summary.feeCharged} stroops`);
  console.log(`Maximum fee: ${summary.maximumFee} stroops`);

  console.log('\n--- Result Status ---');
  console.log(`Status: ${summary.statusLabel}`);
  console.log(`Successful: ${summary.successful}`);
  console.log(`Transaction result code: ${summary.resultCode}`);

  if (!summary.successful) {
    console.log(
      'WARNING: This transaction was included in a ledger, but its operations did not apply successfully.',
    );
    console.log('Inspect the transaction result code and result XDR when diagnosing the failure.');
  }

  console.log('\n--- Memo Information ---');
  console.log(`Memo type: ${summary.memoType}`);

  if (summary.memoValue === null) {
    console.log('Memo value: No memo was attached.');
  } else {
    console.log(`Memo value: ${summary.memoValue}`);
  }

  console.log('\n--- Envelope and XDR Information ---');
  console.log(`Decoded envelope type: ${getEnvelopeType(summary.envelopeXdr, networkPassphrase)}`);
  console.log(`Envelope XDR: ${summary.envelopeXdr}`);
  console.log(`Result XDR: ${summary.resultXdr}`);

  if (summary.resultMetaXdr === null) {
    console.log('Result metadata XDR: Not available from this Horizon response.');
  } else {
    console.log(`Result metadata XDR: ${summary.resultMetaXdr}`);
  }

  if (summary.feeMetaXdr === null) {
    console.log('Fee metadata XDR: Not available from this Horizon response.');
  } else {
    console.log(`Fee metadata XDR: ${summary.feeMetaXdr}`);
  }

  console.log('\n--- Debugging and Audit Uses ---');
  console.log('- Use the transaction hash as a stable identifier in application logs.');
  console.log(
    '- Compare the source account and sequence number when investigating transaction ordering problems.',
  );
  console.log('- Review the charged fee and operation count when auditing transaction costs.');
  console.log(
    '- Use the timestamp and ledger sequence to establish when the transaction reached the ledger.',
  );
  console.log(
    '- Inspect failed result codes before deciding whether a transaction should be rebuilt or retried.',
  );
  console.log(
    '- Preserve envelope and result XDR when deeper protocol-level inspection is required.',
  );

  console.log('========================================\n');
}

/**
 * Retrieves one transaction directly by hash.
 *
 * Invalid hash formats and unknown hashes are reported separately so users
 * receive a clear and actionable error message.
 */
export async function retrieveTransactionByHash(
  server: Horizon.Server,
  transactionHash: string,
): Promise<HorizonTransactionRecordLike> {
  const normalizedHash = transactionHash.trim().toLowerCase();

  if (normalizedHash.length === 0) {
    throw new Error(
      'A transaction hash is required. Provide it through the interactive runner, command line, or TRANSACTION_HASH environment variable.',
    );
  }

  if (!isValidTransactionHash(normalizedHash)) {
    throw new Error(
      'Invalid transaction hash. A Stellar transaction hash must contain exactly 64 hexadecimal characters.',
    );
  }

  try {
    const transaction = await server.transactions().transaction(normalizedHash).call();

    return transaction as unknown as HorizonTransactionRecordLike;
  } catch (error: unknown) {
    if (isHorizonNotFoundError(error)) {
      throw new Error(
        `Transaction ${normalizedHash} was not found on the connected Horizon network. Confirm the hash and make sure it belongs to this network.`,
      );
    }

    throw new Error(`Unable to retrieve transaction ${normalizedHash}: ${getErrorMessage(error)}`);
  }
}

/**
 * Retrieves the most recent transaction available from Horizon.
 *
 * This fallback keeps the required direct command runnable when no hash has
 * been configured.
 */
async function retrieveLatestTransactionHash(server: Horizon.Server): Promise<string> {
  const transactionPage = await server.transactions().order('desc').limit(1).call();

  const latestTransaction = transactionPage.records[0];

  if (!latestTransaction) {
    throw new Error(
      'No transactions were returned by Horizon. Provide a transaction hash through the runner, command line, or TRANSACTION_HASH environment variable.',
    );
  }

  return latestTransaction.hash;
}

/**
 * Resolves the transaction hash from:
 *
 * 1. The interactive runner's transactionHash parameter
 * 2. A second command-line argument
 * 3. The TRANSACTION_HASH environment variable
 * 4. The latest transaction returned by Horizon
 */
async function resolveTransactionHash(
  server: Horizon.Server,
  params: TransactionInspectionParams,
): Promise<string> {
  const parameterHash = params.transactionHash?.trim();

  if (parameterHash) {
    console.log('Using the transaction hash supplied through the interactive runner.');

    return parameterHash;
  }

  /*
   * For:
   * npm run run-example -- 46-transaction-detail-inspection <hash>
   *
   * process.argv[2] is the example name and process.argv[3] is the hash.
   */
  const commandLineHash = process.argv[3]?.trim();

  if (commandLineHash) {
    console.log('Using the transaction hash supplied through the command line.');

    return commandLineHash;
  }

  const environmentHash = process.env.TRANSACTION_HASH?.trim();

  if (environmentHash) {
    console.log('Using the transaction hash supplied through TRANSACTION_HASH.');

    return environmentHash;
  }

  console.log(
    'No transaction hash was supplied. Retrieving the latest available Testnet transaction for this demonstration...',
  );

  return retrieveLatestTransactionHash(server);
}

/**
 * Demonstrates retrieving and inspecting a transaction through Horizon.
 */
export async function run(params: TransactionInspectionParams = {}): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL || DEFAULT_HORIZON_URL;

  const networkPassphrase = process.env.NETWORK_PASSPHRASE || Networks.TESTNET;

  const server = new Horizon.Server(horizonUrl);

  console.log('Starting Horizon Transaction Detail Inspection Example...');
  console.log(`Using Horizon: ${horizonUrl}`);

  const transactionHash = await resolveTransactionHash(server, params);

  console.log(`Transaction selected: ${transactionHash}`);
  console.log('\nRetrieving the transaction record from Horizon...');

  const transactionRecord = await retrieveTransactionByHash(server, transactionHash);

  const summary = createTransactionSummary(transactionRecord);

  displayTransactionDetails(summary, networkPassphrase);

  console.log('Horizon transaction detail inspection completed successfully.');
}
