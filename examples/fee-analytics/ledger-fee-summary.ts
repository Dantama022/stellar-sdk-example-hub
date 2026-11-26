import { ratio, unitsToDecimal } from '../_analysis/core';

export interface FeeTransaction {
  hash: string; ledger: number; feeChargedStroops: bigint; feeBidStroops: bigint | null;
}
export interface FeeBucket { name: string; minStroops: bigint; maxStroops: bigint | null }
export const DEFAULT_FEE_BUCKETS: FeeBucket[] = [
  { name: '0-99', minStroops: 0n, maxStroops: 99n },
  { name: '100-999', minStroops: 100n, maxStroops: 999n },
  { name: '1000-9999', minStroops: 1000n, maxStroops: 9999n },
  { name: '10000+', minStroops: 10000n, maxStroops: null },
];
export interface FeeStats {
  count: number; totalStroops: string; totalXlm: string;
  averageStroops: string | null; medianStroops: string | null;
  minStroops: string | null; maxStroops: string | null;
}
export interface LedgerFees extends FeeStats { ledger: number; changeFromPreviousTotalStroops: string | null }

export function feeStats(transactions: FeeTransaction[]): FeeStats {
  const fees = transactions.map((tx) => tx.feeChargedStroops).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const count = fees.length;
  const total = fees.reduce((a, b) => a + b, 0n);
  const middle = Math.floor(count / 2);
  const median = !count ? null : count % 2 === 1 ? fees[middle].toString() : ratio(fees[middle - 1] + fees[middle], 2n, 1);
  return {
    count, totalStroops: total.toString(), totalXlm: unitsToDecimal(total),
    averageStroops: count ? ratio(total, BigInt(count), 4) : null,
    medianStroops: median, minStroops: count ? fees[0].toString() : null,
    maxStroops: count ? fees[count - 1].toString() : null,
  };
}

export function feeDistribution(transactions: FeeTransaction[], buckets: FeeBucket[] = DEFAULT_FEE_BUCKETS): Array<{ range: string; count: number }> {
  if (!buckets.length) throw new Error('At least one fee bucket required');
  const sorted = [...buckets].sort((a, b) => a.minStroops < b.minStroops ? -1 : a.minStroops > b.minStroops ? 1 : 0);
  for (let i = 0; i < sorted.length; i++) {
    const bucket = sorted[i];
    if (bucket.minStroops < 0n || (bucket.maxStroops !== null && bucket.maxStroops < bucket.minStroops)) throw new Error('Invalid fee bucket');
    if (i > 0 && (sorted[i - 1].maxStroops === null || sorted[i - 1].maxStroops! >= bucket.minStroops)) throw new Error('Overlapping fee buckets');
  }
  if (sorted[0].minStroops !== 0n || sorted[sorted.length - 1].maxStroops !== null) throw new Error('Buckets must cover all nonnegative fees');
  for (let i = 1; i < sorted.length; i++) if (sorted[i - 1].maxStroops! + 1n !== sorted[i].minStroops) throw new Error('Gap between fee buckets');
  return buckets.map((bucket) => ({
    range: bucket.name,
    count: transactions.filter((tx) => tx.feeChargedStroops >= bucket.minStroops && (bucket.maxStroops === null || tx.feeChargedStroops <= bucket.maxStroops)).length,
  }));
}

export function feesByLedger(transactions: FeeTransaction[]): LedgerFees[] {
  const byLedger = new Map<number, FeeTransaction[]>();
  for (const tx of transactions) byLedger.set(tx.ledger, [...(byLedger.get(tx.ledger) ?? []), tx]);
  let previous: bigint | null = null;
  return [...byLedger.entries()].sort(([a], [b]) => a - b).map(([ledger, rows]) => {
    const stats = feeStats(rows);
    const total = BigInt(stats.totalStroops);
    const change = previous === null ? null : (total - previous).toString();
    previous = total;
    return { ledger, ...stats, changeFromPreviousTotalStroops: change };
  });
}
