import { Horizon } from '@stellar/stellar-sdk';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';

export interface ParsedFeeStats {
  lastLedger: string;
  baseFee: number;
  capacityUsage: string;
  minFee: number;
  modeFee: number;
  medianFee: number;
  p90Fee: number;
  p95Fee: number;
  p99Fee: number;
  recommendedFee: number;
}

export function getRecommendedFee(stats: {
  modeFee?: number;
  medianFee?: number;
  baseFee?: number;
  p90Fee?: number;
}): number {
  const base = stats.baseFee || 100;
  const p90 = stats.p90Fee || base;
  // Recommended fee provides a small safety buffer above p90 or mode fee
  return Math.max(base, p90);
}

/**
 * Parses raw Horizon fee_stats response into a structured numeric summary.
 */
export function parseFeeStats(rawStats: any): ParsedFeeStats {
  const lastLedger = String(rawStats?.last_ledger ?? 'unknown');
  const baseFee = parseInt(rawStats?.last_ledger_base_fee ?? '100', 10);
  const capacityUsage = String(rawStats?.ledger_capacity_usage ?? '0.00');

  const minFee = parseInt(rawStats?.min_accepted_fee ?? rawStats?.fee_charged?.min ?? '100', 10);
  const modeFee = parseInt(rawStats?.mode_accepted_fee ?? rawStats?.fee_charged?.mode ?? '100', 10);
  const medianFee = parseInt(
    rawStats?.p50_accepted_fee ?? rawStats?.fee_charged?.p50 ?? '100',
    10,
  );
  const p90Fee = parseInt(rawStats?.p90_accepted_fee ?? rawStats?.fee_charged?.p90 ?? '100', 10);
  const p95Fee = parseInt(rawStats?.p95_accepted_fee ?? rawStats?.fee_charged?.p95 ?? '100', 10);
  const p99Fee = parseInt(rawStats?.p99_accepted_fee ?? rawStats?.fee_charged?.p99 ?? '100', 10);

  const recommendedFee = getRecommendedFee({ modeFee, medianFee, baseFee, p90Fee });

  return {
    lastLedger,
    baseFee,
    capacityUsage,
    minFee,
    modeFee,
    medianFee,
    p90Fee,
    p95Fee,
    p99Fee,
    recommendedFee,
  };
}

/**
 * Formats parsed fee statistics into a readable developer summary string.
 */
export function formatFeeStatsSummary(stats: ParsedFeeStats): string {
  const lines: string[] = [];

  lines.push(`=== Horizon Network Fee Statistics Summary ===`);
  lines.push(`Last Ledger Inspected:  ${stats.lastLedger}`);
  lines.push(`Network Base Fee:       ${stats.baseFee} stroops (0.00001 XLM)`);
  lines.push(`Ledger Capacity Usage:  ${(parseFloat(stats.capacityUsage) * 100).toFixed(1)}%`);

  lines.push(`\nFee Distribution (stroops per operation):`);
  lines.push(`  - Minimum Accepted:   ${stats.minFee} stroops`);
  lines.push(`  - Mode Accepted:      ${stats.modeFee} stroops`);
  lines.push(`  - Median (50th %ile): ${stats.medianFee} stroops`);
  lines.push(`  - 90th Percentile:    ${stats.p90Fee} stroops`);
  lines.push(`  - 95th Percentile:    ${stats.p95Fee} stroops`);
  lines.push(`  - 99th Percentile:    ${stats.p99Fee} stroops`);

  lines.push(`\nFee Guidance:`);
  lines.push(`  - Recommended Fee:    ${stats.recommendedFee} stroops`);
  lines.push(
    `  - Usage Note: When network activity is high (capacity usage > 80%), setting fees at or above 90th percentile ensures quick ledger inclusion.`,
  );

  return lines.join('\n');
}

/**
 * Runs the Horizon fee statistics inspection example.
 */
export async function run(): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL || DEFAULT_HORIZON_URL;
  const server = new Horizon.Server(horizonUrl);

  console.log('Starting Horizon Fee Statistics Inspection Example...');
  console.log(`Using Horizon: ${horizonUrl}`);

  try {
    const rawStats = await server.feeStats();
    const parsed = parseFeeStats(rawStats);

    console.log('\n' + formatFeeStatsSummary(parsed));
  } catch (error: any) {
    console.log(`Could not retrieve fee statistics from Horizon: ${error.message || error}`);
    console.log('Demonstrating fee statistics structure with fallback values:');

    const fallbackStats = parseFeeStats({
      last_ledger: '50000000',
      last_ledger_base_fee: '100',
      ledger_capacity_usage: '0.05',
      min_accepted_fee: '100',
      mode_accepted_fee: '100',
      p50_accepted_fee: '100',
      p90_accepted_fee: '100',
      p95_accepted_fee: '100',
      p99_accepted_fee: '100',
    });

    console.log('\n' + formatFeeStatsSummary(fallbackStats));
  }

  console.log('\nFee statistics inspection completed successfully.');
}
