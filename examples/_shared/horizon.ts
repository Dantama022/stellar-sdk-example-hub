/** Read-only Horizon helpers shared by the four analysis examples. Node >=18. */
import { StrKey } from '@stellar/stellar-sdk';

export type Network = 'testnet' | 'public';
export type JsonFetcher = typeof fetch;
export const SCALE = 10_000_000n;

export function horizonOrigin(network: Network): string {
  if (network === 'testnet') return 'https://horizon-testnet.stellar.org';
  if (network === 'public') return 'https://horizon.stellar.org';
  throw new Error('Unsupported network; use testnet or public');
}

export function validateAccount(id: string): void {
  if (!StrKey.isValidEd25519PublicKey(id)) throw new Error('Invalid Stellar G-account ID');
}

export function parseUnits(value: string, label = 'amount'): bigint {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d{1,7})?$/.test(value)) {
    throw new Error(`${label} must be a non-negative decimal with at most 7 places`);
  }
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(7, '0'));
}

export function units(value: bigint): string {
  const sign = value < 0n ? '-' : '';
  const n = value < 0n ? -value : value;
  const decimals = (n % SCALE).toString().padStart(7, '0').replace(/0+$/, '');
  return sign + (n / SCALE).toString() + (decimals ? `.${decimals}` : '');
}

export function parseStroops(value: string | bigint, label: string): bigint {
  const n = typeof value === 'bigint' ? value
    : typeof value === 'string' && /^[1-9]\d*$/.test(value) ? BigInt(value) : 0n;
  if (n > 0n && n <= 9_223_372_036_854_775_807n) return n;
  throw new Error(`${label} must be positive integer stroops within signed 64-bit range`);
}

export function percent(part: bigint, total: bigint): number | null {
  if (total <= 0n) return null;
  // Four decimal places, no float arithmetic in intermediate calculations.
  return Number((part * 1_000_000n) / total) / 10_000;
}

export async function getJson<T>(
  network: Network,
  pathOrUrl: string,
  fetcher: JsonFetcher = fetch,
): Promise<T> {
  const origin = horizonOrigin(network);
  const url = new URL(pathOrUrl, origin);
  if (url.origin !== origin || url.username || url.password) {
    throw new Error('Unexpected pagination URL outside the selected Horizon network');
  }
  let response: Response;
  try {
    response = await fetcher(url.toString());
  } catch (error) {
    throw new Error(`Horizon network failure: ${String(error)}`);
  }
  if (!response.ok) {
    if (response.status === 404) throw new Error('Account or transaction not found on Horizon');
    throw new Error(`Horizon HTTP ${response.status}`);
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new Error('Horizon returned invalid JSON');
  }
}

export interface HorizonBalance {
  asset_type: string;
  balance: string;
  asset_code?: string;
  asset_issuer?: string;
  liquidity_pool_id?: string;
  limit?: string;
  buying_liabilities?: string;
  selling_liabilities?: string;
  is_authorized?: boolean;
  is_authorized_to_maintain_liabilities?: boolean;
  is_clawback_enabled?: boolean;
  sponsor?: string;
}

export interface HorizonAccount {
  account_id: string;
  sequence: string;
  balances: HorizonBalance[];
  subentry_count?: number;
  num_sponsoring?: number;
  num_sponsored?: number;
  sponsor?: string;
  signers?: Array<{ key: string; type?: string; sponsor?: string }>;
}

export async function loadAccount(
  accountId: string,
  network: Network,
  fetcher: JsonFetcher = fetch,
): Promise<HorizonAccount> {
  validateAccount(accountId);
  const account = await getJson<HorizonAccount>(
    network, `/accounts/${accountId}`, fetcher,
  );
  if (account.account_id !== accountId || !Array.isArray(account.balances)) {
    throw new Error('Horizon account response is incomplete or inconsistent');
  }
  return account;
}

export interface Page<T> {
  _embedded: { records: T[] };
  _links?: { next?: { href?: string } };
}

/** Walk at most maxPages and indicate whether more history might remain. */
export async function pages<T>(
  network: Network,
  firstPath: string,
  maxPages = 10,
  fetcher: JsonFetcher = fetch,
): Promise<{ records: T[]; complete: boolean }> {
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) {
    throw new Error('maxPages must be an integer between 1 and 100');
  }
  const records: T[] = [];
  const visited = new Set<string>();
  let next: string | undefined = firstPath;
  for (let page = 0; page < maxPages && next; page++) {
    const href: string = new URL(next, horizonOrigin(network)).toString();
    if (visited.has(href)) throw new Error('Horizon pagination loop detected');
    visited.add(href);
    const result: Page<T> = await getJson<Page<T>>(network, next, fetcher);
    if (!Array.isArray(result._embedded?.records)) throw new Error('Incomplete Horizon page');
    const batch: T[] = result._embedded.records;
    records.push(...batch);
    // A full page *may* have more results, but the next link exists even for an empty page.
    if (batch.length < 200) return { records, complete: true };
    next = result._links?.next?.href;
    if (!next) return { records, complete: false };
  }
  return { records, complete: !next };
}
