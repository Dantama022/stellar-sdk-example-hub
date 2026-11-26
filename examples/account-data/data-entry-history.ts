import { accountId, allPages, endpoint, HORIZON, HttpClient, HorizonHttp, Network, validateRange } from '../_analysis/core';

export type ChangeType = 'create' | 'update' | 'remove';
export interface HistoricalEffect {
  id: string; type: string; account: string; name?: string; value?: string;
  created_at?: string; ledger?: number;
  _links?: { operation?: { href: string } };
}
export interface DataChange {
  id: string; account: string; key: string; type: ChangeType;
  valueBase64: string | null; valueUtf8: string | null;
  ledger: number | null; transactionHash: string | null; timestamp: string | null;
}
export interface RetrievedHistory { changes: DataChange[]; complete: boolean; warnings: string[] }
export interface CurrentAccountData { accountId: string; entries: Record<string, { base64: string; utf8: string | null }>; observedAt: string }

export function decodeBase64(value: string): { base64: string; utf8: string | null } {
  if (typeof value !== 'string' || (value && (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)))) {
    throw new Error('Malformed base64 account data');
  }
  const binary = Buffer.from(value, 'base64');
  let utf8: string | null = null;
  try { utf8 = new TextDecoder('utf-8', { fatal: true }).decode(binary); } catch { /* arbitrary binary is valid data */ }
  return { base64: value, utf8 };
}

export async function retrieveCurrentData(network: Network, account: string, client: HttpClient = new HorizonHttp(), horizon = HORIZON[network]): Promise<CurrentAccountData> {
  accountId(account);
  const raw = await client.get<{ data?: Record<string, string> }>(`${endpoint(network, horizon)}/accounts/${account}`);
  if (raw.data === undefined || typeof raw.data !== 'object' || raw.data === null || Array.isArray(raw.data)) throw new Error('Account data field is unavailable');
  const entries: CurrentAccountData['entries'] = {};
  for (const [key, value] of Object.entries(raw.data)) entries[key] = decodeBase64(value);
  return { accountId: account, entries, observedAt: new Date().toISOString() };
}

/** Normalize Horizon data_* effects; transaction metadata is resolved separately. */
export function normalizeEffect(effect: HistoricalEffect, ledger: number | null = null, transactionHash: string | null = null): DataChange | null {
  const type: ChangeType | undefined = effect.type === 'data_created' ? 'create' : effect.type === 'data_updated' ? 'update' : effect.type === 'data_removed' ? 'remove' : undefined;
  if (!type) return null;
  if (!effect.id || typeof effect.name !== 'string' || !effect.name) throw new Error('Malformed data effect (missing ID/key)');
  if (type !== 'remove' && typeof effect.value !== 'string') throw new Error('Data effect has no verifiable new value');
  const decoded = type === 'remove' ? null : decodeBase64(effect.value!);
  return {
    id: effect.id, account: effect.account, key: effect.name, type,
    valueBase64: decoded?.base64 ?? null, valueUtf8: decoded?.utf8 ?? null,
    ledger: ledger ?? effect.ledger ?? null, transactionHash,
    timestamp: effect.created_at ?? null,
  };
}

export async function retrieveDataHistory(options: {
  network: Network; account: string; start: number; end: number; horizon?: string; maxRecords?: number;
}, client: HttpClient = new HorizonHttp()): Promise<RetrievedHistory> {
  accountId(options.account);
  validateRange(options.start, options.end, 50_000_000);
  const base = endpoint(options.network, options.horizon ?? HORIZON[options.network]);
  const effects = await allPages<HistoricalEffect>(client, `${base}/accounts/${options.account}/effects?order=asc&limit=200`, options.maxRecords ?? 10_000);
  const warnings: string[] = [];
  const transactionByHash = new Map<string, { ledger: number; created_at?: string }>();
  const operationByUrl = new Map<string, { transaction_hash?: string }>();
  const seen = new Set<string>();
  const changes: DataChange[] = [];
  for (const effect of effects) {
    if (!['data_created', 'data_updated', 'data_removed'].includes(effect.type)) continue;
    if (effect.account !== options.account) continue;
    if (seen.has(effect.id)) continue;
    seen.add(effect.id);
    let ledger: number | null = effect.ledger ?? null;
    let hash: string | null = null;
    let timestamp = effect.created_at ?? null;
    try {
      const operationUrl = effect._links?.operation?.href;
      if (operationUrl) {
        let op = operationByUrl.get(operationUrl);
        if (!op) { op = await client.get<{ transaction_hash?: string }>(operationUrl); operationByUrl.set(operationUrl, op); }
        hash = op.transaction_hash ?? null;
      }
      if (hash) {
        let tx = transactionByHash.get(hash);
        if (!tx) { tx = await client.get<{ ledger: number; created_at?: string }>(`${base}/transactions/${hash}`); transactionByHash.set(hash, tx); }
        ledger = tx.ledger;
        timestamp = tx.created_at ?? timestamp;
      }
    } catch (error) { warnings.push(`Effect ${effect.id}: transaction metadata unavailable (${String(error)})`); }
    if (ledger === null) { warnings.push(`Effect ${effect.id}: ledger sequence unavailable; historical range membership unverified`); continue; }
    if (ledger < options.start || ledger > options.end) continue;
    try {
      const result = normalizeEffect(effect, ledger, hash);
      if (result) { result.timestamp = timestamp; changes.push(result); }
    } catch (error) { warnings.push(`Effect ${effect.id}: ${String(error)}`); }
  }
  changes.sort((a, b) => a.ledger! - b.ledger! || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // Horizon history may be pruned or start after requested ledger; cannot prove full archival completeness.
  warnings.push('Horizon effects are retained history, not a guaranteed complete ledger-change archive. Confirm retention and a known starting snapshot before asserting complete reconstruction.');
  return { changes, complete: false, warnings };
}
