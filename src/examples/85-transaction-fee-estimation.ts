import { Horizon, BASE_FEE } from '@stellar/stellar-sdk';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';

export interface FeeEstimate {
  baseFee: number;
  operationCount: number;
  low: number;
  recommended: number;
  high: number;
}

/**
 * Calculates total transaction fees for low / recommended / high priorities.
 *
 * A transaction fee is `base fee per operation * operation count`, so the
 * chosen per-operation fee matters more as transactions grow.
 */
export function estimateFees(
  stats: { baseFee?: number; p50?: number; p90?: number; p99?: number },
  operationCount: number,
): FeeEstimate {
  if (operationCount < 1) {
    throw new Error('A transaction must contain at least one operation');
  }

  const baseFee = stats.baseFee || Number(BASE_FEE);
  const low = Math.max(baseFee, stats.p50 || baseFee);
  const recommended = Math.max(low, stats.p90 || baseFee);
  const high = Math.max(recommended, stats.p99 || baseFee);

  return {
    baseFee,
    operationCount,
    low: low * operationCount,
    recommended: recommended * operationCount,
    high: high * operationCount,
  };
}

export function formatFeeEstimate(estimate: FeeEstimate): string {
  const xlm = (stroops: number) => (stroops / 1e7).toFixed(7);

  return [
    `Operations: ${estimate.operationCount} | Network base fee: ${estimate.baseFee} stroops`,
    `  Low priority:         ${estimate.low} stroops (${xlm(estimate.low)} XLM)`,
    `  Recommended:          ${estimate.recommended} stroops (${xlm(estimate.recommended)} XLM)`,
    `  High priority:        ${estimate.high} stroops (${xlm(estimate.high)} XLM)`,
  ].join('\n');
}

/**
 * Runs the transaction fee estimation example.
 */
export async function run(): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL || DEFAULT_HORIZON_URL;
  const server = new Horizon.Server(horizonUrl);

  console.log('Starting Transaction Fee Estimation Example...');
  console.log(`Using Horizon: ${horizonUrl}`);

  let stats = { baseFee: Number(BASE_FEE), p50: 100, p90: 100, p99: 100 };

  try {
    const raw: any = await server.feeStats();
    stats = {
      baseFee: parseInt(raw?.last_ledger_base_fee ?? BASE_FEE, 10),
      p50: parseInt(raw?.fee_charged?.p50 ?? BASE_FEE, 10),
      p90: parseInt(raw?.fee_charged?.p90 ?? BASE_FEE, 10),
      p99: parseInt(raw?.fee_charged?.p99 ?? BASE_FEE, 10),
    };
    console.log(`\nLedger capacity usage: ${raw?.ledger_capacity_usage ?? 'unknown'}`);
  } catch (error: any) {
    console.log(`\nFee statistics unavailable (${error.message || error}); using base fee only.`);
  }

  for (const operationCount of [1, 3, 10]) {
    console.log('\n' + formatFeeEstimate(estimateFees(stats, operationCount)));
  }

  try {
    estimateFees(stats, 0);
  } catch (error: any) {
    console.log(`\nHandled invalid operation count: ${error.message}`);
  }

  console.log('\nNotes:');
  console.log('  - Fees rise with network load; a fee below the current market rate is dropped');
  console.log('    with tx_insufficient_fee, so pick p90+ when inclusion speed matters.');
  console.log('  - A fee-bump transaction can raise the fee on an already-signed transaction');
  console.log('    without re-signing it.');

  console.log('\nFee estimation completed successfully.');
}
