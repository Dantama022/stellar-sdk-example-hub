import { ratio, toUnits, unitsToDecimal } from '../_analysis/core';
/** Additional exact-floor slippage stress scenarios for an existing output estimate. */
export function slippageScenarios(output: string, tolerancesBps: number[]): Array<{ toleranceBps: number; minimumOutput: string; reductionPercent: string }> {
  const amount = toUnits(output);
  return tolerancesBps.map((bps) => {
    if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new Error('Invalid slippage tolerance');
    const remaining = amount * BigInt(10_000 - bps) / 10_000n;
    return { toleranceBps: bps, minimumOutput: unitsToDecimal(remaining), reductionPercent: ratio(BigInt(bps), 100n, 2) };
  });
}
