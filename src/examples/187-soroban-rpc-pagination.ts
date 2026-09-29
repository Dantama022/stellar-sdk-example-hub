import { rpc } from '@stellar/stellar-sdk';
import chalk from 'chalk';

export interface SorobanPaginationParams {
  rpcUrl?: string;
  pageSize?: number | string;
  maxPages?: number | string;
  startCursor?: string;
  timeoutMs?: number | string;
  json?: boolean | string;
}

export interface SorobanPage<T = Record<string, unknown>> {
  records: T[];
  next?: string | null;
  cursor?: string | null;
}

export interface SorobanPaginationResult<T = Record<string, unknown>> {
  rpcUrl: string;
  pagesProcessed: number;
  recordsProcessed: number;
  currentCursor?: string;
  finalCursor?: string;
  repeatedCursor: boolean;
  status: 'completed' | 'empty' | 'max_pages_reached' | 'repeated_cursor' | 'error';
  error?: string;
  pageSummaries: Array<{
    pageNumber: number;
    recordCount: number;
    cursorUsed?: string;
    nextCursor?: string;
  }>;
  records: T[];
}

export function buildSorobanRpcEventRequest({
  startLedger,
  cursor,
  limit,
  filters = [],
}: {
  startLedger?: number;
  cursor?: string;
  limit: number;
  filters?: Array<Record<string, unknown>>;
}): Record<string, unknown> {
  if (cursor) {
    return {
      limit,
      cursor,
      filters,
    };
  }

  return {
    startLedger,
    limit,
    filters,
  };
}

function prefersJson(params?: SorobanPaginationParams): boolean {
  return (
    params?.json === true ||
    params?.json === 'true' ||
    process.env.JSON_OUTPUT === 'true' ||
    process.argv.includes('--json')
  );
}

function readPositiveInt(value: number | string | undefined, fallback: number, field: string): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${field}: ${value}. Expected a positive integer.`);
  }
  return Math.floor(parsed);
}

export async function paginateSorobanRpc<T = Record<string, unknown>>({
  fetchPage,
  maxPages,
  startCursor,
  timeoutMs = 15_000,
}: {
  fetchPage: (cursor?: string) => Promise<SorobanPage<T>>;
  limit?: number;
  maxPages?: number;
  startCursor?: string;
  timeoutMs?: number;
}): Promise<SorobanPaginationResult<T>> {
  const allowedPages = readPositiveInt(maxPages ?? 5, 5, 'maxPages');
  const deadline = timeoutMs;
  const pageSummaries: SorobanPaginationResult<T>['pageSummaries'] = [];
  const records: T[] = [];

  let cursor = startCursor;
  let pagesProcessed = 0;
  let recordsProcessed = 0;
  let repeatedCursor = false;
  let finalCursor: string | undefined;
  let currentCursor: string | undefined = cursor;
  const seen = new Set<string>();

  while (pagesProcessed < allowedPages) {
    pagesProcessed += 1;
    const cursorUsed = cursor;

    let timeoutHandle: NodeJS.Timeout | undefined;
    const page = await Promise.race([
      fetchPage(cursor),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error(`RPC pagination timed out after ${deadline}ms`)), deadline);
      }),
    ]).finally(() => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    });

    if (!page || typeof page !== 'object' || (!Array.isArray((page as any).records) && !Array.isArray((page as any).events))) {
      throw new Error('Malformed pagination response: expected an object with a records array.');
    }

    const pageRecords = Array.isArray((page as any).records) ? (page as any).records : (page as any).events;
    const nextCursor = (page as any).next ?? (page as any).cursor ?? null;

    if (cursor && seen.has(cursor)) {
      repeatedCursor = true;
      finalCursor = cursor;
      return {
        rpcUrl: 'local',
        pagesProcessed,
        recordsProcessed,
        currentCursor,
        finalCursor,
        repeatedCursor,
        status: 'repeated_cursor',
        pageSummaries,
        records,
      };
    }

    if (cursor) {
      seen.add(cursor);
    }

    pagesProcessed = Math.min(pagesProcessed, allowedPages);
    const pageRecordCount = pageRecords.length;
    records.push(...pageRecords);
    recordsProcessed += pageRecordCount;

    pageSummaries.push({
      pageNumber: pagesProcessed,
      recordCount: pageRecordCount,
      cursorUsed,
      nextCursor: nextCursor ?? undefined,
    });

    if (pageRecordCount === 0) {
      finalCursor = nextCursor ?? cursor;
      return {
        rpcUrl: 'local',
        pagesProcessed,
        recordsProcessed,
        currentCursor,
        finalCursor,
        repeatedCursor,
        status: 'empty',
        pageSummaries,
        records,
      };
    }

    if (nextCursor == null || nextCursor === '') {
      finalCursor = cursor;
      return {
        rpcUrl: 'local',
        pagesProcessed,
        recordsProcessed,
        currentCursor,
        finalCursor,
        repeatedCursor,
        status: 'completed',
        pageSummaries,
        records,
      };
    }

    if (cursor !== undefined && cursor === nextCursor) {
      repeatedCursor = true;
      finalCursor = cursor;
      return {
        rpcUrl: 'local',
        pagesProcessed,
        recordsProcessed,
        currentCursor,
        finalCursor,
        repeatedCursor,
        status: 'repeated_cursor',
        pageSummaries,
        records,
      };
    }

    cursor = String(nextCursor);
    currentCursor = cursor;
    finalCursor = cursor;

    if (pagesProcessed >= allowedPages) {
      return {
        rpcUrl: 'local',
        pagesProcessed,
        recordsProcessed,
        currentCursor,
        finalCursor,
        repeatedCursor,
        status: 'max_pages_reached',
        pageSummaries,
        records,
      };
    }
  }

  return {
    rpcUrl: 'local',
    pagesProcessed,
    recordsProcessed,
    currentCursor,
    finalCursor,
    repeatedCursor,
    status: 'completed',
    pageSummaries,
    records,
  };
}

export async function run(params: SorobanPaginationParams = {}): Promise<void> {
  const rpcUrl = (() => {
    try {
      return new URL(params.rpcUrl ?? process.env.SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org').toString();
    } catch {
      return 'https://soroban-testnet.stellar.org';
    }
  })();

  const pageSize = readPositiveInt(params.pageSize ?? process.env.PAGE_SIZE ?? '10', 10, 'pageSize');
  const maxPages = readPositiveInt(params.maxPages ?? process.env.MAX_PAGES ?? '5', 5, 'maxPages');
  const timeoutMs = readPositiveInt(params.timeoutMs ?? process.env.RPC_TIMEOUT_MS ?? '15000', 15000, 'timeoutMs');
  const jsonOutput = prefersJson(params);

  if (!jsonOutput) {
    console.log(chalk.bold('\n=== Soroban RPC Pagination Example ==='));
    console.log(`RPC endpoint:        ${rpcUrl}`);
    console.log(`Page size:           ${pageSize}`);
    console.log(`Max pages:           ${maxPages}`);
    console.log(`Start cursor:        ${params.startCursor ?? 'none'}`);
  }

  const server = new rpc.Server(rpcUrl);

  const latestLedger = await server.getLatestLedger().catch(() => ({ sequence: 1 }));
  const startLedger = Math.max(1, latestLedger.sequence - 1000);

  const fetchPage = async (cursor?: string): Promise<SorobanPage> => {
    const request = buildSorobanRpcEventRequest({
      startLedger: cursor ? undefined : startLedger,
      cursor,
      limit: pageSize,
      filters: [],
    });
    const response = await server.getEvents(request as any);

    if (!response || typeof response !== 'object' || !Array.isArray((response as any).events)) {
      throw new Error('Malformed pagination response: expected an events array.');
    }

    return {
      records: (response as any).events,
      next: (response as any).next ?? (response as any).cursor ?? null,
      cursor: (response as any).cursor ?? (response as any).next ?? null,
    };
  };

  const result = await paginateSorobanRpc({
    fetchPage,
    limit: pageSize,
    maxPages,
    startCursor: params.startCursor,
    timeoutMs,
  });

  result.rpcUrl = rpcUrl;

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`Pages processed:      ${result.pagesProcessed}`);
  console.log(`Records processed:    ${result.recordsProcessed}`);
  console.log(`Current cursor:       ${result.currentCursor ?? 'n/a'}`);
  console.log(`Final cursor:         ${result.finalCursor ?? 'n/a'}`);
  console.log(`Repeated cursor:      ${result.repeatedCursor ? 'yes' : 'no'}`);
  console.log(`Status:              ${result.status}`);

  if (result.error) {
    console.log(chalk.red(`Error:               ${result.error}`));
  }

  for (const pageSummary of result.pageSummaries) {
    console.log(
      `Page ${pageSummary.pageNumber}: ${pageSummary.recordCount} records, cursor=${pageSummary.cursorUsed ?? 'start'}, next=${pageSummary.nextCursor ?? 'none'}`,
    );
  }
}
