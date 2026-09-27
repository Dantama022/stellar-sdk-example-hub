import { BASE_FEE, Horizon } from '@stellar/stellar-sdk';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';

export type FeeStrategy = 'economy' | 'standard' | 'priority';

export interface FeeEstimationParams {
  horizonUrl?: string;
  operationCount?: number;
  baseFee?: number;
  maxFee?: number;
  offline?: boolean;
  jsonOutput?: boolean;
}

export interface FeeBreakdown {
  strategy: FeeStrategy;
  baseFee: number;
  operationCount: number;
  transactionFee: number;
  feePerOperation: number;
  feeBumpFee: number;
  withinMaxFee: boolean;
}

const STRATEGY_MULTIPLIER: Record<FeeStrategy, number> = {
  economy: 1,
  standard: 2,
  priority: 5,
};

/**
 * Calculates the fee breakdown for a single strategy.
 *
 * A Stellar transaction fee is `base fee * operation count`, and a fee-bump
 * envelope must pay for one extra operation (the inner transaction itself).
 */
export function calculateFee(
  strategy: FeeStrategy,
  networkBaseFee: number,
  operationCount: number,
  maxFee: number,
): FeeBreakdown {
  if (!Number.isInteger(operationCount) || operationCount < 1) {
    throw new Error('operationCount must be an integer of at least 1');
  }
  if (!Number.isFinite(networkBaseFee) || networkBaseFee < 100) {
    throw new Error('baseFee must be at least 100 stroops');
  }

  const baseFee = Math.ceil(networkBaseFee * STRATEGY_MULTIPLIER[strategy]);
  const transactionFee = baseFee * operationCount;

  return {
    strategy,
    baseFee,
    operationCount,
    transactionFee,
    feePerOperation: baseFee,
    feeBumpFee: baseFee * (operationCount + 1),
    withinMaxFee: transactionFee <= maxFee,
  };
}

/**
 * Compares every supported fee strategy for the given operation count.
 */
export function compareStrategies(
  networkBaseFee: number,
  operationCount: number,
  maxFee: number,
): FeeBreakdown[] {
  return (Object.keys(STRATEGY_MULTIPLIER) as FeeStrategy[]).map((strategy) =>
    calculateFee(strategy, networkBaseFee, operationCount, maxFee),
  );
}

/**
 * Reads the current network base fee from Horizon, falling back to BASE_FEE
 * when the network is unreachable so the example still works offline.
 */
export async function fetchNetworkBaseFee(horizonUrl: string): Promise<number> {
  try {
    const server = new Horizon.Server(horizonUrl);
    const stats = await server.feeStats();
    return Number(stats.last_ledger_base_fee) || Number(BASE_FEE);
  } catch {
    console.warn('Horizon unavailable — falling back to the SDK BASE_FEE constant.');
    return Number(BASE_FEE);
  }
}

export function formatBreakdown(rows: FeeBreakdown[]): string {
  const xlm = (stroops: number) => (stroops / 1e7).toFixed(7);

  return rows
    .map((row) =>
      [
        `Strategy: ${row.strategy}`,
        `  Base fee:         ${row.baseFee} stroops`,
        `  Operations:       ${row.operationCount}`,
        `  Transaction fee:  ${row.transactionFee} stroops (${xlm(row.transactionFee)} XLM)`,
        `  Fee per op:       ${row.feePerOperation} stroops`,
        `  Fee-bump fee:     ${row.feeBumpFee} stroops`,
        `  Within max fee:   ${row.withinMaxFee ? 'yes' : 'no'}`,
      ].join('\n'),
    )
    .join('\n\n');
}

/**
 * Runs the transaction fee estimation and strategy comparison example.
 */
export async function run(params: FeeEstimationParams = {}): Promise<void> {
  const horizonUrl = params.horizonUrl || process.env.HORIZON_URL || DEFAULT_HORIZON_URL;
  const operationCount = Number(params.operationCount) || 3;
  const maxFee = Number(params.maxFee) || 100000;

  const networkBaseFee = params.offline
    ? Number(params.baseFee) || Number(BASE_FEE)
    : await fetchNetworkBaseFee(horizonUrl);

  const rows = compareStrategies(networkBaseFee, operationCount, maxFee);

  if (params.jsonOutput) {
    console.log(JSON.stringify({ horizonUrl, networkBaseFee, maxFee, strategies: rows }, null, 2));
    return;
  }

  console.log(`Network base fee: ${networkBaseFee} stroops`);
  console.log(`Configured maximum fee: ${maxFee} stroops\n`);
  console.log(formatBreakdown(rows));
}
