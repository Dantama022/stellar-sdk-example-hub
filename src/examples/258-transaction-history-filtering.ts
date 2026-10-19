import { Horizon, StrKey } from '@stellar/stellar-sdk';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const DEFAULT_ACCOUNT_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES = 5;

export interface TransactionHistoryFilteringParams {
  accountId?: string;
  minLedger?: number | string;
  maxLedger?: number | string;
  fromTime?: string | Date;
  toTime?: string | Date;
  pageSize?: number | string;
  maxPages?: number | string;
  horizonUrl?: string;
  json?: boolean | string;
}

export interface DroppedTransactionInfo {
  hash: string;
  ledger: number | null;
  createdAt: string | null;
  reason: string;
}

export interface TransactionHistoryReport {
  accountId: string;
  horizonUrl: string;
  requestedLedgerRange: {
    minLedger: number | null;
    maxLedger: number | null;
  };
  requestedTimeWindow: {
    fromTime: string | null;
    toTime: string | null;
  };
  pagesFetched: number;
  totalFetched: number;
  matchedCount: number;
  droppedCount: number;
  transactions: Array<{
    hash: string;
    ledger: number | null;
    createdAt: string | null;
    successful: boolean;
    operationCount: number;
    feeCharged: string | number;
    memoType: string;
  }>;
  droppedTransactions: DroppedTransactionInfo[];
}

interface HorizonPage {
  records: any[];
  next: () => Promise<HorizonPage>;
}

function wantsJson(params: TransactionHistoryFilteringParams): boolean {
  return (
    params.json === true ||
    params.json === 'true' ||
    process.env.JSON_OUTPUT === 'true' ||
    process.argv.includes('--json')
  );
}

export function validateAccountId(value: string): string {
  const accountId = value.trim();
  if (!StrKey.isValidEd25519PublicKey(accountId)) {
    throw new Error('Account ID must be a valid Stellar G... public key.');
  }
  return accountId;
}

export function validateLedgerRange(
  minLedger?: number | string | null,
  maxLedger?: number | string | null,
): { minLedger?: number; maxLedger?: number } {
  let parsedMin: number | undefined;
  let parsedMax: number | undefined;

  if (minLedger !== undefined && minLedger !== null && String(minLedger).trim() !== '') {
    const num = Number(minLedger);
    if (!Number.isInteger(num) || num < 0) {
      throw new Error(`Invalid minLedger: "${minLedger}". Must be a non-negative integer.`);
    }
    parsedMin = num;
  }

  if (maxLedger !== undefined && maxLedger !== null && String(maxLedger).trim() !== '') {
    const num = Number(maxLedger);
    if (!Number.isInteger(num) || num < 0) {
      throw new Error(`Invalid maxLedger: "${maxLedger}". Must be a non-negative integer.`);
    }
    parsedMax = num;
  }

  if (parsedMin !== undefined && parsedMax !== undefined && parsedMin > parsedMax) {
    throw new Error(
      `Contradictory ledger range: minLedger (${parsedMin}) cannot be greater than maxLedger (${parsedMax}).`,
    );
  }

  return { minLedger: parsedMin, maxLedger: parsedMax };
}

export function validateTimeWindow(
  fromTime?: string | Date | null,
  toTime?: string | Date | null,
): { fromTime?: Date; toTime?: Date } {
  let parsedFrom: Date | undefined;
  let parsedTo: Date | undefined;

  if (fromTime !== undefined && fromTime !== null && String(fromTime).trim() !== '') {
    const date = fromTime instanceof Date ? fromTime : new Date(fromTime);
    if (isNaN(date.getTime())) {
      throw new Error(`Invalid fromTime: "${fromTime}". Must be a valid ISO-8601 timestamp or Date.`);
    }
    parsedFrom = date;
  }

  if (toTime !== undefined && toTime !== null && String(toTime).trim() !== '') {
    const date = toTime instanceof Date ? toTime : new Date(toTime);
    if (isNaN(date.getTime())) {
      throw new Error(`Invalid toTime: "${toTime}". Must be a valid ISO-8601 timestamp or Date.`);
    }
    parsedTo = date;
  }

  if (parsedFrom !== undefined && parsedTo !== undefined && parsedFrom.getTime() > parsedTo.getTime()) {
    throw new Error(
      `Contradictory time window: fromTime (${parsedFrom.toISOString()}) cannot be later than toTime (${parsedTo.toISOString()}).`,
    );
  }

  return { fromTime: parsedFrom, toTime: parsedTo };
}

export function parseTransactionTimestamp(createdAt?: string): Date | null {
  if (!createdAt || typeof createdAt !== 'string') {
    return null;
  }
  const date = new Date(createdAt);
  return isNaN(date.getTime()) ? null : date;
}

export function getLedgerSequence(record: any): number | null {
  const ledgerValue = record.ledger_attr ?? record.ledger;
  if (typeof ledgerValue === 'number' && Number.isInteger(ledgerValue)) {
    return ledgerValue;
  }
  if (typeof ledgerValue === 'string' && /^\d+$/.test(ledgerValue)) {
    return Number(ledgerValue);
  }
  return null;
}

export function filterTransactions(
  transactions: any[],
  options: {
    minLedger?: number;
    maxLedger?: number;
    fromTime?: Date;
    toTime?: Date;
  },
): {
  filtered: any[];
  dropped: DroppedTransactionInfo[];
} {
  const filtered: any[] = [];
  const dropped: DroppedTransactionInfo[] = [];

  for (const tx of transactions) {
    const ledgerSeq = getLedgerSequence(tx);
    const txDate = parseTransactionTimestamp(tx.created_at);
    const hash = String(tx.hash ?? 'unknown');

    // Ledger range filtering
    if (options.minLedger !== undefined) {
      if (ledgerSeq === null) {
        dropped.push({
          hash,
          ledger: null,
          createdAt: tx.created_at ?? null,
          reason: `Missing ledger sequence while minLedger filter (${options.minLedger}) is active`,
        });
        continue;
      }
      if (ledgerSeq < options.minLedger) {
        dropped.push({
          hash,
          ledger: ledgerSeq,
          createdAt: tx.created_at ?? null,
          reason: `Ledger sequence ${ledgerSeq} is below minLedger ${options.minLedger}`,
        });
        continue;
      }
    }

    if (options.maxLedger !== undefined) {
      if (ledgerSeq === null) {
        dropped.push({
          hash,
          ledger: null,
          createdAt: tx.created_at ?? null,
          reason: `Missing ledger sequence while maxLedger filter (${options.maxLedger}) is active`,
        });
        continue;
      }
      if (ledgerSeq > options.maxLedger) {
        dropped.push({
          hash,
          ledger: ledgerSeq,
          createdAt: tx.created_at ?? null,
          reason: `Ledger sequence ${ledgerSeq} is above maxLedger ${options.maxLedger}`,
        });
        continue;
      }
    }

    // Time window filtering
    if (options.fromTime !== undefined) {
      if (!txDate) {
        dropped.push({
          hash,
          ledger: ledgerSeq,
          createdAt: tx.created_at ?? null,
          reason: `Missing or invalid created_at timestamp while fromTime filter is active`,
        });
        continue;
      }
      if (txDate.getTime() < options.fromTime.getTime()) {
        dropped.push({
          hash,
          ledger: ledgerSeq,
          createdAt: tx.created_at ?? null,
          reason: `Timestamp ${tx.created_at} is before fromTime ${options.fromTime.toISOString()}`,
        });
        continue;
      }
    }

    if (options.toTime !== undefined) {
      if (!txDate) {
        dropped.push({
          hash,
          ledger: ledgerSeq,
          createdAt: tx.created_at ?? null,
          reason: `Missing or invalid created_at timestamp while toTime filter is active`,
        });
        continue;
      }
      if (txDate.getTime() > options.toTime.getTime()) {
        dropped.push({
          hash,
          ledger: ledgerSeq,
          createdAt: tx.created_at ?? null,
          reason: `Timestamp ${tx.created_at} is after toTime ${options.toTime.toISOString()}`,
        });
        continue;
      }
    }

    filtered.push(tx);
  }

  return { filtered, dropped };
}

export async function retrieveAndFilterTransactions(
  server: Horizon.Server,
  accountId: string,
  options: {
    minLedger?: number;
    maxLedger?: number;
    fromTime?: Date;
    toTime?: Date;
    pageSize?: number;
    maxPages?: number;
  },
): Promise<{
  transactions: any[];
  dropped: DroppedTransactionInfo[];
  pagesFetched: number;
  totalFetched: number;
}> {
  const pageSize = options.pageSize || DEFAULT_PAGE_SIZE;
  const maxPages = options.maxPages || DEFAULT_MAX_PAGES;

  let page = await server
    .transactions()
    .forAccount(accountId)
    .order('desc')
    .limit(pageSize)
    .call() as unknown as HorizonPage;

  const allRecords: any[] = [...page.records];
  let pagesFetched = 1;
  let lastCursor = '';

  while (page.records.length > 0 && pagesFetched < maxPages) {
    const cursor = String(page.records[page.records.length - 1]?.paging_token ?? '');
    if (cursor && cursor === lastCursor) {
      break;
    }
    lastCursor = cursor;

    try {
      const next = await page.next();
      if (!next || !next.records || next.records.length === 0) {
        break;
      }
      page = next;
      allRecords.push(...page.records);
      pagesFetched++;
    } catch {
      break;
    }
  }

  const { filtered, dropped } = filterTransactions(allRecords, options);
  return {
    transactions: filtered,
    dropped,
    pagesFetched,
    totalFetched: allRecords.length,
  };
}

async function discoverActiveAccount(server: Horizon.Server): Promise<string | null> {
  const page = await server.transactions().order('desc').limit(10).call();
  for (const item of page.records as any[]) {
    const source = typeof item.source_account === 'string' ? item.source_account : '';
    if (source && StrKey.isValidEd25519PublicKey(source)) {
      return source;
    }
  }
  return null;
}

export async function run(params: TransactionHistoryFilteringParams = {}): Promise<void> {
  const horizonUrl = params.horizonUrl || process.env.HORIZON_URL || DEFAULT_HORIZON_URL;
  const server = new Horizon.Server(horizonUrl);
  const json = wantsJson(params);

  let rawAccountId =
    params.accountId?.trim() || process.env.ACCOUNT_ID?.trim() || DEFAULT_ACCOUNT_ID;
  if (!rawAccountId || rawAccountId === DEFAULT_ACCOUNT_ID) {
    try {
      const discovered = await discoverActiveAccount(server);
      if (discovered) {
        rawAccountId = discovered;
      }
    } catch {
      // Fallback to default
    }
  }

  const accountId = validateAccountId(rawAccountId);

  const rawMinLedger = params.minLedger ?? process.env.MIN_LEDGER;
  const rawMaxLedger = params.maxLedger ?? process.env.MAX_LEDGER;
  const { minLedger, maxLedger } = validateLedgerRange(rawMinLedger, rawMaxLedger);

  const rawFromTime = params.fromTime ?? process.env.FROM_TIME;
  const rawToTime = params.toTime ?? process.env.TO_TIME;
  const { fromTime, toTime } = validateTimeWindow(rawFromTime, rawToTime);

  const pageSize = Number(params.pageSize ?? process.env.PAGE_SIZE ?? DEFAULT_PAGE_SIZE);
  const maxPages = Number(params.maxPages ?? process.env.MAX_PAGES ?? DEFAULT_MAX_PAGES);

  if (!json) {
    console.log('\n=== Stellar Transaction History Filtering ===');
    console.log(`Account ID:      ${accountId}`);
    console.log(`Horizon URL:     ${horizonUrl}`);
    console.log(`Ledger Range:    ${minLedger !== undefined ? minLedger : 'Any'} to ${maxLedger !== undefined ? maxLedger : 'Any'}`);
    console.log(`Time Window:     ${fromTime ? fromTime.toISOString() : 'Any'} to ${toTime ? toTime.toISOString() : 'Any'}`);
  }

  try {
    const result = await retrieveAndFilterTransactions(server, accountId, {
      minLedger,
      maxLedger,
      fromTime,
      toTime,
      pageSize,
      maxPages,
    });

    const report: TransactionHistoryReport = {
      accountId,
      horizonUrl,
      requestedLedgerRange: {
        minLedger: minLedger ?? null,
        maxLedger: maxLedger ?? null,
      },
      requestedTimeWindow: {
        fromTime: fromTime ? fromTime.toISOString() : null,
        toTime: toTime ? toTime.toISOString() : null,
      },
      pagesFetched: result.pagesFetched,
      totalFetched: result.totalFetched,
      matchedCount: result.transactions.length,
      droppedCount: result.dropped.length,
      transactions: result.transactions.map((tx: any) => ({
        hash: String(tx.hash ?? ''),
        ledger: getLedgerSequence(tx),
        createdAt: tx.created_at ?? null,
        successful: Boolean(tx.successful),
        operationCount: Number(tx.operation_count ?? 0),
        feeCharged: tx.fee_charged ?? 0,
        memoType: String(tx.memo_type ?? 'none'),
      })),
      droppedTransactions: result.dropped,
    };

    if (json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    console.log(`Pages Fetched:   ${report.pagesFetched}`);
    console.log(`Total Inspected: ${report.totalFetched}`);
    console.log(`Matched Count:   ${report.matchedCount}`);
    console.log(`Dropped Count:   ${report.droppedCount}`);

    if (report.transactions.length === 0) {
      console.log('\nNo transactions matched the specified ledger range and time window.');
      return;
    }

    console.log('\n--- Matching Transactions ---');
    report.transactions.forEach((tx, idx) => {
      console.log(
        `${idx + 1}. Hash: ${tx.hash} | Ledger: ${tx.ledger ?? 'unknown'} | Status: ${tx.successful ? 'success' : 'failed'} | Time: ${tx.createdAt ?? 'unknown'} | Ops: ${tx.operationCount}`,
      );
    });

    if (report.droppedTransactions.length > 0) {
      console.log('\n--- Filtered Out Transactions (Boundary / Scope) ---');
      report.droppedTransactions.slice(0, 5).forEach((dropped, idx) => {
        console.log(`${idx + 1}. Hash: ${dropped.hash} | Reason: ${dropped.reason}`);
      });
      if (report.droppedTransactions.length > 5) {
        console.log(`... and ${report.droppedTransactions.length - 5} more filtered out.`);
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to retrieve and filter transaction history: ${msg}`);
  }
}
