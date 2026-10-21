import { Horizon } from '@stellar/stellar-sdk';

/**
 * Example 262: Ledger Transaction Volume and Asset Flow Analytics
 *
 * This example fetches a configurable range of Stellar ledgers and the
 * transactions and payment operations they contain. It then aggregates:
 *
 *   - Ledger-level statistics (closed ledgers, total transactions, total
 *     operations, success/failure rates)
 *   - Payment flow broken down by asset (native XLM and issued assets)
 *   - Operation type distribution across the scanned range
 *
 * Key distinction between counts
 * ──────────────────────────────
 * Transaction count and operation count are NOT the same thing:
 *
 *   - A transaction is an atomic bundle signed by an account. It may contain
 *     up to 100 operations. It succeeds or fails as a whole.
 *   - An operation is a single action within a transaction (e.g., payment,
 *     manageBuyOffer, changeTrust).
 *   - Payment VOLUME is the sum of individual transfer amounts for a specific
 *     asset. Volumes in different assets cannot be combined into one monetary
 *     total — that would require exchange rates that are not part of this data.
 *
 * These metrics are intentionally kept separate. Payment totals for XLM and
 * issued assets are reported independently. No gross multi-asset total is
 * computed because doing so would misrepresent the data.
 *
 * Scope and limitations
 * ─────────────────────
 * Horizon's transaction endpoint returns up to 200 records per page. For wide
 * ledger ranges on an active network the sample is limited to the first page
 * per ledger. Set LEDGER_COUNT to a small value (≤ 10) to keep the run fast.
 *
 * This example is read-only. It does not build, sign, or submit transactions
 * and requires no funded account or secret key.
 */

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';

/** How many of the most recent ledgers to scan. */
const DEFAULT_LEDGER_COUNT = 5;
const MAX_LEDGER_COUNT = 50;

/** Maximum number of transactions fetched per ledger. */
const TX_PAGE_LIMIT = 200;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LedgerVolumeAnalyticsParams {
  /** Number of recent closed ledgers to scan. Defaults to 5. */
  ledgerCount?: number | string;
  /** Override the starting ledger sequence. When omitted, uses the latest closed ledger. */
  startLedger?: number | string;
  /** Horizon URL. Defaults to Stellar Testnet. */
  horizonUrl?: string;
  /** Emit machine-readable JSON output. */
  json?: boolean | string;
}

export interface AssetVolume {
  /** 'native' for XLM or 'CODE:ISSUER' for issued assets. */
  asset: string;
  /** Sum of amounts transferred. Stored as raw string-decimal accumulation. */
  totalAmount: string;
  /** Number of individual payment operations counted for this asset. */
  paymentCount: number;
}

export interface OperationTypeSummary {
  operationType: string;
  count: number;
}

export interface LedgerSummary {
  sequence: number;
  closedAt: string;
  successfulTransactions: number;
  failedTransactions: number;
  operationCount: number;
}

export interface VolumeAnalyticsReport {
  horizonUrl: string;
  scannedLedgers: number;
  firstLedger: number;
  lastLedger: number;
  totalTransactions: number;
  successfulTransactions: number;
  failedTransactions: number;
  totalOperations: number;
  paymentOperationCount: number;
  assetVolumes: AssetVolume[];
  operationTypeDistribution: OperationTypeSummary[];
  ledgerSummaries: LedgerSummary[];
  notes: string[];
}

// ─── Raw Horizon record shapes ────────────────────────────────────────────────

export interface RawLedgerRecord {
  sequence?: number;
  closed_at?: string;
  successful_transaction_count?: number;
  failed_transaction_count?: number;
  operation_count?: number;
}

export interface RawOperationRecord {
  type?: string;
  type_i?: number;
  amount?: string;
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
  transaction_successful?: boolean;
}

export interface RawTransactionRecord {
  id?: string;
  successful?: boolean;
  operation_count?: number;
  created_at?: string;
  ledger?: number;
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Returns a canonical asset identifier string.
 * Native XLM → 'native'
 * Issued asset → 'CODE:ISSUER'
 */
export function assetKey(
  assetType: string | undefined,
  assetCode: string | undefined,
  assetIssuer: string | undefined,
): string {
  if (assetType === 'native') {
    return 'native';
  }
  const code = assetCode?.trim() || 'UNKNOWN';
  const issuer = assetIssuer?.trim() || 'UNKNOWN';
  return `${code}:${issuer}`;
}

/**
 * Adds two decimal-string amounts safely.
 * Both values are parsed with up to 7 decimal places (Stellar stroops).
 */
export function addAmounts(a: string, b: string): string {
  const scale = 10_000_000; // 1e7 — Stellar uses 7 decimal places
  const aInt = Math.round(parseFloat(a) * scale);
  const bInt = Math.round(parseFloat(b) * scale);
  const result = (aInt + bInt) / scale;
  return result.toFixed(7);
}

/**
 * Validates and parses a ledger count parameter.
 */
export function parseLedgerCount(value?: number | string): number {
  if (value === undefined || value === null || value === '') {
    return DEFAULT_LEDGER_COUNT;
  }
  const parsed = typeof value === 'string' ? parseInt(value.trim(), 10) : Math.trunc(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid ledger count "${value}". Provide a positive integer between 1 and ${MAX_LEDGER_COUNT}.`,
    );
  }
  return Math.min(parsed, MAX_LEDGER_COUNT);
}

/**
 * Whether the operation type represents a value transfer between accounts.
 * Stellar's Horizon API uses these string types.
 */
export function isPaymentOperation(type: string | undefined): boolean {
  return (
    type === 'payment' ||
    type === 'path_payment_strict_receive' ||
    type === 'path_payment_strict_send' ||
    type === 'create_account'
  );
}

/**
 * Parses raw Horizon ledger record into a lightweight summary.
 */
export function parseLedgerRecord(record: RawLedgerRecord): LedgerSummary {
  return {
    sequence: record.sequence ?? 0,
    closedAt: record.closed_at ?? '',
    successfulTransactions: record.successful_transaction_count ?? 0,
    failedTransactions: record.failed_transaction_count ?? 0,
    operationCount: record.operation_count ?? 0,
  };
}

/**
 * Accumulates an operation into the running asset-volume map and
 * operation-type distribution map.
 */
export function accumulateOperation(
  op: RawOperationRecord,
  assetVolumes: Map<string, AssetVolume>,
  opTypeCounts: Map<string, number>,
): void {
  // Count operation type
  const opType = op.type ?? 'unknown';
  opTypeCounts.set(opType, (opTypeCounts.get(opType) ?? 0) + 1);

  // Accumulate payment volume only for operations that transfer value
  if (!isPaymentOperation(op.type)) {
    return;
  }

  let key: string;
  let amount: string;

  if (op.type === 'create_account') {
    // create_account always transfers native XLM as starting_balance
    // The amount field on create_account is 'starting_balance', handled below
    key = 'native';
    // The raw record for create_account uses 'starting_balance' not 'amount',
    // but Horizon also exposes it as 'amount' in the operations endpoint.
    amount = (op as any).starting_balance ?? op.amount ?? '0';
  } else {
    key = assetKey(op.asset_type, op.asset_code, op.asset_issuer);
    amount = op.amount ?? '0';
  }

  if (!amount || parseFloat(amount) <= 0) {
    return;
  }

  const existing = assetVolumes.get(key);
  if (existing) {
    existing.totalAmount = addAmounts(existing.totalAmount, amount);
    existing.paymentCount += 1;
  } else {
    assetVolumes.set(key, {
      asset: key,
      totalAmount: amount,
      paymentCount: 1,
    });
  }
}

/**
 * Converts the asset volume and operation type maps into sorted arrays.
 */
export function finalizeMaps(
  assetVolumes: Map<string, AssetVolume>,
  opTypeCounts: Map<string, number>,
): { assetVolumes: AssetVolume[]; operationTypeDistribution: OperationTypeSummary[] } {
  const sortedAssets = Array.from(assetVolumes.values()).sort((a, b) => {
    // Native XLM first, then by payment count descending
    if (a.asset === 'native') return -1;
    if (b.asset === 'native') return 1;
    return b.paymentCount - a.paymentCount;
  });

  const sortedOps = Array.from(opTypeCounts.entries())
    .map(([operationType, count]) => ({ operationType, count }))
    .sort((a, b) => b.count - a.count);

  return { assetVolumes: sortedAssets, operationTypeDistribution: sortedOps };
}

/**
 * Formats the analytics report for human-readable console output.
 */
export function formatReport(report: VolumeAnalyticsReport): string {
  const lines: string[] = [];

  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('  Stellar Ledger Transaction Volume and Asset Flow Analytics');
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push(`  Horizon:          ${report.horizonUrl}`);
  lines.push(`  Ledger range:     ${report.firstLedger} → ${report.lastLedger}`);
  lines.push(`  Ledgers scanned:  ${report.scannedLedgers}`);
  lines.push('');

  lines.push('─── Transaction Summary ────────────────────────────────────────');
  lines.push(`  Total transactions:      ${report.totalTransactions}`);
  lines.push(`  Successful:              ${report.successfulTransactions}`);
  lines.push(`  Failed:                  ${report.failedTransactions}`);
  const successRate =
    report.totalTransactions > 0
      ? ((report.successfulTransactions / report.totalTransactions) * 100).toFixed(1)
      : 'N/A';
  lines.push(`  Success rate:            ${successRate}%`);
  lines.push('');

  lines.push('─── Operation Summary ──────────────────────────────────────────');
  lines.push(`  Total operations:        ${report.totalOperations}`);
  lines.push(`  Payment operations:      ${report.paymentOperationCount}`);
  const avgOpsPerTx =
    report.totalTransactions > 0
      ? (report.totalOperations / report.totalTransactions).toFixed(2)
      : 'N/A';
  lines.push(`  Avg operations/tx:       ${avgOpsPerTx}`);
  lines.push('');

  lines.push('─── Operation Type Distribution ────────────────────────────────');
  if (report.operationTypeDistribution.length === 0) {
    lines.push('  (no operations observed)');
  } else {
    for (const entry of report.operationTypeDistribution) {
      lines.push(`  ${entry.operationType.padEnd(38)} ${entry.count}`);
    }
  }
  lines.push('');

  lines.push('─── Payment Volume by Asset ─────────────────────────────────────');
  lines.push('  Note: each asset is reported independently. Volumes in');
  lines.push('  different assets cannot be summed into a single monetary value.');
  lines.push('');
  if (report.assetVolumes.length === 0) {
    lines.push('  (no payment operations observed)');
  } else {
    const labelWidth = 44;
    lines.push(`  ${'Asset'.padEnd(labelWidth)} Count     Total Amount`);
    lines.push(`  ${'─'.repeat(labelWidth)} ─────     ────────────`);
    for (const vol of report.assetVolumes) {
      const assetLabel =
        vol.asset === 'native' ? 'XLM (native)' : vol.asset;
      lines.push(
        `  ${assetLabel.padEnd(labelWidth)} ${String(vol.paymentCount).padEnd(9)} ${vol.totalAmount}`,
      );
    }
  }
  lines.push('');

  lines.push('─── Per-Ledger Detail ──────────────────────────────────────────');
  if (report.ledgerSummaries.length === 0) {
    lines.push('  (no ledgers scanned)');
  } else {
    lines.push(`  ${'Sequence'.padEnd(12)} ${'Closed At'.padEnd(26)} ${'OK'.padEnd(5)} ${'Fail'.padEnd(5)} Ops`);
    lines.push(`  ${'─'.repeat(12)} ${'─'.repeat(26)} ${'─'.repeat(5)} ${'─'.repeat(5)} ───`);
    for (const ls of report.ledgerSummaries) {
      lines.push(
        `  ${String(ls.sequence).padEnd(12)} ${ls.closedAt.padEnd(26)} ${String(ls.successfulTransactions).padEnd(5)} ${String(ls.failedTransactions).padEnd(5)} ${ls.operationCount}`,
      );
    }
  }
  lines.push('');

  if (report.notes.length > 0) {
    lines.push('─── Notes ──────────────────────────────────────────────────────');
    for (const note of report.notes) {
      lines.push(`  • ${note}`);
    }
    lines.push('');
  }

  lines.push('═══════════════════════════════════════════════════════════════');

  return lines.join('\n');
}

// ─── Network helpers ──────────────────────────────────────────────────────────

/**
 * Fetches the most recently closed ledger sequence from Horizon.
 */
async function fetchLatestLedgerSequence(server: Horizon.Server): Promise<number> {
  const page = await server.ledgers().order('desc').limit(1).call();
  const record = page.records[0] as unknown as RawLedgerRecord | undefined;
  if (!record || !record.sequence) {
    throw new Error('Horizon returned no ledger records.');
  }
  return record.sequence;
}

/**
 * Fetches a single ledger record by sequence number.
 */
async function fetchLedger(
  server: Horizon.Server,
  sequence: number,
): Promise<RawLedgerRecord | null> {
  try {
    const record = (await server
      .ledgers()
      .ledger(sequence)
      .call()) as unknown as RawLedgerRecord;
    return record;
  } catch (err: any) {
    if (err?.response?.status === 404 || err?.name === 'NotFoundError') {
      return null;
    }
    throw err;
  }
}

/**
 * Fetches the first page of operations for a given ledger.
 */
async function fetchLedgerOperations(
  server: Horizon.Server,
  sequence: number,
): Promise<RawOperationRecord[]> {
  try {
    const page = await server
      .operations()
      .forLedger(sequence)
      .limit(TX_PAGE_LIMIT)
      .order('asc')
      .includeFailed(false)
      .call();
    return page.records as unknown as RawOperationRecord[];
  } catch (_err: any) {
    // A 404 here means the ledger had no operations; that is valid.
    return [];
  }
}

// ─── Main run function ────────────────────────────────────────────────────────

/**
 * Runs the Ledger Transaction Volume and Asset Flow Analytics example.
 *
 * Configuration (in priority order):
 *   1. params argument
 *   2. Environment variables: LEDGER_COUNT, START_LEDGER, HORIZON_URL, JSON_OUTPUT
 *   3. CLI positional args:   argv[3] = ledgerCount, argv[4] = startLedger
 */
export async function run(params: LedgerVolumeAnalyticsParams = {}): Promise<void> {
  const horizonUrl = params.horizonUrl ?? process.env.HORIZON_URL ?? DEFAULT_HORIZON_URL;

  const rawCount =
    params.ledgerCount ??
    process.env.LEDGER_COUNT ??
    process.argv[3];

  const rawStart =
    params.startLedger ??
    process.env.START_LEDGER ??
    process.argv[4];

  const wantJson =
    params.json === true ||
    params.json === 'true' ||
    process.env.JSON_OUTPUT === 'true' ||
    process.argv.includes('--json');

  const server = new Horizon.Server(horizonUrl);

  console.log('Starting Ledger Transaction Volume and Asset Flow Analytics...');
  console.log(`Horizon: ${horizonUrl}`);

  // Resolve and validate ledger count
  let ledgerCount: number;
  try {
    ledgerCount = parseLedgerCount(rawCount);
  } catch (err: any) {
    console.error(`\n${err.message}`);
    return;
  }

  // Resolve start ledger
  let startSequence: number;
  if (rawStart !== undefined && rawStart !== null && rawStart !== '') {
    const parsed = parseInt(String(rawStart).trim(), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      console.error(`\nInvalid start ledger "${rawStart}". Provide a positive integer sequence.`);
      return;
    }
    startSequence = parsed;
  } else {
    console.log('No start ledger supplied. Fetching the latest closed ledger...');
    try {
      startSequence = await fetchLatestLedgerSequence(server);
      console.log(`Latest closed ledger: ${startSequence}`);
    } catch (err: any) {
      console.error(`\nFailed to fetch latest ledger: ${err.message ?? err}`);
      return;
    }
  }

  // The scan goes from startSequence down by ledgerCount steps
  const endSequence = Math.max(startSequence - ledgerCount + 1, 1);
  console.log(
    `Scanning ledgers ${endSequence} → ${startSequence} (${ledgerCount} ledger${ledgerCount !== 1 ? 's' : ''})...`,
  );

  // Accumulator state
  const assetVolumes = new Map<string, AssetVolume>();
  const opTypeCounts = new Map<string, number>();
  const ledgerSummaries: LedgerSummary[] = [];
  const notes: string[] = [];

  let totalTransactions = 0;
  let successfulTransactions = 0;
  let failedTransactions = 0;
  let totalOperations = 0;
  let paymentOperationCount = 0;
  let ledgersScanned = 0;
  let skippedLedgers = 0;

  // Scan each ledger from newest to oldest (matches Horizon's common desc order)
  for (let seq = startSequence; seq >= endSequence; seq--) {
    process.stdout.write(`  Ledger ${seq}...`);

    // Fetch ledger header
    let ledgerRecord: RawLedgerRecord | null;
    try {
      ledgerRecord = await fetchLedger(server, seq);
    } catch (err: any) {
      console.log(` error: ${err.message ?? err}`);
      skippedLedgers++;
      continue;
    }

    if (!ledgerRecord) {
      console.log(' not found (skipped)');
      skippedLedgers++;
      continue;
    }

    const summary = parseLedgerRecord(ledgerRecord);
    ledgerSummaries.push(summary);
    ledgersScanned++;

    const ledgerSuccessful = summary.successfulTransactions;
    const ledgerFailed = summary.failedTransactions;
    totalTransactions += ledgerSuccessful + ledgerFailed;
    successfulTransactions += ledgerSuccessful;
    failedTransactions += ledgerFailed;
    totalOperations += summary.operationCount;

    // Fetch operations for this ledger
    let ops: RawOperationRecord[];
    try {
      ops = await fetchLedgerOperations(server, seq);
    } catch (err: any) {
      console.log(` ops error: ${err.message ?? err}`);
      ops = [];
    }

    for (const op of ops) {
      accumulateOperation(op, assetVolumes, opTypeCounts);
      if (isPaymentOperation(op.type)) {
        paymentOperationCount++;
      }
    }

    console.log(
      ` ok (${summary.successfulTransactions} tx, ${summary.operationCount} ops, ${ops.length} ops fetched)`,
    );
  }

  // Warn if ledger counts differ from what operations page returned
  if (skippedLedgers > 0) {
    notes.push(
      `${skippedLedgers} ledger${skippedLedgers !== 1 ? 's' : ''} could not be retrieved (not found or network error) and were excluded.`,
    );
  }

  notes.push(
    'Transaction counts come from ledger headers. Operation counts from per-ledger operation pages.',
  );
  notes.push(
    'Payment volumes are summed per asset. Amounts in different assets are not comparable.',
  );
  notes.push(
    `Operations are capped at ${TX_PAGE_LIMIT} per ledger; very busy ledgers may be under-reported.`,
  );

  const { assetVolumes: sortedAssets, operationTypeDistribution } = finalizeMaps(
    assetVolumes,
    opTypeCounts,
  );

  const report: VolumeAnalyticsReport = {
    horizonUrl,
    scannedLedgers: ledgersScanned,
    firstLedger: ledgerSummaries.length > 0 ? ledgerSummaries[ledgerSummaries.length - 1].sequence : endSequence,
    lastLedger: ledgerSummaries.length > 0 ? ledgerSummaries[0].sequence : startSequence,
    totalTransactions,
    successfulTransactions,
    failedTransactions,
    totalOperations,
    paymentOperationCount,
    assetVolumes: sortedAssets,
    operationTypeDistribution,
    ledgerSummaries,
    notes,
  };

  console.log('');

  if (wantJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReport(report));
  }

  console.log('Ledger Transaction Volume and Asset Flow Analytics completed.');
}
