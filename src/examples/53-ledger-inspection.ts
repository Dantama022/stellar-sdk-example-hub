import { Horizon } from '@stellar/stellar-sdk';

/**
 * Example 53: Horizon Ledger Inspection
 *
 * Every successful Stellar transaction is included in exactly one ledger. A
 * ledger is a network-level checkpoint that closes every ~5 seconds and records:
 *
 *   - sequence number and close time
 *   - hash of this ledger and the previous ledger
 *   - how many transactions and operations were included
 *   - protocol version and base fee / base reserve
 *
 * Relationship between records:
 *   Ledger  →  contains many Transactions
 *   Transaction  →  contains one or more Operations
 *   Operation  →  produces zero or more Effects
 *
 * This example is read-only: it loads a ledger by sequence (or the latest) and
 * presents its metadata so developers can place transactions in network context.
 */

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';

export interface LedgerInspectionParams {
  ledgerSequence?: number | string;
  horizonUrl?: string;
}

export interface RawLedgerRecord {
  id?: string;
  hash?: string;
  prev_hash?: string;
  sequence?: number;
  successful_transaction_count?: number;
  failed_transaction_count?: number;
  operation_count?: number;
  tx_set_operation_count?: number;
  closed_at?: string;
  total_coins?: string;
  fee_pool?: string;
  base_fee_in_stroops?: number;
  base_reserve_in_stroops?: number;
  max_tx_set_size?: number;
  protocol_version?: number;
  header_xdr?: string;
}

export interface ParsedLedger {
  sequence: number;
  hash: string;
  previousHash: string;
  closedAt: string;
  successfulTransactionCount: number;
  failedTransactionCount: number;
  operationCount: number;
  txSetOperationCount: number;
  protocolVersion: number;
  baseFeeStroops: number;
  baseReserveStroops: number;
  totalCoins: string;
  feePool: string;
  maxTxSetSize: number;
}

/**
 * Parses a ledger sequence input into a positive integer, or undefined when blank.
 */
export function parseLedgerSequence(value?: number | string): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  const parsed = typeof value === 'string' ? parseInt(value.trim(), 10) : value;

  if (Number.isNaN(parsed) || !Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid ledger sequence "${value}". Provide a positive integer ledger sequence number.`,
    );
  }

  return Math.trunc(parsed);
}

/**
 * Converts a Horizon ledger record into a structured summary.
 */
export function parseLedgerRecord(record: RawLedgerRecord): ParsedLedger {
  return {
    sequence: record.sequence ?? 0,
    hash: record.hash ?? record.id ?? '',
    previousHash: record.prev_hash ?? '',
    closedAt: record.closed_at ?? '',
    successfulTransactionCount: record.successful_transaction_count ?? 0,
    failedTransactionCount: record.failed_transaction_count ?? 0,
    operationCount: record.operation_count ?? 0,
    txSetOperationCount: record.tx_set_operation_count ?? record.operation_count ?? 0,
    protocolVersion: record.protocol_version ?? 0,
    baseFeeStroops: record.base_fee_in_stroops ?? 100,
    baseReserveStroops: record.base_reserve_in_stroops ?? 5000000,
    totalCoins: record.total_coins ?? '0',
    feePool: record.fee_pool ?? '0',
    maxTxSetSize: record.max_tx_set_size ?? 0,
  };
}

/**
 * Formats ledger metadata for console display.
 */
export function formatLedgerReport(ledger: ParsedLedger): string {
  const lines: string[] = [];

  lines.push('=== Stellar Horizon Ledger Inspection ===');
  lines.push(`Ledger Sequence:              ${ledger.sequence}`);
  lines.push(`Closed At:                    ${ledger.closedAt}`);
  lines.push(`Ledger Hash:                  ${ledger.hash}`);
  lines.push(`Previous Ledger Hash:         ${ledger.previousHash}`);
  lines.push('');
  lines.push('Contained Activity:');
  lines.push(`  Successful Transactions:    ${ledger.successfulTransactionCount}`);
  lines.push(`  Failed Transactions:        ${ledger.failedTransactionCount}`);
  lines.push(`  Operation Count:            ${ledger.operationCount}`);
  lines.push(`  Tx-Set Operation Count:     ${ledger.txSetOperationCount}`);
  lines.push(`  Max Tx Set Size:            ${ledger.maxTxSetSize}`);
  lines.push('');
  lines.push('Network Parameters (at this ledger):');
  lines.push(`  Protocol Version:           ${ledger.protocolVersion}`);
  lines.push(`  Base Fee:                   ${ledger.baseFeeStroops} stroops`);
  lines.push(
    `  Base Reserve:               ${ledger.baseReserveStroops} stroops (${(ledger.baseReserveStroops / 10_000_000).toFixed(7)} XLM)`,
  );
  lines.push(`  Total Coins:                ${ledger.totalCoins} XLM`);
  lines.push(`  Fee Pool:                   ${ledger.feePool} XLM`);
  lines.push('');
  lines.push('How ledgers relate to transactions and operations:');
  lines.push('  - A ledger closes roughly every 5 seconds and finalizes a set of transactions.');
  lines.push('  - Each transaction in the ledger may contain one or more operations.');
  lines.push('  - Operations produce effects that describe the resulting ledger state changes.');
  lines.push('  - The previous_hash links ledgers into an append-only chain of history.');

  return lines.join('\n');
}

/**
 * Detects Horizon responses for missing / unavailable ledgers.
 */
export function isUnavailableLedgerError(error: any): boolean {
  return error?.response?.status === 404 || error?.name === 'NotFoundError';
}

/**
 * Runs the Horizon ledger inspection example.
 *
 * Sequence can be supplied via runner prompt, `LEDGER_SEQUENCE` env, or CLI arg.
 * Leaving it blank inspects the most recently closed ledger.
 */
export async function run(params: LedgerInspectionParams = {}): Promise<void> {
  const horizonUrl = params.horizonUrl || process.env.HORIZON_URL || DEFAULT_HORIZON_URL;
  const server = new Horizon.Server(horizonUrl);

  const rawSequence = params.ledgerSequence ?? process.env.LEDGER_SEQUENCE ?? process.argv[3];

  console.log('Starting Horizon Ledger Inspection Example...');
  console.log(`Using Horizon: ${horizonUrl}`);

  let sequence: number | undefined;
  try {
    sequence = parseLedgerSequence(rawSequence as number | string | undefined);
  } catch (error: any) {
    console.log(`\n${error?.message || error}`);
    return;
  }

  let record: RawLedgerRecord | undefined;

  try {
    if (sequence === undefined) {
      console.log('No ledger sequence supplied. Fetching the latest closed ledger...');
      const page = await server.ledgers().order('desc').limit(1).call();
      record = page.records[0] as unknown as RawLedgerRecord | undefined;
      if (!record) {
        console.log('Horizon returned no ledger records.');
        return;
      }
    } else {
      console.log(`Retrieving ledger sequence ${sequence}...`);
      record = (await server.ledgers().ledger(sequence).call()) as unknown as RawLedgerRecord;
    }
  } catch (error: any) {
    if (isUnavailableLedgerError(error)) {
      console.log(
        `\nLedger sequence ${sequence} is unavailable on this Horizon instance (404 Not Found).`,
      );
      console.log('Common causes:');
      console.log('  - the sequence is in the future (not closed yet),');
      console.log('  - the sequence is older than this Horizon history retention window, or');
      console.log('  - you are querying the wrong network.');
      console.log('\nTry leaving the sequence blank to inspect the latest ledger instead.');
      console.log('\nLedger inspection completed (unavailable ledger handled).');
      return;
    }

    console.log(`\nCould not retrieve ledger: ${error?.message || error}`);
    return;
  }

  const parsed = parseLedgerRecord(record);
  console.log('\n' + formatLedgerReport(parsed));
  console.log('\nHorizon ledger inspection completed successfully.');
}
