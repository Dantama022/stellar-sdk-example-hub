import { Horizon } from '@stellar/stellar-sdk';

/**
 * Example 64: Horizon Liquidity Pool Inspection
 *
 * Stellar liquidity pools are automated market maker (AMM) resources that
 * hold reserves of two assets. Traders can exchange between those reserves,
 * while liquidity providers deposit both assets and receive pool shares.
 *
 * Horizon provides:
 *
 *   GET /liquidity_pools
 *     Browse available liquidity pools.
 *
 *   GET /liquidity_pools/:liquidity_pool_id
 *     Retrieve one pool using its deterministic 64-character hexadecimal ID.
 *
 * A Stellar liquidity pool ID is derived from the pool parameters rather than
 * selected manually. For the currently supported constant-product pools, those
 * parameters include the canonical reserve assets and fee. The same parameters
 * always produce the same pool ID, preventing duplicate pools for one asset
 * pair and fee configuration.
 *
 * Pool shares represent proportional ownership of the pool reserves. They are
 * separate from the two reserve assets and are received when liquidity is
 * deposited. This example inspects pools only; it does not create trustlines,
 * deposit liquidity, withdraw liquidity, or submit transactions.
 */

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 200;
const LIQUIDITY_POOL_ID_PATTERN = /^[a-fA-F0-9]{64}$/;

export interface LiquidityPoolInspectionParams {
  /**
   * Optional 64-character liquidity pool ID.
   *
   * When omitted, the example browses available pools.
   */
  poolId?: string;

  /**
   * Number of pools returned when browsing, from 1 through 200.
   */
  limit?: number | string;

  /**
   * Horizon URL override.
   */
  horizonUrl?: string;
}

export interface RawLiquidityPoolReserve {
  asset?: string;
  amount?: string;
}

export interface RawLiquidityPoolRecord {
  id?: string;
  paging_token?: string;
  fee_bp?: number;
  type?: string;
  total_trustlines?: number;
  total_shares?: string;
  reserves?: RawLiquidityPoolReserve[];
  last_modified_ledger?: number;
  last_modified_time?: string;

  _links?: {
    self?: {
      href?: string;
    };
    operations?: {
      href?: string;
    };
    transactions?: {
      href?: string;
    };
    trades?: {
      href?: string;
    };
    effects?: {
      href?: string;
    };
  };
}

export interface ParsedLiquidityPoolAsset {
  canonical: string;
  assetType: 'native' | 'issued' | 'unknown';
  code: string;
  issuer?: string;
}

export interface ParsedLiquidityPoolReserve {
  asset: ParsedLiquidityPoolAsset;
  amount: string;
}

export interface ParsedLiquidityPool {
  id: string;
  pagingToken: string;
  poolType: string;
  feeBasisPoints: number;
  feePercentage: string;
  totalShares: string;
  participatingAccounts: number;
  reserves: ParsedLiquidityPoolReserve[];
  lastModifiedLedger?: number;
  lastModifiedTime?: string;
  selfUrl?: string;
}

export interface LiquidityPoolSummary {
  totalPools: number;
  totalReserveEntries: number;
  totalParticipatingAccounts: number;
  poolTypes: Record<string, number>;
}

/**
 * Normalizes the browsing limit to Horizon's supported range.
 */
export function normalizeLiquidityPoolLimit(value?: number | string): number {
  const parsed = typeof value === 'string' ? Number.parseInt(value.trim(), 10) : value;

  if (parsed === undefined || parsed === null || Number.isNaN(parsed)) {
    return DEFAULT_LIMIT;
  }

  return Math.min(Math.max(Math.trunc(parsed), 1), MAX_LIMIT);
}

/**
 * Validates and normalizes an optional liquidity pool ID.
 */
export function normalizeLiquidityPoolId(value?: string): string | undefined {
  const normalized = value?.trim();

  if (!normalized) {
    return undefined;
  }

  if (!LIQUIDITY_POOL_ID_PATTERN.test(normalized)) {
    throw new Error('Invalid liquidity pool ID. Expected exactly 64 hexadecimal characters.');
  }

  return normalized.toLowerCase();
}

/**
 * Converts a fee expressed in basis points into a percentage.
 *
 * One basis point is 0.01%, so the standard 30-basis-point Stellar pool fee
 * displays as 0.30%.
 */
export function formatLiquidityPoolFee(feeBasisPoints: number): string {
  return `${(feeBasisPoints / 100).toFixed(2)}%`;
}

/**
 * Parses Horizon's canonical asset representation.
 *
 * Native XLM appears as `native`. Issued assets appear as `CODE:ISSUER`.
 */
export function parseLiquidityPoolAsset(canonicalAsset?: string): ParsedLiquidityPoolAsset {
  if (!canonicalAsset) {
    return {
      canonical: 'Unknown',
      assetType: 'unknown',
      code: 'Unknown',
    };
  }

  if (canonicalAsset === 'native') {
    return {
      canonical: 'native',
      assetType: 'native',
      code: 'XLM',
    };
  }

  const separatorIndex = canonicalAsset.indexOf(':');

  if (separatorIndex === -1) {
    return {
      canonical: canonicalAsset,
      assetType: 'unknown',
      code: canonicalAsset,
    };
  }

  const code = canonicalAsset.slice(0, separatorIndex);
  const issuer = canonicalAsset.slice(separatorIndex + 1);

  return {
    canonical: canonicalAsset,
    assetType: 'issued',
    code: code || 'Unknown',
    issuer: issuer || undefined,
  };
}

/**
 * Converts one Horizon reserve entry into a display-friendly representation.
 */
export function parseLiquidityPoolReserve(
  reserve: RawLiquidityPoolReserve,
): ParsedLiquidityPoolReserve {
  return {
    asset: parseLiquidityPoolAsset(reserve.asset),
    amount: reserve.amount ?? '0.0000000',
  };
}

/**
 * Converts one Horizon liquidity pool record into a consistent representation.
 */
export function parseLiquidityPoolRecord(record: RawLiquidityPoolRecord): ParsedLiquidityPool {
  const feeBasisPoints = record.fee_bp ?? 0;

  return {
    id: record.id ?? '',
    pagingToken: record.paging_token ?? record.id ?? '',
    poolType: record.type ?? 'Unknown',
    feeBasisPoints,
    feePercentage: formatLiquidityPoolFee(feeBasisPoints),
    totalShares: record.total_shares ?? '0.0000000',
    participatingAccounts: record.total_trustlines ?? 0,
    reserves: (record.reserves ?? []).map(parseLiquidityPoolReserve),
    lastModifiedLedger: record.last_modified_ledger,
    lastModifiedTime: record.last_modified_time,
    selfUrl: record._links?.self?.href,
  };
}

/**
 * Creates summary statistics for the currently retrieved pool page.
 */
export function summarizeLiquidityPools(pools: ParsedLiquidityPool[]): LiquidityPoolSummary {
  const poolTypes: Record<string, number> = {};

  for (const pool of pools) {
    poolTypes[pool.poolType] = (poolTypes[pool.poolType] ?? 0) + 1;
  }

  return {
    totalPools: pools.length,
    totalReserveEntries: pools.reduce((total, pool) => total + pool.reserves.length, 0),
    totalParticipatingAccounts: pools.reduce(
      (total, pool) => total + pool.participatingAccounts,
      0,
    ),
    poolTypes,
  };
}

/**
 * Browses available liquidity pools through Horizon.
 */
export async function fetchLiquidityPools(
  server: Horizon.Server,
  limit: number,
): Promise<RawLiquidityPoolRecord[]> {
  const page = await server.liquidityPools().order('desc').limit(limit).call();

  return page.records as unknown as RawLiquidityPoolRecord[];
}

/**
 * Retrieves one liquidity pool by its deterministic ID.
 */
export async function fetchLiquidityPoolById(
  server: Horizon.Server,
  poolId: string,
): Promise<RawLiquidityPoolRecord> {
  const record = await server.liquidityPools().liquidityPoolId(poolId).call();

  return record as unknown as RawLiquidityPoolRecord;
}

/**
 * Extracts an HTTP status from an unknown Horizon error.
 */
export function getHorizonErrorStatus(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'response' in error) {
    const response = (error as { response?: { status?: unknown } }).response;

    if (typeof response?.status === 'number') {
      return response.status;
    }
  }

  return undefined;
}

/**
 * Extracts a readable message from an unknown error.
 */
export function getLiquidityPoolErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

/**
 * Detects a Horizon response for an unknown liquidity pool.
 */
export function isLiquidityPoolNotFoundError(error: unknown): boolean {
  return getHorizonErrorStatus(error) === 404;
}

/**
 * Formats one reserve for console output.
 */
export function formatLiquidityPoolReserve(
  reserve: ParsedLiquidityPoolReserve,
  index: number,
): string {
  const asset = reserve.asset;

  if (asset.assetType === 'native') {
    return `    Reserve ${index + 1}: ${reserve.amount} XLM (native)`;
  }

  if (asset.assetType === 'issued') {
    return [
      `    Reserve ${index + 1}: ${reserve.amount} ${asset.code}`,
      `      Issuer: ${asset.issuer ?? 'Unknown'}`,
      `      Canonical asset: ${asset.canonical}`,
    ].join('\n');
  }

  return [
    `    Reserve ${index + 1}: ${reserve.amount} ${asset.code}`,
    `      Canonical asset: ${asset.canonical}`,
  ].join('\n');
}

/**
 * Formats one liquidity pool as a readable console section.
 */
export function formatLiquidityPool(pool: ParsedLiquidityPool, index: number): string {
  const lines: string[] = [];

  lines.push(`[${index + 1}] Liquidity Pool`);
  lines.push(`    Pool ID:                 ${pool.id || 'Unavailable'}`);
  lines.push(`    Pool Type:               ${pool.poolType}`);
  lines.push(`    Fee:                     ${pool.feeBasisPoints} bp (${pool.feePercentage})`);
  lines.push(`    Total Pool Shares:       ${pool.totalShares}`);
  lines.push(`    Participating Accounts:  ${pool.participatingAccounts}`);

  if (pool.lastModifiedLedger !== undefined) {
    lines.push(`    Last Modified Ledger:    ${pool.lastModifiedLedger}`);
  }

  if (pool.lastModifiedTime) {
    lines.push(`    Last Modified Time:      ${pool.lastModifiedTime}`);
  }

  lines.push('    Reserves:');

  if (pool.reserves.length === 0) {
    lines.push('      No reserve entries were supplied by Horizon.');
  } else {
    pool.reserves.forEach((reserve, reserveIndex) => {
      lines.push(formatLiquidityPoolReserve(reserve, reserveIndex));
    });
  }

  if (pool.selfUrl) {
    lines.push(`    Horizon Resource:        ${pool.selfUrl}`);
  }

  return lines.join('\n');
}

/**
 * Produces the full liquidity pool inspection report.
 */
export function formatLiquidityPoolReport(
  poolId: string | undefined,
  limit: number,
  pools: ParsedLiquidityPool[],
  summary: LiquidityPoolSummary = summarizeLiquidityPools(pools),
): string {
  const lines: string[] = [];

  lines.push('=== Stellar Horizon Liquidity Pool Inspection ===');
  lines.push(`Inspection Mode: ${poolId ? 'Specific liquidity pool' : 'Browse available pools'}`);

  if (poolId) {
    lines.push(`Requested Pool:  ${poolId}`);
  } else {
    lines.push(`Result Limit:    ${limit}`);
  }

  lines.push(`Pools Found:     ${pools.length}`);

  if (pools.length === 0) {
    lines.push('');
    lines.push(
      poolId
        ? `No liquidity pool was found for ID ${poolId}.`
        : 'Horizon returned no available liquidity pools.',
    );
    lines.push('');
    lines.push('This empty result was handled safely.');
    lines.push('');
    lines.push('Liquidity pool IDs:');
    lines.push('  - are deterministic hashes of the canonical pool parameters,');
    lines.push('  - identify the reserve asset pair and fee configuration, and');
    lines.push('  - are used by Horizon, operations, trades, and pool-share trustlines.');

    return lines.join('\n');
  }

  lines.push('');
  lines.push('Liquidity Pools:');

  pools.forEach((pool, index) => {
    lines.push('');
    lines.push(formatLiquidityPool(pool, index));
  });

  lines.push('');
  lines.push('Result Summary:');
  lines.push(`  Pools returned:          ${summary.totalPools}`);
  lines.push(`  Reserve entries:         ${summary.totalReserveEntries}`);
  lines.push(`  Participating accounts:  ${summary.totalParticipatingAccounts}`);

  lines.push('  Pool types:');

  for (const [poolType, count] of Object.entries(summary.poolTypes)) {
    lines.push(`    - ${poolType}: ${count}`);
  }

  lines.push('');
  lines.push('How liquidity pool shares work:');
  lines.push('  - Providers deposit both reserve assets and receive pool shares.');
  lines.push('  - Pool shares represent proportional ownership of the reserves.');
  lines.push('  - Trade fees increase pool reserves and benefit pool shareholders.');
  lines.push('  - Providers redeem pool shares when withdrawing their reserves.');

  lines.push('');
  lines.push('How liquidity pool IDs work:');
  lines.push('  - The ID is derived from canonical pool parameters, not chosen manually.');
  lines.push('  - The same reserve pair and fee configuration produces the same ID.');
  lines.push('  - Applications use the ID to retrieve pools and reference pool activity.');

  lines.push('');
  lines.push('This summary covers only the retrieved Horizon result page.');

  return lines.join('\n');
}

/**
 * Runs the liquidity-pool inspection example.
 *
 * Configuration:
 *
 *   Interactive runner:
 *     npm run run-example 64-liquidity-pool-inspection
 *
 *   CLI browse:
 *     npm run run-example -- 64-liquidity-pool-inspection "" 10
 *
 *   CLI lookup:
 *     npm run run-example -- 64-liquidity-pool-inspection POOL_ID
 *
 *   Environment:
 *     LIQUIDITY_POOL_ID=64_CHARACTER_HEX_ID
 *     LIQUIDITY_POOL_LIMIT=10
 *     HORIZON_URL=https://horizon-testnet.stellar.org
 */
export async function run(params: LiquidityPoolInspectionParams = {}): Promise<void> {
  const horizonUrl = params.horizonUrl || process.env.HORIZON_URL || DEFAULT_HORIZON_URL;

  const server = new Horizon.Server(horizonUrl);

  const limit = normalizeLiquidityPoolLimit(
    params.limit ?? process.env.LIQUIDITY_POOL_LIMIT ?? process.argv[4],
  );

  let poolId: string | undefined;

  try {
    poolId = normalizeLiquidityPoolId(
      params.poolId ?? process.env.LIQUIDITY_POOL_ID ?? process.argv[3],
    );
  } catch (error: unknown) {
    console.log(`Invalid liquidity pool ID: ${getLiquidityPoolErrorMessage(error)}`);
    console.log('Liquidity pool inspection stopped safely without querying Horizon.');
    return;
  }

  console.log('Starting Horizon Liquidity Pool Inspection Example...');
  console.log(`Using Horizon: ${horizonUrl}`);

  if (poolId) {
    console.log(`Looking up liquidity pool: ${poolId}`);
  } else {
    console.log(`Browsing available liquidity pools with limit ${limit}.`);
  }

  console.log('Pool shares represent proportional ownership of the two reserve assets.');

  let records: RawLiquidityPoolRecord[];

  try {
    if (poolId) {
      records = [await fetchLiquidityPoolById(server, poolId)];
    } else {
      records = await fetchLiquidityPools(server, limit);
    }
  } catch (error: unknown) {
    if (poolId && isLiquidityPoolNotFoundError(error)) {
      console.log('\n' + formatLiquidityPoolReport(poolId, limit, []));
      console.log('\nLiquidity pool inspection completed (unknown pool handled safely).');
      return;
    }

    console.log(`\nCould not retrieve liquidity pools: ${getLiquidityPoolErrorMessage(error)}`);
    return;
  }

  const pools = records.map(parseLiquidityPoolRecord);
  const summary = summarizeLiquidityPools(pools);

  console.log('\n' + formatLiquidityPoolReport(poolId, limit, pools, summary));

  if (pools.length === 0) {
    console.log('\nLiquidity pool inspection completed (empty result handled gracefully).');
    return;
  }

  console.log('\nLiquidity pool inspection completed successfully.');
}
