import { Horizon, StrKey } from '@stellar/stellar-sdk';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const DEFAULT_PAGE_SIZE = 10;
const DEFAULT_MAX_RECORDS = 50;
const MAX_HORIZON_LIMIT = 200;

export interface AccountHistoryParams {
  accountId?: string;
  pageSize?: string | number;
  maxRecords?: string | number;
  operationType?: string;
  horizonUrl?: string;
  json?: boolean | string;
}

export interface RawOperationRecord {
  [key: string]: unknown;
  id?: string;
  paging_token?: string;
  type?: string;
  transaction_hash?: string;
  ledger?: number;
  ledger_attr?: number;
  source_account?: string;
  created_at?: string;
}

export interface ParsedOperation {
  id: string;
  type: string;
  transactionHash: string;
  ledgerSequence: number | null;
  sourceAccount: string;
  timestamp: string;
  pagingToken: string;
}

export interface AccountHistoryReport {
  accountId: string;
  operationType: string | null;
  pageSize: number;
  maxRecords: number;
  pagesProcessed: number;
  recordsProcessed: number;
  duplicatesSkipped: number;
  operations: ParsedOperation[];
}

interface HorizonPage {
  records: RawOperationRecord[];
  next: () => Promise<HorizonPage>;
}

export interface PaginationOptions {
  pageSize: number;
  maxRecords: number;
  operationType?: string;
}

function wantsJson(params: AccountHistoryParams): boolean {
  return (
    params.json === true ||
    params.json === 'true' ||
    process.env.JSON_OUTPUT === 'true' ||
    process.argv.includes('--json')
  );
}

function normalizePositiveInt(value: string | number | undefined, fallback: number): number {
  const parsed = typeof value === 'string' ? Number.parseInt(value.trim(), 10) : value;
  if (parsed === undefined || parsed === null || !Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.trunc(parsed);
}

export function normalizePageSize(
  value: string | number | undefined,
  fallback = DEFAULT_PAGE_SIZE,
): number {
  return Math.min(normalizePositiveInt(value, fallback), MAX_HORIZON_LIMIT);
}

export function normalizeMaxRecords(
  value: string | number | undefined,
  fallback = DEFAULT_MAX_RECORDS,
): number {
  return normalizePositiveInt(value, fallback);
}

export function validateAccountId(value: string): string {
  const accountId = value.trim();
  if (!StrKey.isValidEd25519PublicKey(accountId)) {
    throw new Error('Account ID must be a valid Stellar G... public key.');
  }
  return accountId;
}

export function parseOperationRecord(record: RawOperationRecord): ParsedOperation {
  return {
    id: String(record.id ?? record.paging_token ?? ''),
    type: String(record.type ?? 'unknown'),
    transactionHash: String(record.transaction_hash ?? ''),
    ledgerSequence:
      typeof (record.ledger_attr ?? record.ledger) === 'number'
        ? Number(record.ledger_attr ?? record.ledger)
        : null,
    sourceAccount: String(record.source_account ?? ''),
    timestamp: String(record.created_at ?? ''),
    pagingToken: String(record.paging_token ?? record.id ?? ''),
  };
}

export async function paginateAccountOperations(
  fetchFirstPage: () => Promise<HorizonPage>,
  options: PaginationOptions,
): Promise<Omit<AccountHistoryReport, 'accountId'>> {
  const operationType = options.operationType?.trim().toLowerCase() || undefined;
  const seen = new Set<string>();
  const operations: ParsedOperation[] = [];
  let pagesProcessed = 0;
  let duplicatesSkipped = 0;
  let lastCursor = '';
  let page = await fetchFirstPage();

  while (page.records.length > 0 && operations.length < options.maxRecords) {
    pagesProcessed += 1;

    for (const raw of page.records) {
      const parsed = parseOperationRecord(raw);
      const identity = parsed.id || parsed.pagingToken;
      if (identity && seen.has(identity)) {
        duplicatesSkipped += 1;
        continue;
      }
      if (identity) {
        seen.add(identity);
      }

      if (operationType && parsed.type.toLowerCase() !== operationType) {
        continue;
      }

      operations.push(parsed);
      if (operations.length >= options.maxRecords) {
        break;
      }
    }

    if (operations.length >= options.maxRecords) {
      break;
    }

    const cursor = String(page.records[page.records.length - 1]?.paging_token ?? '');
    if (cursor && cursor === lastCursor) {
      break;
    }
    lastCursor = cursor;
    page = await page.next();
  }

  return {
    operationType: operationType ?? null,
    pageSize: options.pageSize,
    maxRecords: options.maxRecords,
    pagesProcessed,
    recordsProcessed: operations.length,
    duplicatesSkipped,
    operations,
  };
}

async function discoverActiveAccount(server: Horizon.Server): Promise<string | null> {
  const page = await server.operations().order('desc').limit(20).call();
  for (const item of page.records as unknown as RawOperationRecord[]) {
    const source = typeof item.source_account === 'string' ? item.source_account : '';
    if (source && StrKey.isValidEd25519PublicKey(source)) {
      return source;
    }
  }
  return null;
}

export async function run(params: AccountHistoryParams = {}): Promise<void> {
  const horizonUrl = params.horizonUrl || process.env.HORIZON_URL || DEFAULT_HORIZON_URL;
  const pageSize = normalizePageSize(params.pageSize ?? process.env.PAGE_SIZE, DEFAULT_PAGE_SIZE);
  const maxRecords = normalizeMaxRecords(
    params.maxRecords ?? process.env.MAX_RECORDS,
    DEFAULT_MAX_RECORDS,
  );
  const operationType =
    params.operationType?.trim() || process.env.OPERATION_TYPE?.trim() || undefined;
  const server = new Horizon.Server(horizonUrl);
  const json = wantsJson(params);

  let input = params.accountId?.trim() || process.env.ACCOUNT_ID?.trim();
  if (!input) {
    if (!json) {
      console.log('No account supplied; discovering a recently active account.');
    }
    input = (await discoverActiveAccount(server)) ?? undefined;
  }
  if (!input) {
    throw new Error('Could not discover an account with operation history.');
  }

  const accountId = validateAccountId(input);

  try {
    const reportBody = await paginateAccountOperations(
      async () =>
        (await server
          .operations()
          .forAccount(accountId)
          .order('asc')
          .limit(pageSize)
          .call()) as unknown as HorizonPage,
      { pageSize, maxRecords, operationType },
    );
    const report: AccountHistoryReport = { accountId, ...reportBody };

    if (json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    console.log('\n=== Horizon Account History Pagination ===');
    console.log(`Account:              ${accountId}`);
    console.log(`Page size:            ${pageSize}`);
    console.log(`Maximum records:      ${maxRecords}`);
    console.log(`Operation filter:     ${report.operationType ?? 'None'}`);
    console.log(`Pages processed:      ${report.pagesProcessed}`);
    console.log(`Records processed:    ${report.recordsProcessed}`);
    console.log(`Duplicates skipped:   ${report.duplicatesSkipped}`);

    if (report.operations.length === 0) {
      console.log('\nNo matching operation history was found for this account.');
      return;
    }

    for (const operation of report.operations) {
      console.log('\n--- Operation ---');
      console.log(`Operation ID:     ${operation.id}`);
      console.log(`Type:             ${operation.type}`);
      console.log(`Transaction hash: ${operation.transactionHash || 'Unavailable'}`);
      console.log(`Ledger sequence:  ${operation.ledgerSequence ?? 'Unavailable'}`);
      console.log(`Source account:   ${operation.sourceAccount || 'Unavailable'}`);
      console.log(`Timestamp:        ${operation.timestamp || 'Unavailable'}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to retrieve account history from Horizon: ${message}`);
  }
}
