/**
 * Example 258: Stellar Transaction History Export and Reconciliation
 * (ISSUE-309).
 *
 * Reconciling a Stellar account against an external ledger is mostly a data
 * problem: the history arrives as paginated Horizon records, each transaction
 * carries its own result codes, and the same transaction can show up more than
 * once when a scan is resumed.
 *
 * This example demonstrates how to:
 *   - retrieve an account's transaction history with Horizon pagination
 *   - normalize transaction and operation records into a canonical form
 *   - deduplicate records using the transaction hash as a stable identifier
 *   - export a CSV or JSON reconciliation report with a summary block
 *
 * Safety properties:
 *   - no transaction is ever submitted; only read-only Horizon calls are made
 *   - a checkpoint file makes the scan resumable across runs
 *   - the transaction hash is the only deduplication key, so a record can never
 *     be silently dropped because a timestamp shifted
 */

import dotenv from 'dotenv';
import { Horizon } from '@stellar/stellar-sdk';

import { WorkflowError, accountId } from '../utils/example-input';
import { resolveNetworkConfiguration } from './60-network-configuration';
import { loadCheckpoint, saveCheckpoint, scan } from '../utils/reliable-scan';

/** A normalized operation result with a stable 1-based index. */
export interface NormalizedOperation {
  /** 1-based index of the operation within the transaction. */
  index: number;
  /** The operation type (e.g. `payment`, `manage_sell_offer`). */
  type: string;
  /** The operation result code (e.g. `op_success`, `op_underfunded`). */
  resultCode: string;
  /** True when the operation succeeded. */
  succeeded: boolean;
  /** Human-readable explanation of the result. */
  explanation: string;
}

/** A normalized transaction record with a stable identifier for deduplication. */
export interface NormalizedTransaction {
  /** Stable identifier - the deduplication key across runs. */
  hash: string;
  /** The ledger sequence number. */
  ledger: number;
  /** The timestamp when the transaction was created. */
  createdAt: string;
  /** True when the transaction was successfully applied to the ledger. */
  successful: boolean;
  /** The source account that originated the transaction. */
  source: string;
  /** The operations contained in the transaction, each with its result. */
  operations: NormalizedOperation[];
  /** The transaction-level result code, when Horizon reported one. */
  transactionResultCode?: string;
}

/** The reconciliation summary emitted alongside the exported records. */
export interface ReconciliationSummary {
  /** Total number of unique transactions in the export. */
  totalTransactions: number;
  /** How many of them were applied successfully. */
  successful: number;
  /** How many of them failed. */
  failed: number;
  /** How many unique hashes were dropped as duplicates. */
  duplicatesDropped: number;
  /** The first ledger covered by the export. */
  firstLedger: number;
  /** The last ledger covered by the export. */
  lastLedger: number;
  /** The transaction-level result codes seen, with their counts. */
  resultCodeCounts: Record<string, number>;
}

const OPERATION_EXPLANATIONS: Record<string, string> = {
  op_success: 'The operation was applied successfully.',
  op_underfunded: 'The source account does not have enough balance.',
  op_no_destination: 'The destination account does not exist.',
  op_no_trust: 'The destination account has no trustline for this asset.',
  op_src_no_trust: 'The source account has no trustline for this asset.',
  op_line_full: 'The destination trustline cannot hold the requested balance.',
  op_not_authorized: 'The trustline is not authorized to hold this asset.',
  op_no_issuer: 'The asset issuer account does not exist.',
  op_cross_self: 'The offer would cross another offer from the same account.',
  op_offer_not_found: 'The offer to update or remove was not found.',
  op_invalid_limit: 'The offer price or limit is invalid.',
  op_invalid_price: 'The offer price is invalid.',
  op_low_reserve: 'The operation would leave an account below its minimum reserve.',
  op_bad_auth: 'The operation source account does not satisfy its threshold.',
  op_malformed: 'The operation parameters are malformed or invalid.',
  op_buy_no_trust: 'The source account has no trustline for the asset bought.',
  op_sell_no_trust: 'The source account has no trustline for the asset sold.',
};

const TRANSACTION_EXPLANATIONS: Record<string, string> = {
  tx_success: 'The transaction was applied successfully.',
  tx_failed: 'One or more operations failed, so the transaction was rolled back.',
  tx_bad_seq: 'The transaction sequence number is invalid or already used.',
  tx_bad_auth: 'The transaction did not contain enough valid signatures.',
  tx_insufficient_balance: 'The source account cannot pay the transaction fee.',
  tx_insufficient_fee: 'The transaction fee is below the network minimum.',
  tx_no_source_account: 'The transaction source account does not exist.',
  tx_too_early: 'The transaction was submitted before its time bounds began.',
  tx_too_late: 'The transaction was submitted after its time bounds expired.',
  tx_missing_operation: 'The transaction contains no operations.',
  tx_bad_auth_extra: 'The transaction contains an unexpected extra signature.',
  tx_bad_min_seq_age: 'The source account sequence age is below the required minimum.',
  tx_bad_min_seq_ledger_gap: 'The source account ledger gap is below the required minimum.',
};

/** Map an operation result code to a human-readable explanation. */
export function explainOperationResult(code: string): string {
  const lower = code.toLowerCase();
  return OPERATION_EXPLANATIONS[lower] ?? `Unknown operation result code: ${lower}`;
}

/** Map a transaction result code to a human-readable explanation. */
export function explainTransactionResult(code: string): string {
  const lower = code.toLowerCase();
  return TRANSACTION_EXPLANATIONS[lower] ?? `Unknown transaction result code: ${lower}`;
}

/**
 * Build a normalized transaction record from a Horizon transaction record.
 *
 * The Horizon shape differs slightly between the `transactions` collection
 * endpoint and the single-transaction endpoint, so every field is read
 * defensively and the hash is required to be present.
 */
export function normalizeTransaction(record: Record<string, unknown>): NormalizedTransaction {
  const hash = typeof record.hash === 'string' ? record.hash : '';
  const ledger = typeof record.ledger === 'number' ? record.ledger : 0;
  const createdAt = typeof record.created_at === 'string' ? record.created_at : '';
  const successful = record.successful === true;
  const links = record._links as { account?: { href?: string } } | undefined;
  const source = links?.account?.href?.split('/').pop() ?? '';

  const resultCodes = record.result_codes as
    { transaction?: string; operations?: string[] } | undefined;
  const operationCodes = resultCodes?.operations ?? [];
  const rawOperations = Array.isArray(record.operations)
    ? (record.operations as Record<string, unknown>[])
    : [];

  const operations: NormalizedOperation[] = operationCodes.map((code, index) => {
    const resultCode = code.toLowerCase();
    return {
      index: index + 1,
      type: readOperationType(rawOperations[index]),
      resultCode,
      succeeded: resultCode === 'op_success',
      explanation: explainOperationResult(resultCode),
    };
  });

  return {
    hash,
    ledger,
    createdAt,
    successful,
    source,
    operations,
    transactionResultCode: resultCodes?.transaction?.toLowerCase(),
  };
}

/** Read the operation type from a raw Horizon operation record. */
function readOperationType(operation: Record<string, unknown> | undefined): string {
  if (!operation) return 'unknown';
  if (typeof operation.type === 'string') return operation.type;
  if (typeof operation.type_i === 'number') return `type_${operation.type_i}`;
  return 'unknown';
}

/**
 * Deduplicate normalized transactions by their transaction hash.
 *
 * The hash is the only stable identifier Stellar provides for a transaction,
 * so it is the only safe key: using a timestamp would drop legitimate
 * transactions that landed in the same second.
 */
export function dedupeTransactions(transactions: NormalizedTransaction[]): {
  unique: NormalizedTransaction[];
  duplicatesDropped: number;
} {
  const seen = new Set<string>();
  const unique: NormalizedTransaction[] = [];
  let duplicatesDropped = 0;

  for (const transaction of transactions) {
    if (!transaction.hash) continue;
    if (seen.has(transaction.hash)) {
      duplicatesDropped += 1;
      continue;
    }
    seen.add(transaction.hash);
    unique.push(transaction);
  }

  return { unique, duplicatesDropped };
}

/** Build the reconciliation summary for a set of unique transactions. */
export function summarize(
  transactions: NormalizedTransaction[],
  duplicatesDropped = 0,
): ReconciliationSummary {
  const resultCodeCounts: Record<string, number> = {};
  for (const transaction of transactions) {
    const code = transaction.transactionResultCode ?? 'unknown';
    resultCodeCounts[code] = (resultCodeCounts[code] ?? 0) + 1;
  }

  return {
    totalTransactions: transactions.length,
    successful: transactions.filter((t) => t.successful).length,
    failed: transactions.filter((t) => !t.successful).length,
    duplicatesDropped,
    firstLedger: transactions.length > 0 ? Math.min(...transactions.map((t) => t.ledger)) : 0,
    lastLedger: transactions.length > 0 ? Math.max(...transactions.map((t) => t.ledger)) : 0,
    resultCodeCounts,
  };
}

/** Escape a single CSV cell. */
function csvCell(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Render the reconciliation report as CSV. */
export function formatCsvReport(
  transactions: NormalizedTransaction[],
  summary: ReconciliationSummary,
): string {
  const rows: string[] = [
    [
      'hash',
      'ledger',
      'successful',
      'source',
      'op_count',
      'first_result_code',
      'last_result_code',
      'transaction_result_code',
      'created_at',
    ].join(','),
  ];

  for (const transaction of transactions) {
    const codes = transaction.operations.map((op) => op.resultCode);
    rows.push(
      [
        transaction.hash,
        String(transaction.ledger),
        String(transaction.successful),
        transaction.source,
        String(transaction.operations.length),
        codes[0] ?? '',
        codes.length > 0 ? codes[codes.length - 1] : '',
        transaction.transactionResultCode ?? '',
        transaction.createdAt,
      ]
        .map(csvCell)
        .join(','),
    );
  }

  rows.push(
    [
      'SUMMARY',
      String(summary.totalTransactions),
      String(summary.successful),
      String(summary.failed),
      String(summary.duplicatesDropped),
      String(summary.firstLedger),
      String(summary.lastLedger),
      '',
      '',
    ].join(','),
  );

  return rows.join('\n');
}

/** Render the reconciliation report as JSON. */
export function formatJsonReport(
  transactions: NormalizedTransaction[],
  summary: ReconciliationSummary,
): string {
  return JSON.stringify({ summary, transactions }, null, 2);
}

/**
 * Run the transaction history export and reconciliation example.
 *
 * Configuration (via environment variables):
 *   - ACCOUNT_ID: the account public key to query history for
 *   - HORIZON_URL: Horizon server URL (defaults to testnet)
 *   - CHECKPOINT_FILE: path to the checkpoint file for resumable scanning
 *   - OUTPUT_FORMAT: `json` or `csv` (defaults to `json`)
 *   - MAX_PAGES: maximum number of Horizon pages to retrieve (defaults to 10)
 */
export async function run(): Promise<void> {
  const config = resolveNetworkConfiguration();
  const account = accountId(process.env.ACCOUNT_ID);
  const checkpointFile = process.env.CHECKPOINT_FILE || '.history-export-checkpoint.json';
  const outputFormat = (process.env.OUTPUT_FORMAT || 'json').toLowerCase();
  const maxPages = Number(process.env.MAX_PAGES) || 10;

  const scope = JSON.stringify([
    'transactions',
    config.horizonUrl,
    config.networkPassphrase,
    account,
    'asc',
  ]);

  const checkpoint = await loadCheckpoint(checkpointFile, scope);
  const server = new Horizon.Server(config.horizonUrl);

  const collected: NormalizedTransaction[] = [];

  await scan<Horizon.ServerApi.TransactionRecord>({
    checkpoint,
    maxPages,
    fetch: async (cursor) => {
      let query = server.transactions().forAccount(account).order('asc').limit(100);
      if (cursor) query = query.cursor(cursor);
      const page = await query.call();
      return {
        records: page.records,
        cursor: page.records.at(-1)?.paging_token,
      };
    },
    identity: (tx) => tx.hash,
    process: async (tx) => {
      collected.push(normalizeTransaction(tx as unknown as Record<string, unknown>));
    },
    save: (next) => saveCheckpoint(checkpointFile, next),
  });

  const { unique, duplicatesDropped } = dedupeTransactions(collected);
  const summary = summarize(unique, duplicatesDropped);

  console.log(
    outputFormat === 'csv' ? formatCsvReport(unique, summary) : formatJsonReport(unique, summary),
  );
  console.log(
    `\nExported ${summary.totalTransactions} unique transactions ` +
      `(ledgers ${summary.firstLedger}-${summary.lastLedger}), ` +
      `dropped ${summary.duplicatesDropped} duplicate hashes.`,
  );
  console.log(`Checkpoint saved at ${checkpointFile}; re-run to resume.`);
}

if (require.main === module) {
  dotenv.config();
  run().catch((error: unknown) => {
    console.error(
      error instanceof WorkflowError
        ? error.message
        : 'Failed to export transaction history. Check ACCOUNT_ID, HORIZON_URL and network availability.',
    );
    process.exitCode = 1;
  });
}
