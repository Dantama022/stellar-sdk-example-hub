import { Horizon } from '@stellar/stellar-sdk';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const DEFAULT_PAGE_SIZE = 5;
const DEFAULT_MAX_RECORDS = 15;
const DEFAULT_TIMEOUT_MS = 15_000;

export type PaginationStatus = 'completed' | 'max_records_reached' | 'early_termination' | 'error';

export interface PaginationMetrics {
  collection: string;
  pagesProcessed: number;
  recordsProcessed: number;
  duplicatesSkipped: number;
  status: PaginationStatus;
  errorMessage?: string;
}

export interface PaginationOptions<T> {
  pageSize: number;
  maxRecords?: number;
  requestTimeoutMs?: number;
  shouldStop?: (record: T, metrics: PaginationMetrics) => boolean;
  getRecordId?: (record: T) => string;
}

export interface HorizonPaginationParams {
  horizonUrl?: string;
  pageSize?: string | number;
  maxRecords?: string | number;
  requestTimeoutMs?: string | number;
  json?: boolean | string;
}

export interface HorizonPaginationReport {
  horizonUrl: string;
  collections: Array<{
    collection: string;
    metrics: PaginationMetrics;
    sampleRecordIds: string[];
  }>;
}

type HorizonPage<T> = {
  records: T[];
  next: () => Promise<HorizonPage<T>>;
};

function wantsJson(params: HorizonPaginationParams = {}): boolean {
  return (
    params.json === true ||
    params.json === 'true' ||
    process.env.JSON_OUTPUT === 'true' ||
    process.argv.includes('--json')
  );
}

function readPositiveInt(
  value: string | number | undefined,
  fallback: number,
  label: string,
): number {
  if (value === undefined || value === '') {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(`Ignoring invalid ${label}: ${value}. Using ${fallback}.`);
    return fallback;
  }

  return Math.floor(parsed);
}

export function defaultRecordId(record: Record<string, unknown>): string {
  const candidates = ['id', 'hash', 'paging_token'];
  for (const key of candidates) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }

  return JSON.stringify(record);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`Horizon request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

export async function paginateHorizonCollection<T extends Record<string, unknown>>(
  collectionName: string,
  fetchFirstPage: () => Promise<HorizonPage<T>>,
  options: PaginationOptions<T>,
): Promise<{ records: T[]; metrics: PaginationMetrics }> {
  const metrics: PaginationMetrics = {
    collection: collectionName,
    pagesProcessed: 0,
    recordsProcessed: 0,
    duplicatesSkipped: 0,
    status: 'completed',
  };

  const seen = new Set<string>();
  const records: T[] = [];
  const getRecordId = options.getRecordId ?? ((record) => defaultRecordId(record));
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRecords = options.maxRecords ?? Number.POSITIVE_INFINITY;

  try {
    let page = await withTimeout(fetchFirstPage(), timeoutMs);

    while (page.records.length > 0) {
      metrics.pagesProcessed += 1;

      for (const record of page.records) {
        if (metrics.recordsProcessed >= maxRecords) {
          metrics.status = 'max_records_reached';
          return { records, metrics };
        }

        const recordId = getRecordId(record);
        if (seen.has(recordId)) {
          metrics.duplicatesSkipped += 1;
          continue;
        }

        seen.add(recordId);
        records.push(record);
        metrics.recordsProcessed += 1;

        if (options.shouldStop?.(record, metrics)) {
          metrics.status = 'early_termination';
          return { records, metrics };
        }
      }

      if (metrics.recordsProcessed >= maxRecords) {
        metrics.status = 'max_records_reached';
        return { records, metrics };
      }

      page = await withTimeout(page.next(), timeoutMs);
    }

    return { records, metrics };
  } catch (error) {
    metrics.status = 'error';
    metrics.errorMessage = error instanceof Error ? error.message : String(error);
    return { records, metrics };
  }
}

function printCollectionSummary(
  collection: string,
  metrics: PaginationMetrics,
  sampleRecordIds: string[],
): void {
  console.log(`\n=== ${collection} ===`);
  console.log(`Pages processed:      ${metrics.pagesProcessed}`);
  console.log(`Records processed:    ${metrics.recordsProcessed}`);
  console.log(`Duplicates skipped:   ${metrics.duplicatesSkipped}`);
  console.log(`Pagination status:    ${metrics.status}`);
  if (metrics.errorMessage) {
    console.log(`Error:                ${metrics.errorMessage}`);
  }
  if (sampleRecordIds.length > 0) {
    console.log('Sample record IDs:');
    for (const id of sampleRecordIds) {
      console.log(`  - ${id}`);
    }
  }
}

export async function run(params: HorizonPaginationParams = {}): Promise<void> {
  const horizonUrl = params.horizonUrl || process.env.HORIZON_URL || DEFAULT_HORIZON_URL;
  const pageSize = readPositiveInt(
    params.pageSize ?? process.env.PAGE_SIZE,
    DEFAULT_PAGE_SIZE,
    'pageSize',
  );
  const maxRecords = readPositiveInt(
    params.maxRecords ?? process.env.MAX_RECORDS,
    DEFAULT_MAX_RECORDS,
    'maxRecords',
  );
  const requestTimeoutMs = readPositiveInt(
    params.requestTimeoutMs ?? process.env.REQUEST_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    'requestTimeoutMs',
  );

  const server = new Horizon.Server(horizonUrl);
  const json = wantsJson(params);

  if (!json) {
    console.log('\n=== Generic Horizon Collection Pagination Example ===\n');
    console.log(`Horizon URL: ${horizonUrl}`);
    console.log(`Page size: ${pageSize}`);
    console.log(`Max records per collection: ${maxRecords}`);
    console.log(`Request timeout: ${requestTimeoutMs}ms`);
  }

  const collections: HorizonPaginationReport['collections'] = [];

  const queries: Array<{
    name: string;
    fetch: () => Promise<HorizonPage<Record<string, unknown>>>;
    getRecordId?: (record: Record<string, unknown>) => string;
    shouldStop?: (record: Record<string, unknown>) => boolean;
  }> = [
    {
      name: 'transactions',
      fetch: () =>
        server.transactions().order('desc').limit(pageSize).call() as unknown as Promise<
          HorizonPage<Record<string, unknown>>
        >,
      getRecordId: (record) => String(record.hash ?? record.paging_token),
    },
    {
      name: 'operations',
      fetch: () =>
        server.operations().order('desc').limit(pageSize).call() as unknown as Promise<
          HorizonPage<Record<string, unknown>>
        >,
      getRecordId: (record) => String(record.id ?? record.paging_token),
    },
    {
      name: 'payments',
      fetch: () =>
        server.payments().order('desc').limit(pageSize).call() as unknown as Promise<
          HorizonPage<Record<string, unknown>>
        >,
      getRecordId: (record) => String(record.id ?? record.paging_token),
      shouldStop: (record) => record.type === 'create_account',
    },
  ];

  for (const query of queries) {
    const { records, metrics } = await paginateHorizonCollection(query.name, query.fetch, {
      pageSize,
      maxRecords,
      requestTimeoutMs,
      getRecordId: query.getRecordId,
      shouldStop: query.shouldStop ? (record) => query.shouldStop!(record) : undefined,
    });

    const sampleRecordIds = records
      .slice(0, 3)
      .map((record) => (query.getRecordId ?? defaultRecordId)(record));

    collections.push({
      collection: query.name,
      metrics,
      sampleRecordIds,
    });

    if (!json) {
      printCollectionSummary(query.name, metrics, sampleRecordIds);
    }
  }

  const report: HorizonPaginationReport = {
    horizonUrl,
    collections,
  };

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log('\nPagination helper features demonstrated:');
  console.log('  • Reusable traversal across multiple Horizon collection types');
  console.log('  • Configurable page size, max record limit, and request timeouts');
  console.log('  • Duplicate prevention via stable record identifiers');
  console.log('  • Early termination callback (payments stop at create_account)');
  console.log('  • Per-collection metrics and pagination status reporting');
  console.log('\n=== Example Complete ===\n');
}
