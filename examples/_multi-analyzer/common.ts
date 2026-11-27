/** Read-only Horizon/RPC transport and 7-decimal, BigInt-based arithmetic. */
import { StrKey } from '@stellar/stellar-sdk';

export type Network = 'testnet' | 'public' | 'futurenet';
export type Fetcher = typeof fetch;
export const SCALE = 10_000_000n;
const HORIZON: Record<Network, string> = {
  testnet: 'https://horizon-testnet.stellar.org',
  public: 'https://horizon.stellar.org',
  futurenet: 'https://horizon-futurenet.stellar.org',
};

export function horizonEndpoint(network: Network, custom?: string): string {
  if (!(network in HORIZON)) throw new Error('Unsupported Stellar network');
  const endpoint = custom ?? HORIZON[network];
  return endpointUrl(endpoint);
}

export function endpointUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error('Remote endpoints must use HTTPS');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Unsupported URL scheme');
  if (url.username || url.password || url.search || url.hash) throw new Error('Endpoint must not contain credentials or query parameters');
  return url.toString().replace(/\/$/, '');
}

export function assertAccount(account: string): void {
  if (!StrKey.isValidEd25519PublicKey(account)) throw new Error(`Invalid Stellar G-account: ${account}`);
}

export function assertHexId(id: string, label: string): void {
  if (!/^[a-fA-F0-9]{64}$/.test(id)) throw new Error(`Invalid ${label}: expected 64 hexadecimal characters`);
}

/** Only non-negative Stellar decimal quantities, no floats or exponent notation. */
export function toUnits(input: string): bigint {
  if (typeof input !== 'string' || !/^(0|[1-9]\d*)(?:\.(\d{1,7}))?$/.test(input)) {
    throw new Error(`Invalid 7-decimal quantity: ${String(input)}`);
  }
  const [integer, fractional = ''] = input.split('.');
  return BigInt(integer) * SCALE + BigInt(fractional.padEnd(7, '0'));
}

export function fromUnits(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  return `${negative ? '-' : ''}${absolute / SCALE}.${String(absolute % SCALE).padStart(7, '0')}`;
}

/** Exact rational division, rounded to the nearest 1e-7 output unit. */
export function multipliedDivided(value: bigint, numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n || numerator < 0n || value < 0n) throw new Error('Invalid ratio inputs');
  return (value * numerator + denominator / 2n) / denominator;
}

export function percent(numerator: bigint, denominator: bigint, places = 4): string | null {
  if (denominator <= 0n) return null;
  if (places < 0 || places > 10 || !Number.isInteger(places)) throw new Error('Invalid percent precision');
  const scale = 10n ** BigInt(places);
  const negative = numerator < 0n;
  const n = negative ? -numerator : numerator;
  const total = (n * 100n * scale + denominator / 2n) / denominator;
  return `${negative ? '-' : ''}${total / scale}${places ? '.' + String(total % scale).padStart(places, '0') : ''}`;
}

export async function getJson<T>(base: string, pathname: string, fetcher: Fetcher = fetch): Promise<T> {
  const url = new URL(pathname.startsWith('/') ? pathname : '/' + pathname, base + '/');
  if (url.origin !== new URL(base).origin) throw new Error('Cross-origin Horizon pagination is not supported');
  let response: Response;
  try { response = await fetcher(url.toString(), { headers: { accept: 'application/json' } }); }
  catch (error) { throw new Error(`Horizon network failure: ${String(error)}`); }
  if (!response.ok) throw new Error(`Horizon request failed (${response.status}) for ${url.pathname}`);
  return response.json() as Promise<T>;
}

export async function rpcCall<T>(endpoint: string, method: string, params: object, fetcher: Fetcher = fetch): Promise<T> {
  const url = endpointUrl(endpoint);
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
  } catch (error) { throw new Error(`RPC network failure: ${String(error)}`); }
  if (!response.ok) throw new Error(`RPC HTTP failure: ${response.status}`);
  const payload = await response.json() as { result?: T; error?: { message?: string } };
  if (payload.error) throw new Error(`RPC error: ${payload.error.message ?? 'unknown error'}`);
  if (!payload.result) throw new Error('RPC returned no result');
  return payload.result;
}

export interface PageResult<T> { records: T[]; complete: boolean; pages: number; warnings: string[] }

/** Bounded ascending pagination, deduplication and explicit completeness status. */
export async function readPages<T extends { paging_token?: string; id?: string | number }>(
  base: string, path: string, maxPages: number, fetcher: Fetcher = fetch,
): Promise<PageResult<T>> {
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 1000) throw new Error('maxPages must be in 1..1000');
  const records: T[] = []; const warnings: string[] = []; const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const url = new URL(path, base + '/');
    url.searchParams.set('order', 'asc'); url.searchParams.set('limit', '200');
    if (cursor) url.searchParams.set('cursor', cursor);
    let batch: T[];
    try {
      const body = await getJson<{ _embedded?: { records?: T[] } }>(base, url.pathname + url.search, fetcher);
      if (!Array.isArray(body._embedded?.records)) throw new Error('Invalid Horizon page format');
      batch = body._embedded.records;
    } catch (error) {
      if (page === 0) throw error;
      warnings.push(`History interrupted after ${page} page(s): ${String(error)}`);
      return { records, complete: false, pages: page, warnings };
    }
    for (const entry of batch) {
      const id = String(entry.id ?? entry.paging_token ?? '');
      if (!id) { warnings.push('Record missing ID; cannot reliably deduplicate'); continue; }
      if (!seen.has(id)) { records.push(entry); seen.add(id); }
    }
    if (batch.length < 200) return { records, complete: true, pages: page + 1, warnings };
    const next = batch[batch.length - 1]?.paging_token;
    if (!next || next === cursor) {
      warnings.push('Horizon returned a full page without a new cursor');
      return { records, complete: false, pages: page + 1, warnings };
    }
    cursor = next;
  }
  warnings.push(`Stopped at configured maxPages=${maxPages}; later history may be missing`);
  return { records, complete: false, pages: maxPages, warnings };
}

export function terminalReport(report: unknown): string {
  return JSON.stringify(report, null, 2); // Simple, deterministic and readable in terminals.
}
