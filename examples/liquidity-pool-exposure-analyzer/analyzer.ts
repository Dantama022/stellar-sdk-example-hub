import { assertAccount, assertHexId, fromUnits, getJson, horizonEndpoint, multipliedDivided, percent, toUnits } from '../_multi-analyzer/common';
import type { PoolBalance, PoolOptions, PoolRecord, PoolReport } from './types';

export function calculateExposure(reserves: PoolRecord['reserves'], shares: string, totalShares: string): {
  ownershipPercent: string; estimatedExposure: PoolRecord['reserves'];
} {
  const held = toUnits(shares); const supply = toUnits(totalShares);
  if (supply === 0n) throw new Error('Pool total share supply is zero');
  if (held > supply) throw new Error('Account shares exceed total pool supply');
  if (!Array.isArray(reserves) || reserves.length !== 2) throw new Error('Expected two pool reserves');
  const ownershipPercent = percent(held, supply, 6);
  if (ownershipPercent === null) throw new Error('Undefined ownership');
  return {
    ownershipPercent,
    estimatedExposure: reserves.map(reserve => {
      if (typeof reserve.asset !== 'string' || !reserve.asset) throw new Error('Missing asset identifier');
      // All Stellar assets have 7-decimal precision. These are proportional estimates.
      const estimated = multipliedDivided(toUnits(reserve.amount), held, supply);
      return { asset: reserve.asset, amount: fromUnits(estimated) };
    }),
  };
}

export function reportPool(options: PoolOptions, pool: PoolRecord, accountBalances?: PoolBalance[], observedAt = new Date().toISOString()): PoolReport {
  assertHexId(options.poolId, 'pool ID');
  if (options.account) assertAccount(options.account);
  if (!pool || pool.id.toLowerCase() !== options.poolId.toLowerCase()) throw new Error('Mismatched pool response');
  const warnings: string[] = [];
  if (!Array.isArray(pool.reserves) || pool.reserves.length !== 2) warnings.push('Pool reserve pair is missing or incomplete');
  else for (const reserve of pool.reserves) {
    try { toUnits(reserve.amount); if (!reserve.asset) throw new Error('Missing asset'); }
    catch { warnings.push(`Invalid or incomplete reserve data: ${String(reserve.asset)}`); }
  }
  let totalShares: string | null = null;
  try {
    const total = toUnits(pool.total_shares); totalShares = pool.total_shares;
    if (total === 0n) warnings.push('Pool has zero total share supply; exposure is inconclusive');
  }
  catch { warnings.push('Missing or invalid total pool shares'); }
  const account = options.account ?? null;
  const balance = account ? accountBalances?.find(b => b.asset_type === 'liquidity_pool_shares' && b.liquidity_pool_id?.toLowerCase() === options.poolId.toLowerCase()) : undefined;
  const accountShares = account && accountBalances ? balance?.balance ?? '0.0000000' : null;
  if (account && !accountBalances) warnings.push('Account balance metadata unavailable; account exposure is inconclusive');
  let estimatedExposure: PoolRecord['reserves'] | null = null;
  let ownershipPercent: string | null = null;
  if (account && accountShares !== null && totalShares !== null && warnings.length === 0) {
    try {
      const value = calculateExposure(pool.reserves, accountShares, totalShares);
      estimatedExposure = value.estimatedExposure;
      ownershipPercent = value.ownershipPercent;
    } catch (error) { warnings.push(`Exposure inconclusive: ${String(error)}`); }
  }
  return {
    poolId: options.poolId, network: options.network, observedAt,
    lastModifiedLedger: pool.last_modified_ledger ?? null,
    lastModifiedTime: pool.last_modified_time ?? null, reserves: Array.isArray(pool.reserves) ? pool.reserves : [],
    totalShares, account, accountShares, ownershipPercent, estimatedExposure,
    complete: warnings.length === 0, warnings,
    interpretation: 'Proportional, read-only reserve exposure at the observed pool state; NOT guaranteed immediate withdrawal proceeds or investment advice.',
  };
}

export async function analyzePool(options: PoolOptions): Promise<PoolReport> {
  assertHexId(options.poolId, 'pool ID');
  if (options.account) assertAccount(options.account);
  const horizon = horizonEndpoint(options.network, options.horizonUrl);
  const observedAt = new Date().toISOString();
  const pool = await getJson<PoolRecord>(horizon, `/liquidity_pools/${options.poolId}`, options.fetcher);
  let accountBalances: PoolBalance[] | undefined;
  if (options.account) {
    const account = await getJson<{ balances?: PoolBalance[] }>(horizon, `/accounts/${options.account}`, options.fetcher);
    if (Array.isArray(account.balances)) accountBalances = account.balances;
  }
  return reportPool(options, pool, accountBalances, observedAt);
}
