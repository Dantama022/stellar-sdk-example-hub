/** ISSUE-344: Read-only, streaming Horizon scan with durable per-record checkpoints. */
import { readFile, rename, writeFile } from 'fs/promises';
import { dirname, basename } from 'path';

export interface Checkpoint {
  version: 1;
  endpoint: string;
  cursor: string;
  order: 'asc';
}
export interface CheckpointStore {
  load(): Promise<unknown>;
  save(checkpoint: Checkpoint): Promise<void>;
}
export type HorizonRecord = { paging_token: string; [field: string]: unknown };
export type Page = { _embedded: { records: HorizonRecord[] }; _links: { next?: { href: string } } };
export type Sleep = (ms: number) => Promise<void>;
export interface ScanOptions {
  endpoint: string;
  onRecord: (record: HorizonRecord) => Promise<void>;
  store: CheckpointStore;
  fetcher?: typeof fetch;
  sleep?: Sleep;
  pageSize?: number;
  maxRetries?: number;
  timeoutMs?: number;
  maxRecords?: number;
  signal?: AbortSignal;
}

function sameCollection(base: URL, candidate: URL): boolean {
  return base.origin === candidate.origin && base.pathname === candidate.pathname &&
    candidate.searchParams.get('order') === 'asc';
}

export function initialUrl(endpoint: string, pageSize = 50): URL {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) throw new Error('pageSize must be 1..200');
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
    throw new Error('Horizon endpoint requires HTTPS (HTTP is local-only)');
  }
  if (!/\/(operations|transactions)$/.test(url.pathname)) throw new Error('Choose a Horizon operations or transactions collection endpoint');
  if (url.username || url.password || url.hash) throw new Error('Endpoint must not contain credentials or a fragment');
  if (url.searchParams.has('cursor') || url.searchParams.has('order') || url.searchParams.has('limit')) {
    throw new Error('Provide the collection URL without cursor, limit or order');
  }
  url.searchParams.set('order', 'asc');
  url.searchParams.set('limit', String(pageSize));
  return url;
}

export function parseCheckpoint(value: unknown, endpoint: string): Checkpoint | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid checkpoint: object required');
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || v.endpoint !== endpoint || v.order !== 'asc' ||
      typeof v.cursor !== 'string' || !/^[0-9]{1,40}$/.test(v.cursor)) {
    throw new Error('Invalid/stale checkpoint: expected version 1, matching endpoint, ascending numeric cursor');
  }
  return v as unknown as Checkpoint;
}

export class JsonFileCheckpoint implements CheckpointStore {
  constructor(readonly filename: string) {}
  async load(): Promise<unknown> {
    try { return JSON.parse(await readFile(this.filename, 'utf8')) as unknown; }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new Error('Checkpoint unreadable or malformed; inspect or move the file before retrying');
    }
  }
  async save(checkpoint: Checkpoint): Promise<void> {
    // Same-directory rename is atomic on usual local filesystems; one writer per file.
    const temporary = `${dirname(this.filename)}/${basename(this.filename)}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(checkpoint)}\n`, { mode: 0o600 });
    await rename(temporary, this.filename);
  }
}

function parsePage(input: unknown): Page {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid Horizon response: object required');
  const raw = input as Record<string, any>;
  const records: unknown = raw._embedded?.records;
  const next: unknown = raw._links?.next?.href;
  if (!Array.isArray(records) || (next !== undefined && typeof next !== 'string')) {
    throw new Error('Invalid Horizon response: missing records or invalid next link');
  }
  if (records.length > 200 || !records.every((r: unknown) => r && typeof r === 'object' &&
    typeof (r as HorizonRecord).paging_token === 'string' && /^[0-9]+$/.test((r as HorizonRecord).paging_token))) {
    throw new Error('Invalid Horizon response: records require numeric paging_token');
  }
  return raw as Page;
}

export async function fetchPageWithRetry(
  url: URL, fetcher: typeof fetch, sleep: Sleep, maxRetries = 2, timeoutMs = 6000,
  signal?: AbortSignal,
): Promise<Page> {
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 5) throw new Error('maxRetries must be 0..5');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('timeoutMs must be 1..60000');
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (signal?.aborted) throw new Error('Scan interrupted');
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let retry = false;
    try {
      const response = await fetcher(url.toString(), { signal: controller.signal, headers: { Accept: 'application/hal+json, application/json' } });
      if (!response.ok) {
        if ((response.status === 429 || response.status >= 500) && attempt < maxRetries) retry = true;
        else throw new Error(`Horizon HTTP ${response.status}`);
      } else {
        let body: unknown;
        try { body = await response.json(); }
        catch { throw new Error('Invalid Horizon JSON response'); }
        return parsePage(body);
      }
    } catch (err) {
      if (signal?.aborted) throw new Error('Scan interrupted');
      // Network errors/timeouts are retryable, but validation errors and HTTP 4xx are not.
      if (err instanceof Error && (/^(Horizon HTTP|Invalid Horizon)/.test(err.message))) throw err;
      if (attempt >= maxRetries) throw new Error('Horizon network or timeout error; retries exhausted');
      retry = true;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    if (retry) await sleep(Math.min(250 * 2 ** attempt, 2000));
  }
  throw new Error('Horizon retries exhausted');
}

export async function scanHorizon(options: ScanOptions): Promise<number> {
  const base = initialUrl(options.endpoint, options.pageSize);
  const storeKey = `${base.origin}${base.pathname}`;
  const saved = parseCheckpoint(await options.store.load(), storeKey);
  const fetcher = options.fetcher || fetch;
  const sleep = options.sleep || ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let url = new URL(base);
  if (saved) url.searchParams.set('cursor', saved.cursor);
  let previous = saved?.cursor;
  let count = 0;
  const maxRecords = options.maxRecords ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 0) throw new Error('maxRecords must be a nonnegative integer');
  while (count < maxRecords) {
    if (options.signal?.aborted) throw new Error('Scan interrupted');
    const page = await fetchPageWithRetry(url, fetcher, sleep, options.maxRetries, options.timeoutMs, options.signal);
    if (page._embedded.records.length === 0) break;
    for (const record of page._embedded.records) {
      if (options.signal?.aborted) throw new Error('Scan interrupted');
      if (previous !== undefined && BigInt(record.paging_token) <= BigInt(previous)) {
        throw new Error('Non-increasing Horizon cursor; scan stopped');
      }
      await options.onRecord(record);
      // On failure above, checkpoint stays at the last successfully processed record.
      const next: Checkpoint = { version: 1, endpoint: storeKey, order: 'asc', cursor: record.paging_token };
      await options.store.save(next);
      previous = record.paging_token;
      count += 1;
      if (count >= maxRecords) return count;
    }
    if (!page._links.next?.href) break;
    const nextUrl = new URL(page._links.next.href, base);
    if (!sameCollection(base, nextUrl)) throw new Error('Unsafe or invalid Horizon next link');
    if (nextUrl.searchParams.get('cursor') !== previous) throw new Error('Horizon next link does not match processed cursor');
    url = nextUrl;
  }
  return count;
}

export async function run(): Promise<void> {
  const endpoint = process.env.HORIZON_COLLECTION_URL || 'https://horizon-testnet.stellar.org/operations';
  const filename = process.env.HORIZON_CHECKPOINT || '.horizon-resume.json';
  const count = await scanHorizon({
    endpoint, store: new JsonFileCheckpoint(filename), maxRecords: 20,
    onRecord: async (record) => { console.log(`Processed cursor ${record.paging_token}`); },
  });
  console.log(`Processed ${count} records; checkpoint stored at ${filename}`);
}
