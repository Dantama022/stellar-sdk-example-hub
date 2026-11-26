/** Read-only Horizon HTTP and exact, seven-decimal Stellar amount helpers. */
import { StrKey } from '@stellar/stellar-sdk';

export type Network = 'testnet' | 'public' | 'futurenet';
export const HORIZON: Record<Network, string> = {
  testnet: 'https://horizon-testnet.stellar.org',
  public: 'https://horizon.stellar.org',
  futurenet: 'https://horizon-futurenet.stellar.org',
};
export const SCALE = 10_000_000n;

export function endpoint(network: Network, override?: string): string {
  if (!(network in HORIZON)) throw new Error('Unsupported Stellar network');
  const value = override ?? HORIZON[network];
  const url = new URL(value);
  if (url.protocol !== 'https:' && !(url.hostname === 'localhost' && url.protocol === 'http:')) {
    throw new Error('Horizon endpoint must use HTTPS (HTTP allowed only on localhost)');
  }
  return value.replace(/\/$/, '');
}

export function accountId(account: string): string {
  if (!StrKey.isValidEd25519PublicKey(account)) throw new Error('Invalid Stellar G-account ID');
  return account;
}

/** Exact decimal to fixed-point stroops. Rejects extra precision instead of rounding. */
export function toUnits(value: string): bigint {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d{1,7})?$/.test(value)) {
    throw new Error(`Invalid nonnegative Stellar decimal: ${String(value)}`);
  }
  const [whole, fractional = ''] = value.split('.');
  return BigInt(whole) * SCALE + BigInt(fractional.padEnd(7, '0'));
}

export function unitsToDecimal(value: bigint): string {
  const sign = value < 0n ? '-' : '';
  const abs = value < 0n ? -value : value;
  return `${sign}${abs / SCALE}.${(abs % SCALE).toString().padStart(7, '0')}`;
}

/** Rounded decimal quotient of exact integer numerator / denominator. */
export function ratio(numerator: bigint, denominator: bigint, digits = 4): string {
  if (denominator <= 0n || numerator < 0n || !Number.isSafeInteger(digits) || digits < 0 || digits > 12) {
    throw new Error('Invalid ratio inputs');
  }
  const scale = 10n ** BigInt(digits);
  const scaled = (numerator * scale * 2n + denominator) / (denominator * 2n);
  return digits === 0 ? scaled.toString() :
    `${scaled / scale}.${(scaled % scale).toString().padStart(digits, '0')}`;
}

export interface HttpClient { get<T>(url: string): Promise<T> }
export class HorizonHttp implements HttpClient {
  async get<T>(url: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`Horizon HTTP ${response.status}: ${url}`);
      return await response.json() as T;
    } finally { clearTimeout(timer); }
  }
}

export interface Page<T> {
  _embedded: { records: T[] };
  _links?: { next?: { href: string } };
}

/** Walk all pages until exhausted or the explicit cap is reached. Throw on incomplete retrieval. */
export async function allPages<T>(client: HttpClient, firstUrl: string, maxRecords = 10_000): Promise<T[]> {
  if (!Number.isSafeInteger(maxRecords) || maxRecords <= 0) throw new Error('Invalid record limit');
  const records: T[] = [];
  const seen = new Set<string>();
  let next: string | undefined = firstUrl;
  while (next) {
    if (seen.has(next)) throw new Error('Repeated pagination URL');
    seen.add(next);
    const page: Page<T> = await client.get<Page<T>>(next);
    if (!Array.isArray(page._embedded?.records)) throw new Error('Malformed Horizon page');
    records.push(...page._embedded.records);
    const nextHref: string | undefined = page._links?.next?.href;
    if (records.length > maxRecords) throw new Error('Historical result cap exceeded: range is incomplete');
    if (!page._embedded.records.length || !nextHref) break;
    // Horizon's last page may advertise a next URL even if it is empty.
    next = nextHref;
  }
  return records;
}

export function validateRange(start: number, end: number, max = 500): void {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end - start + 1 > max) {
    throw new Error(`Invalid ledger range (must contain 1-${max} ledgers)`);
  }
}
export function jsonReport(value: unknown): string { return JSON.stringify(value, null, 2); }
