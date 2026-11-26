/** Read-only Horizon helpers; no signing keys or transaction submission. Node >=18. */
import { StrKey } from '@stellar/stellar-sdk';

export type Network = 'testnet' | 'public';
export type Fetcher = typeof fetch;
export const STROOPS = 10_000_000n;
const MAX_SIGNED_64 = 9_223_372_036_854_775_807n;

export function origin(network: Network): string {
  if (network === 'testnet') return 'https://horizon-testnet.stellar.org';
  if (network === 'public') return 'https://horizon.stellar.org';
  throw new Error('Unsupported network: use testnet or public');
}
export function validAccount(accountId: string): void {
  if (!StrKey.isValidEd25519PublicKey(accountId)) throw new Error('Invalid Stellar account ID (expected G-address)');
}
export function stroops(value: string | bigint, label = 'base reserve'): bigint {
  const amount = typeof value === 'bigint' ? value : /^\d+$/.test(value) ? BigInt(value) : -1n;
  if (amount <= 0n || amount > MAX_SIGNED_64) throw new Error(`${label} must be positive integer stroops`);
  return amount;
}
/** Convert exact nonnegative Stellar amounts without floating point. */
export function amountToUnits(value: string, label = 'amount'): bigint {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d{1,7})?$/.test(value)) {
    throw new Error(`Invalid ${label}; expected nonnegative decimal with <=7 places`);
  }
  const [whole, fraction = ''] = value.split('.');
  const units = BigInt(whole) * STROOPS + BigInt(fraction.padEnd(7, '0'));
  if (units > MAX_SIGNED_64) throw new Error(`${label} is out of range`);
  return units;
}
export function unitsToAmount(value: bigint): string {
  const sign = value < 0n ? '-' : '';
  const abs = value < 0n ? -value : value;
  const frac = (abs % STROOPS).toString().padStart(7, '0').replace(/0+$/, '');
  return `${sign}${abs / STROOPS}${frac ? '.' + frac : ''}`;
}
export function assetId(assetType: string, code?: string, issuer?: string, poolId?: string): string {
  if (assetType === 'native') return 'XLM';
  if (assetType === 'liquidity_pool_shares') {
    if (!poolId) throw new Error('Missing liquidity pool ID');
    return `POOL:${poolId}`;
  }
  if (assetType !== 'credit_alphanum4' && assetType !== 'credit_alphanum12') throw new Error(`Unsupported asset type ${assetType}`);
  if (!code || !issuer) throw new Error('Incomplete issued asset identifier');
  return `${code}:${issuer}`;
}
export async function json<T>(network: Network, path: string, fetcher: Fetcher = fetch): Promise<T> {
  const url = new URL(path, origin(network));
  if (url.origin !== origin(network) || url.username || url.password) throw new Error('Unsafe Horizon pagination URL');
  let response: Response;
  try { response = await fetcher(url.toString()); }
  catch (e) { throw new Error(`Horizon network failure: ${String(e)}`); }
  if (!response.ok) throw new Error(response.status === 404 ? 'Account or transaction not found' : `Horizon HTTP ${response.status}`);
  try { return await response.json() as T; }
  catch { throw new Error('Invalid Horizon JSON response'); }
}
export interface Balance {
  asset_type: string; balance: string; asset_code?: string; asset_issuer?: string;
  liquidity_pool_id?: string; selling_liabilities?: string; buying_liabilities?: string;
  sponsor?: string;
}
export interface Account {
  account_id: string; balances: Balance[]; subentry_count?: number; num_sponsoring?: number;
  num_sponsored?: number; signers?: Array<{ key: string; sponsor?: string }>;
  data?: Record<string, string>; sponsor?: string;
}
export async function account(accountId: string, network: Network, fetcher: Fetcher = fetch): Promise<Account> {
  validAccount(accountId);
  const result = await json<Account>(network, `/accounts/${accountId}`, fetcher);
  if (result.account_id !== accountId || !Array.isArray(result.balances)) throw new Error('Incomplete Horizon account response');
  return result;
}
export function nativeBalance(acc: Account): { balance: bigint; sellingLiabilities: bigint } {
  const native = acc.balances.find((b) => b.asset_type === 'native');
  if (!native) throw new Error('Account has no native XLM balance metadata');
  return {
    balance: amountToUnits(native.balance, 'XLM balance'),
    sellingLiabilities: amountToUnits(native.selling_liabilities ?? '0', 'selling liabilities'),
  };
}
export interface HorizonPage<T> {
  _embedded?: { records?: T[] }; _links?: { next?: { href?: string } };
}
/** Returns completeness explicitly; stops at a short page or reports capped pages. */
export async function collect<T>(
  network: Network, initialPath: string, maxPages = 5, fetcher: Fetcher = fetch, limit = 200,
): Promise<{ records: T[]; complete: boolean }> {
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) throw new Error('Invalid maxPages (1..100)');
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('Invalid Horizon page limit');
  const records: T[] = [];
  const visited = new Set<string>();
  let path = initialPath;
  for (let i = 0; i < maxPages; i++) {
    const absolute = new URL(path, origin(network)).toString();
    if (visited.has(absolute)) throw new Error('Horizon pagination loop');
    visited.add(absolute);
    const page = await json<HorizonPage<T>>(network, path, fetcher);
    const batch = page._embedded?.records;
    if (!Array.isArray(batch)) throw new Error('Malformed Horizon page');
    records.push(...batch);
    if (batch.length < limit) return { records, complete: true };
    const next = page._links?.next?.href;
    if (!next) return { records, complete: false };
    path = next;
  }
  return { records, complete: false };
}
