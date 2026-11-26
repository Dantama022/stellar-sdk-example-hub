import { Asset } from '@stellar/stellar-sdk';
import { endpoint, HORIZON, HttpClient, HorizonHttp, Network, ratio, toUnits, unitsToDecimal } from '../_analysis/core';

export interface Pool { id: string; fee_bp: number; reserves: Array<{ asset: string; amount: string }>; }
export interface SwapQuote {
  network: Network; poolId: string; observedAt: string; inputAsset: string; outputAsset: string;
  inputAmount: string; estimatedOutput: string; minimumOutput: string; feeBasisPoints: number;
  slippageBasisPoints: number; spotPriceOutputPerInput: string; executionPriceOutputPerInput: string;
  priceImpactPercent: string; reserveIn: string; reserveOut: string;
  warning: string;
}

export function canonicalAsset(value: string): string {
  if (value === 'native' || value === 'XLM') return 'native';
  const parts = value.split(':');
  if (parts.length !== 2 || !/^[a-zA-Z0-9]{1,12}$/.test(parts[0])) throw new Error('Invalid asset (expected CODE:G-issuer or native)');
  new Asset(parts[0], parts[1]); // SDK validates issuer and code.
  return `${parts[0]}:${parts[1]}`;
}

export async function retrievePool(
  network: Network, assetA: string, assetB: string, client: HttpClient = new HorizonHttp(), horizon = HORIZON[network],
): Promise<Pool> {
  const a = canonicalAsset(assetA);
  const b = canonicalAsset(assetB);
  if (a === b) throw new Error('Asset pair must contain two different assets');
  const base = endpoint(network, horizon);
  const url = new URL(`${base}/liquidity_pools`);
  url.searchParams.set('reserves', `${a},${b}`);
  url.searchParams.set('limit', '10');
  const page = await client.get<{ _embedded?: { records?: Pool[] } }>(url.toString());
  if (!Array.isArray(page._embedded?.records)) throw new Error('Malformed liquidity-pool response');
  const pool = page._embedded.records.find((entry) =>
    Array.isArray(entry.reserves) && entry.reserves.length === 2 &&
    entry.reserves.some((r) => r.asset === a) && entry.reserves.some((r) => r.asset === b));
  if (!pool) throw new Error('No matching liquidity pool found');
  return pool;
}

/** Exact constant-product calculation in stroops, rounded DOWN at each output boundary. */
export function calculateQuote(
  pool: Pool, network: Network, inputAsset: string, inputAmount: string, slippageBasisPoints = 100,
  observedAt = new Date().toISOString(),
): SwapQuote {
  const input = canonicalAsset(inputAsset);
  if (!pool || !/^[0-9a-f]{64}$/i.test(pool.id) || pool.reserves?.length !== 2) throw new Error('Invalid pool metadata');
  if (!Number.isInteger(pool.fee_bp) || pool.fee_bp < 0 || pool.fee_bp >= 10_000) throw new Error('Invalid pool fee');
  if (!Number.isInteger(slippageBasisPoints) || slippageBasisPoints < 0 || slippageBasisPoints > 10_000) throw new Error('Invalid slippage tolerance (0-10000 bps)');
  const fromIndex = pool.reserves.findIndex((r) => r.asset === input);
  if (fromIndex < 0) throw new Error('Input asset does not belong to the pool');
  const source = pool.reserves[fromIndex];
  const target = pool.reserves[1 - fromIndex];
  const amount = toUnits(inputAmount);
  const reserveIn = toUnits(source.amount);
  const reserveOut = toUnits(target.amount);
  if (amount <= 0n || reserveIn <= 0n || reserveOut <= 0n) throw new Error('Input amount and both reserves must be positive');
  const feeAdjustedInput = amount * BigInt(10_000 - pool.fee_bp) / 10_000n;
  if (!feeAdjustedInput) throw new Error('Input too small after fees');
  const output = reserveOut * feeAdjustedInput / (reserveIn + feeAdjustedInput);
  if (!output || output >= reserveOut) throw new Error('Insufficient pool liquidity for a nonzero quote');
  const minOutput = output * BigInt(10_000 - slippageBasisPoints) / 10_000n;
  const spot = ratio(reserveOut, reserveIn, 7);
  const execution = ratio(output, amount, 7);
  const theoreticalNumerator = amount * reserveOut;
  const impactNumerator = theoreticalNumerator - output * reserveIn;
  const impact = ratio(impactNumerator * 100n, theoreticalNumerator, 4);
  return {
    network, poolId: pool.id, observedAt, inputAsset: input, outputAsset: target.asset,
    inputAmount: unitsToDecimal(amount), estimatedOutput: unitsToDecimal(output),
    minimumOutput: unitsToDecimal(minOutput), feeBasisPoints: pool.fee_bp,
    slippageBasisPoints, spotPriceOutputPerInput: spot, executionPriceOutputPerInput: execution,
    priceImpactPercent: impact, reserveIn: source.amount, reserveOut: target.amount,
    warning: 'Indicative constant-product quote at observed reserves; includes fee impact, not a guaranteed withdrawal/execution. Fees for the transaction are separate.',
  };
}

export async function analyzeSwap(params: {
  network: Network; assetA: string; assetB: string; inputAsset: string; inputAmount: string;
  slippageBasisPoints?: number; horizon?: string;
}, client: HttpClient = new HorizonHttp()): Promise<SwapQuote> {
  const pool = await retrievePool(params.network, params.assetA, params.assetB, client, params.horizon);
  return calculateQuote(pool, params.network, params.inputAsset, params.inputAmount, params.slippageBasisPoints);
}
