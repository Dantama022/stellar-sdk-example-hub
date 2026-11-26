import { allPages, endpoint, HORIZON, HttpClient, HorizonHttp, Network, validateRange } from '../_analysis/core';
import { DEFAULT_FEE_BUCKETS, feeDistribution, FeeBucket, FeeTransaction, feeStats, feesByLedger } from './ledger-fee-summary';

interface HorizonTransaction { hash: string; ledger: number; fee_charged?: string | number; max_fee?: string | number; }

export function parseStroops(value: unknown): bigint {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Unsafe or negative fee integer');
    return BigInt(value);
  }
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) throw new Error('Malformed fee in stroops');
  return BigInt(value);
}
export function normalizeTransaction(row: HorizonTransaction): FeeTransaction {
  if (!/^[0-9a-f]{64}$/i.test(row.hash) || !Number.isSafeInteger(row.ledger) || row.ledger < 1) throw new Error('Invalid transaction identifier or ledger');
  return {
    hash: row.hash, ledger: row.ledger,
    feeChargedStroops: parseStroops(row.fee_charged),
    feeBidStroops: row.max_fee === undefined ? null : parseStroops(row.max_fee),
  };
}

export interface FeeReport {
  network: Network; range: { start: number; end: number }; transactions: Array<{ hash: string; ledger: number; feeChargedStroops: string; feeBidStroops: string | null }>;
  statistics: ReturnType<typeof feeStats>;
  distribution: ReturnType<typeof feeDistribution>;
  ledgers: ReturnType<typeof feesByLedger>;
  observations: string[];
}
export function analyzeFees(network: Network, start: number, end: number, rows: HorizonTransaction[], buckets: FeeBucket[] = DEFAULT_FEE_BUCKETS): FeeReport {
  validateRange(start, end, 500);
  const byHash = new Map<string, FeeTransaction>();
  for (const row of rows) {
    const tx = normalizeTransaction(row);
    if (tx.ledger >= start && tx.ledger <= end) {
      const existing = byHash.get(tx.hash);
      if (existing && (existing.feeChargedStroops !== tx.feeChargedStroops || existing.ledger !== tx.ledger)) throw new Error('Conflicting duplicate transaction');
      byHash.set(tx.hash, tx);
    }
  }
  const transactions = [...byHash.values()];
  return {
    network, range: { start, end },
    transactions: transactions.map((tx) => ({ hash: tx.hash, ledger: tx.ledger, feeChargedStroops: tx.feeChargedStroops.toString(), feeBidStroops: tx.feeBidStroops?.toString() ?? null })),
    statistics: feeStats(transactions), distribution: feeDistribution(transactions, buckets), ledgers: feesByLedger(transactions),
    observations: ['Amounts are actual fee_charged in stroops; max_fee is a separate bid/limit, not the fee paid.', 'Fee totals and network transaction volume do not independently prove congestion.'],
  };
}

export async function retrieveFeeReport(options: {
  network: Network; start: number; end: number; horizon?: string; pageSize?: number; buckets?: FeeBucket[];
}, client: HttpClient = new HorizonHttp()): Promise<FeeReport> {
  validateRange(options.start, options.end, 500);
  const size = options.pageSize ?? 200;
  if (!Number.isInteger(size) || size < 1 || size > 200) throw new Error('Invalid page size');
  const base = endpoint(options.network, options.horizon ?? HORIZON[options.network]);
  const rows: HorizonTransaction[] = [];
  for (let seq = options.start; seq <= options.end; seq++) {
    const pageRows = await allPages<HorizonTransaction>(client, `${base}/ledgers/${seq}/transactions?order=asc&limit=${size}`, 50_000);
    rows.push(...pageRows);
  }
  return analyzeFees(options.network, options.start, options.end, rows, options.buckets);
}
