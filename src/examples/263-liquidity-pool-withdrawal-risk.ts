/**
 * 263-liquidity-pool-withdrawal-risk: Stellar Liquidity Pool Reserve and
 * Withdrawal Risk Analyzer
 *
 * OVERVIEW
 * --------
 * Liquidity providers receive pool shares when they deposit both assets into a
 * constant-product Stellar liquidity pool. Before withdrawing, a provider needs
 * to understand:
 *
 *   • the current reserve composition,
 *   • how imbalanced the reserves are,
 *   • how many units of each asset a given share quantity represents, and
 *   • how the provider's ownership compares with the requested withdrawal.
 *
 * This example retrieves a pool from Horizon, performs decimal-safe calculations
 * with integer stroop units, optionally inspects a provider account's pool-share
 * balance, and can compare two pool snapshots.
 *
 * SNAPSHOT, NOT A GUARANTEE
 * ------------------------
 * Every calculation is based on the pool state returned by Horizon at retrieval
 * time. The actual withdrawal is determined by the pool state when the
 * transaction executes and by protocol rounding rules. This example never builds,
 * signs, or submits a withdrawal transaction.
 */

import { Horizon } from '@stellar/stellar-sdk';
import { readFile } from 'fs/promises';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const DEFAULT_IMBALANCE_THRESHOLD_PERCENT = 5;
const DEFAULT_REQUESTED_SHARES = '1.0000000';
const POOL_ID_PATTERN = /^[a-fA-F0-9]{64}$/;
const STROOP_SCALE = 7;

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export interface LiquidityPoolWithdrawalParams {
  poolId?: string;
  requestedShares?: string;
  availableShares?: string;
  accountId?: string;
  previousSnapshotFile?: string;
  imbalanceThresholdPercent?: number | string;
  horizonUrl?: string;
  json?: boolean | string;
}

export interface RawPoolReserve {
  asset?: string;
  amount?: string;
}

export interface RawLiquidityPoolRecord {
  id?: string;
  paging_token?: string;
  type?: string;
  fee_bp?: number;
  total_trustlines?: number;
  total_shares?: string;
  reserves?: RawPoolReserve[];
  last_modified_ledger?: number;
  last_modified_time?: string;
}

export interface PoolAsset {
  canonical: string;
  assetType: 'native' | 'issued' | 'unknown';
  code: string;
  issuer?: string;
}

export interface PoolReserve {
  asset: PoolAsset;
  amount: string;
  amountUnits: string | null;
}

export interface ParsedLiquidityPool {
  id: string;
  pagingToken: string;
  poolType: string;
  feeBasisPoints: number;
  totalTrustlines: number;
  totalShares: string;
  totalSharesUnits: string | null;
  reserves: PoolReserve[];
  lastModifiedLedger: number | null;
  lastModifiedTime: string | null;
  warnings: string[];
  complete: boolean;
}

export interface ReserveComposition {
  reserves: Array<{
    asset: PoolAsset;
    amount: string;
    percent: number;
  }>;
  reserveRatio: string;
  imbalancePercent: number;
  totalReserveUnits: string;
}

export interface ReserveImbalance {
  thresholdPercent: number;
  imbalancePercent: number;
  significant: boolean;
  message: string;
}

export interface WithdrawalPayout {
  asset: PoolAsset;
  amount: string;
}

export interface WithdrawalEstimate {
  requestedShares: string;
  availableShares: string | null;
  totalShares: string;
  payouts: WithdrawalPayout[];
  ownershipRedeemedPercent: number;
  warnings: string[];
  precisionNote: string;
}

export interface ProviderPoolShare {
  accountId: string;
  poolId: string;
  shareBalance: string;
  shareBalanceUnits: string;
  ownershipPercent: number | null;
  limit: string | null;
}

export interface ProviderExposure extends ProviderPoolShare {
  estimatedReserves: WithdrawalPayout[];
}

export interface SnapshotReserveChange {
  asset: PoolAsset;
  before: string;
  after: string;
  delta: string;
  percentChange: number | null;
}

export interface PoolSnapshotComparison {
  beforeLedger: number | null;
  afterLedger: number | null;
  changes: SnapshotReserveChange[];
  increases: SnapshotReserveChange[];
  decreases: SnapshotReserveChange[];
  unchanged: SnapshotReserveChange[];
  significantCompositionChange: boolean;
  thresholdPercent: number;
  notes: string[];
}

export interface WithdrawalRiskReport {
  poolId: string;
  assets: PoolAsset[];
  reserves: PoolReserve[];
  totalShares: string;
  feeBasisPoints: number;
  lastModifiedLedger: number | null;
  composition: ReserveComposition | null;
  imbalance: ReserveImbalance | null;
  requestedShares: string;
  estimatedWithdrawal: WithdrawalEstimate | null;
  providerOwnership: ProviderPoolShare | null;
  providerExposure: ProviderExposure | null;
  providerError: string | null;
  snapshotComparison: PoolSnapshotComparison | null;
  warnings: string[];
  roundingWarnings: string[];
  snapshotCaveat: string;
  analysisStatus: 'ok' | 'warning' | 'incomplete';
}

export interface WithdrawalRiskInput {
  pool: ParsedLiquidityPool;
  requestedShares: string;
  availableShares?: string | null;
  provider?: ProviderPoolShare | null;
  providerError?: string | null;
  previousPool?: ParsedLiquidityPool | null;
  imbalanceThresholdPercent?: number;
  extraWarnings?: string[];
}

// ──────────────────────────────────────────────────────────────────────────────
// Decimal-safe amount helpers
// ──────────────────────────────────────────────────────────────────────────────

export function parseAmountUnits(value: unknown, field = 'amount'): bigint {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,7})?$/.test(value)) {
    throw new Error(
      `${field} must be a non-negative decimal string with at most 7 decimal places.`,
    );
  }
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 10_000_000n + BigInt(fraction.padEnd(STROOP_SCALE, '0'));
}

export function formatAmountUnits(units: bigint, field = 'amount'): string {
  if (units < 0n) throw new Error(`${field} cannot be negative.`);
  const whole = units / 10_000_000n;
  const fraction = units % 10_000_000n;
  return `${whole}.${fraction.toString().padStart(STROOP_SCALE, '0')}`;
}

function formatSignedAmountUnits(units: bigint): string {
  const sign = units < 0n ? '-' : '';
  return `${sign}${formatAmountUnits(units < 0n ? -units : units)}`;
}

function divideUnits(numerator: bigint, denominator: bigint, decimals = 6): string {
  if (denominator === 0n) throw new Error('Cannot divide by zero.');
  const negative = numerator < 0n;
  const value = negative ? -numerator : numerator;
  const scale = 10n ** BigInt(decimals);
  const rounded = (value * scale + denominator / 2n) / denominator;
  const whole = rounded / scale;
  const fraction = rounded % scale;
  return `${negative ? '-' : ''}${whole}.${fraction.toString().padStart(decimals, '0')}`;
}

function percentage(part: bigint, total: bigint, decimals = 4): number {
  if (total <= 0n) return 0;
  const scale = 10n ** BigInt(decimals);
  const scaled = (part * 100n * scale + total / 2n) / total;
  return Number(scaled) / Number(scale);
}

function tryParseUnits(
  value: string | undefined,
  field: string,
  warnings: string[],
): string | null {
  try {
    return parseAmountUnits(value ?? '', field).toString();
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : String(error));
    return null;
  }
}

export function normalizeLiquidityPoolId(value?: string): string {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || !POOL_ID_PATTERN.test(normalized)) {
    throw new Error('Invalid liquidity pool ID. Expected exactly 64 hexadecimal characters.');
  }
  return normalized;
}

// ──────────────────────────────────────────────────────────────────────────────
// Horizon record parsing
// ──────────────────────────────────────────────────────────────────────────────

export function parsePoolAsset(canonicalAsset?: string): PoolAsset {
  if (!canonicalAsset) {
    return { canonical: 'Unknown', assetType: 'unknown', code: 'Unknown' };
  }
  if (canonicalAsset === 'native') {
    return { canonical: 'native', assetType: 'native', code: 'XLM' };
  }
  const separator = canonicalAsset.indexOf(':');
  if (separator === -1) {
    return {
      canonical: canonicalAsset,
      assetType: 'unknown',
      code: canonicalAsset,
    };
  }
  return {
    canonical: canonicalAsset,
    assetType: 'issued',
    code: canonicalAsset.slice(0, separator) || 'Unknown',
    issuer: canonicalAsset.slice(separator + 1) || undefined,
  };
}

export function parseLiquidityPoolRecord(record: RawLiquidityPoolRecord): ParsedLiquidityPool {
  const warnings: string[] = [];
  const reserves = (Array.isArray(record.reserves) ? record.reserves : []).map(
    (reserve, index): PoolReserve => {
      const amount = reserve.amount ?? '0.0000000';
      return {
        asset: parsePoolAsset(reserve.asset),
        amount,
        amountUnits: tryParseUnits(amount, `reserves[${index}].amount`, warnings),
      };
    },
  );

  const totalShares = record.total_shares ?? '0.0000000';
  const totalSharesUnits = tryParseUnits(totalShares, 'total_shares', warnings);
  if (reserves.length !== 2) {
    warnings.push(`Expected exactly two pool reserves, received ${reserves.length}.`);
  }
  if (totalSharesUnits === null || BigInt(totalSharesUnits) <= 0n) {
    warnings.push('Pool total shares must be a positive amount.');
  }

  return {
    id: record.id?.toLowerCase() ?? '',
    pagingToken: record.paging_token ?? record.id ?? '',
    poolType: record.type ?? 'Unknown',
    feeBasisPoints: record.fee_bp ?? 0,
    totalTrustlines: record.total_trustlines ?? 0,
    totalShares,
    totalSharesUnits,
    reserves,
    lastModifiedLedger: record.last_modified_ledger ?? null,
    lastModifiedTime: record.last_modified_time ?? null,
    warnings,
    complete:
      reserves.length === 2 &&
      reserves.every((reserve) => reserve.amountUnits !== null) &&
      totalSharesUnits !== null &&
      BigInt(totalSharesUnits) > 0n,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Reserve analysis
// ──────────────────────────────────────────────────────────────────────────────

export function calculateReserveComposition(pool: ParsedLiquidityPool): ReserveComposition {
  if (pool.reserves.length !== 2) {
    throw new Error('Reserve composition requires exactly two pool reserves.');
  }
  const units = pool.reserves.map((reserve) => {
    if (reserve.amountUnits === null) {
      throw new Error(`Reserve amount for ${reserve.asset.canonical} is not valid.`);
    }
    return BigInt(reserve.amountUnits);
  });
  const total = units[0] + units[1];
  if (total <= 0n) throw new Error('Pool reserves contain no units to analyse.');
  return {
    reserves: pool.reserves.map((reserve, index) => ({
      asset: reserve.asset,
      amount: reserve.amount,
      percent: percentage(units[index], total),
    })),
    reserveRatio: units[1] === 0n ? 'undefined' : divideUnits(units[0], units[1], 6),
    imbalancePercent: percentage(
      units[0] > units[1] ? units[0] - units[1] : units[1] - units[0],
      total,
    ),
    totalReserveUnits: total.toString(),
  };
}

export function detectReserveImbalance(
  composition: ReserveComposition,
  thresholdPercent = DEFAULT_IMBALANCE_THRESHOLD_PERCENT,
): ReserveImbalance {
  const threshold = Number(thresholdPercent);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
    throw new Error('imbalance threshold must be a percentage between 0 and 100.');
  }
  const significant = composition.imbalancePercent >= threshold;
  return {
    thresholdPercent: threshold,
    imbalancePercent: composition.imbalancePercent,
    significant,
    message: significant
      ? `Reserve composition differs by ${composition.imbalancePercent.toFixed(2)} percentage points, at or above the ${threshold}% threshold.`
      : `Reserve composition differs by ${composition.imbalancePercent.toFixed(2)} percentage points, below the ${threshold}% threshold.`,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Withdrawal estimation
// ──────────────────────────────────────────────────────────────────────────────

export function estimateWithdrawal(
  pool: ParsedLiquidityPool,
  requestedShares: string,
  availableShares?: string | null,
): WithdrawalEstimate {
  const requestedUnits = parseAmountUnits(requestedShares, 'requested shares');
  if (requestedUnits <= 0n) throw new Error('requested shares must be greater than zero.');
  if (pool.totalSharesUnits === null) throw new Error('Pool total shares are not valid.');
  const totalSharesUnits = BigInt(pool.totalSharesUnits);
  if (totalSharesUnits <= 0n) throw new Error('Pool total shares must be greater than zero.');
  if (requestedUnits > totalSharesUnits) {
    throw new Error('requested shares cannot exceed the pool total shares.');
  }
  if (availableShares !== undefined && availableShares !== null) {
    const availableUnits = parseAmountUnits(availableShares, 'available shares');
    if (requestedUnits > availableUnits) {
      throw new Error('requested shares exceed the available provider share balance.');
    }
  }

  const warnings: string[] = [];
  let precisionLost = false;
  const payouts = pool.reserves.map((reserve) => {
    if (reserve.amountUnits === null) {
      throw new Error(`Reserve amount for ${reserve.asset.canonical} is not valid.`);
    }
    const product = BigInt(reserve.amountUnits) * requestedUnits;
    const amountUnits = product / totalSharesUnits;
    if (product % totalSharesUnits !== 0n) precisionLost = true;
    return {
      asset: reserve.asset,
      amount: formatAmountUnits(amountUnits),
    };
  });

  if (precisionLost) {
    warnings.push(
      'At least one estimated payout rounds down at Stellar’s 7-decimal precision, potentially to zero.',
    );
  }

  return {
    requestedShares,
    availableShares: availableShares ?? null,
    totalShares: pool.totalShares,
    payouts,
    ownershipRedeemedPercent: percentage(requestedUnits, totalSharesUnits),
    warnings,
    precisionNote:
      'Amounts are rounded down to 7 decimal places. The executed transaction uses the pool reserves and total shares at execution time, not this snapshot.',
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Provider exposure
// ──────────────────────────────────────────────────────────────────────────────

interface AccountBalanceLike {
  asset_type?: string;
  liquidity_pool_id?: string;
  balance?: string;
  limit?: string;
}

interface AccountLike {
  account_id?: string;
  id?: string;
  balances?: AccountBalanceLike[];
}

export function extractProviderPoolShare(
  account: AccountLike,
  poolId: string,
): ProviderPoolShare | null {
  const accountId = account.account_id ?? account.id;
  if (!accountId) return null;
  const normalizedPoolId = poolId.toLowerCase();
  const line = (account.balances ?? []).find(
    (balance) =>
      balance.asset_type === 'liquidity_pool_shares' &&
      balance.liquidity_pool_id?.toLowerCase() === normalizedPoolId,
  );
  if (!line?.balance) return null;
  try {
    return {
      accountId,
      poolId: normalizedPoolId,
      shareBalance: line.balance,
      shareBalanceUnits: parseAmountUnits(line.balance, 'pool share balance').toString(),
      ownershipPercent: null,
      limit: line.limit ?? null,
    };
  } catch {
    return null;
  }
}

export function calculateProviderExposure(
  provider: ProviderPoolShare,
  pool: ParsedLiquidityPool,
): ProviderExposure {
  if (pool.totalSharesUnits === null) throw new Error('Pool total shares are not valid.');
  const shareUnits = parseAmountUnits(provider.shareBalance, 'provider share balance');
  const totalSharesUnits = BigInt(pool.totalSharesUnits);
  if (totalSharesUnits <= 0n) throw new Error('Pool total shares must be greater than zero.');
  const estimatedReserves = pool.reserves.map((reserve) => {
    if (reserve.amountUnits === null) {
      throw new Error(`Reserve amount for ${reserve.asset.canonical} is not valid.`);
    }
    return {
      asset: reserve.asset,
      amount: formatAmountUnits((BigInt(reserve.amountUnits) * shareUnits) / totalSharesUnits),
    };
  });
  return {
    ...provider,
    ownershipPercent: percentage(shareUnits, totalSharesUnits),
    estimatedReserves,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Snapshot comparison
// ──────────────────────────────────────────────────────────────────────────────

export function comparePoolSnapshots(
  before: ParsedLiquidityPool,
  after: ParsedLiquidityPool,
  significantThresholdPercent = DEFAULT_IMBALANCE_THRESHOLD_PERCENT,
): PoolSnapshotComparison {
  const changes: SnapshotReserveChange[] = [];
  for (const beforeReserve of before.reserves) {
    const afterReserve = after.reserves.find(
      (reserve) => reserve.asset.canonical === beforeReserve.asset.canonical,
    );
    if (!afterReserve) continue;
    const beforeUnits = BigInt(beforeReserve.amountUnits ?? '0');
    const afterUnits = BigInt(afterReserve.amountUnits ?? '0');
    const delta = afterUnits - beforeUnits;
    const percentChange =
      beforeUnits === 0n
        ? null
        : Number((delta * 100_000_000n) / beforeUnits) / 1_000_000;
    changes.push({
      asset: beforeReserve.asset,
      before: beforeReserve.amount,
      after: afterReserve.amount,
      delta: formatSignedAmountUnits(delta),
      percentChange,
    });
  }

  const notes: string[] = [];
  if (before.reserves.length !== after.reserves.length) {
    notes.push('Snapshots contain different numbers of reserves.');
  }
  if (before.lastModifiedLedger === null || after.lastModifiedLedger === null) {
    notes.push('One or both snapshots do not include a last-modified ledger.');
  }
  if (
    before.lastModifiedLedger !== null &&
    before.lastModifiedLedger === after.lastModifiedLedger
  ) {
    notes.push('Both snapshots report the same last-modified ledger.');
  }
  notes.push(
    'Reserve changes alone do not prove market-price movement, impermanent loss, or the cause of the change.',
  );

  return {
    beforeLedger: before.lastModifiedLedger,
    afterLedger: after.lastModifiedLedger,
    changes,
    increases: changes.filter((change) => BigInt(change.delta.replace('.', '')) > 0n),
    decreases: changes.filter((change) => BigInt(change.delta.replace('.', '')) < 0n),
    unchanged: changes.filter((change) => BigInt(change.delta.replace('.', '')) === 0n),
    significantCompositionChange: changes.some(
      (change) =>
        change.percentChange !== null &&
        Math.abs(change.percentChange) >= significantThresholdPercent,
    ),
    thresholdPercent: significantThresholdPercent,
    notes,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Report assembly and display
// ──────────────────────────────────────────────────────────────────────────────

export function buildWithdrawalRiskReport(input: WithdrawalRiskInput): WithdrawalRiskReport {
  const warnings = [...input.pool.warnings, ...(input.extraWarnings ?? [])];
  const availableShares = input.availableShares ?? input.provider?.shareBalance ?? null;
  const composition = input.pool.complete ? calculateReserveComposition(input.pool) : null;
  const imbalance = composition
    ? detectReserveImbalance(composition, input.imbalanceThresholdPercent)
    : null;
  const estimatedWithdrawal =
    input.pool.complete && composition
      ? estimateWithdrawal(input.pool, input.requestedShares, availableShares)
      : null;
  const providerExposure =
    input.provider && input.pool.complete
      ? calculateProviderExposure(input.provider, input.pool)
      : null;

  if (input.providerError) warnings.push(`Provider share lookup failed: ${input.providerError}`);
  else if (input.provider && !providerExposure) {
    warnings.push('Provider pool share information could not be verified.');
  } else if (!input.provider && !availableShares) {
    warnings.push('No provider account was supplied; available share balance was not verified.');
  }
  if (estimatedWithdrawal) warnings.push(...estimatedWithdrawal.warnings);
  if (input.previousPool) {
    if (!input.previousPool.complete) {
      warnings.push('The previous pool snapshot is incomplete; comparison may be partial.');
    }
  }

  const analysisStatus = !input.pool.complete
    ? 'incomplete'
    : imbalance?.significant || warnings.length > 0
      ? 'warning'
      : 'ok';

  return {
    poolId: input.pool.id,
    assets: input.pool.reserves.map((reserve) => reserve.asset),
    reserves: input.pool.reserves,
    totalShares: input.pool.totalShares,
    feeBasisPoints: input.pool.feeBasisPoints,
    lastModifiedLedger: input.pool.lastModifiedLedger,
    composition,
    imbalance,
    requestedShares: input.requestedShares,
    estimatedWithdrawal,
    providerOwnership: providerExposure ?? input.provider ?? null,
    providerExposure,
    providerError: input.providerError ?? null,
    snapshotComparison: input.previousPool
      ? comparePoolSnapshots(
          input.previousPool,
          input.pool,
          input.imbalanceThresholdPercent ?? DEFAULT_IMBALANCE_THRESHOLD_PERCENT,
        )
      : null,
    warnings: [...new Set(warnings)],
    roundingWarnings: estimatedWithdrawal?.warnings ?? [],
    snapshotCaveat:
      'All amounts are estimates based on a retrieved pool snapshot. Actual withdrawal amounts depend on the reserves and total shares when the transaction executes, plus protocol rounding rules. Nothing here is a guaranteed withdrawal outcome.',
    analysisStatus,
  };
}

export function formatWithdrawalRiskReport(report: WithdrawalRiskReport): string {
  const lines = [
    '=== Stellar Liquidity Pool Reserve and Withdrawal Risk Analysis ===',
    `Pool ID: ${report.poolId}`,
    `Assets: ${report.assets.map((asset) => asset.canonical).join(' / ')}`,
    `Total shares: ${report.totalShares}`,
    `Fee: ${(report.feeBasisPoints / 100).toFixed(2)}%`,
    `Last modified ledger: ${report.lastModifiedLedger ?? 'unknown'}`,
    `Analysis status: ${report.analysisStatus}`,
    '',
    'Reserves:',
  ];

  for (const reserve of report.reserves) {
    lines.push(`  ${reserve.asset.canonical}: ${reserve.amount}`);
  }

  if (report.composition) {
    lines.push('', 'Reserve composition:');
    for (const reserve of report.composition.reserves) {
      lines.push(`  ${reserve.asset.canonical}: ${reserve.percent.toFixed(4)}%`);
    }
    lines.push(`  Reserve ratio (A/B): ${report.composition.reserveRatio}`);
  }
  if (report.imbalance) {
    lines.push(
      `  Imbalance: ${report.imbalance.imbalancePercent.toFixed(4)} percentage points ` +
        `(threshold ${report.imbalance.thresholdPercent}%): ${report.imbalance.significant ? 'SIGNIFICANT' : 'within threshold'}`,
    );
  }

  lines.push('', `Requested withdrawal shares: ${report.requestedShares}`);
  if (report.estimatedWithdrawal) {
    lines.push('Estimated withdrawal amounts:');
    for (const payout of report.estimatedWithdrawal.payouts) {
      lines.push(`  ${payout.amount} ${payout.asset.canonical}`);
    }
    lines.push(
      `  Share of total pool: ${report.estimatedWithdrawal.ownershipRedeemedPercent.toFixed(4)}%`,
    );
  } else {
    lines.push('  Estimates unavailable because pool data is incomplete.');
  }

  lines.push('', 'Provider ownership:');
  if (report.providerExposure) {
    lines.push(`  Account: ${report.providerExposure.accountId}`);
    lines.push(`  Share balance: ${report.providerExposure.shareBalance}`);
    lines.push(
      `  Ownership: ${report.providerExposure.ownershipPercent?.toFixed(4) ?? 'unknown'}%`,
    );
    for (const exposure of report.providerExposure.estimatedReserves) {
      lines.push(`  Underlying exposure: ${exposure.amount} ${exposure.asset.canonical}`);
    }
  } else {
    lines.push('  Not available or not supplied.');
  }

  if (report.snapshotComparison) {
    lines.push('', 'Snapshot comparison:');
    lines.push(
      `  Ledgers: ${report.snapshotComparison.beforeLedger ?? 'unknown'} -> ${report.snapshotComparison.afterLedger ?? 'unknown'}`,
    );
    for (const change of report.snapshotComparison.changes) {
      lines.push(
        `  ${change.asset.canonical}: ${change.before} -> ${change.after} ` +
          `(delta ${change.delta}, ${change.percentChange === null ? 'undefined' : `${change.percentChange.toFixed(4)}%`})`,
      );
    }
    for (const note of report.snapshotComparison.notes) lines.push(`  Note: ${note}`);
  }

  if (report.warnings.length > 0) {
    lines.push('', 'Warnings:');
    for (const warning of report.warnings) lines.push(`  - ${warning}`);
  }
  lines.push('', `Caveat: ${report.snapshotCaveat}`);
  return lines.join('\n');
}

function wantsJson(value: boolean | string | undefined): boolean {
  return value === true || value === 'true' || process.env.JSON_OUTPUT === 'true';
}

// ──────────────────────────────────────────────────────────────────────────────
// Entry point
// ──────────────────────────────────────────────────────────────────────────────

export async function run(params: LiquidityPoolWithdrawalParams = {}): Promise<void> {
  const horizonUrl = params.horizonUrl || process.env.HORIZON_URL || DEFAULT_HORIZON_URL;
  const json = wantsJson(params.json);
  const poolIdInput = params.poolId || process.env.LIQUIDITY_POOL_ID || process.argv[3];
  const requestedShares =
    params.requestedShares || process.env.WITHDRAWAL_SHARES || DEFAULT_REQUESTED_SHARES;
  const threshold = Number(
    params.imbalanceThresholdPercent ??
      process.env.IMBALANCE_THRESHOLD_PERCENT ??
      DEFAULT_IMBALANCE_THRESHOLD_PERCENT,
  );

  try {
    if (!poolIdInput) {
      throw new Error(
        'A liquidity pool ID is required. Set LIQUIDITY_POOL_ID or pass poolId in the runner.',
      );
    }
    const poolId = normalizeLiquidityPoolId(poolIdInput);
    const server = new Horizon.Server(horizonUrl);
    const rawPool = (await server
      .liquidityPools()
      .liquidityPoolId(poolId)
      .call()) as unknown as RawLiquidityPoolRecord;
    const pool = parseLiquidityPoolRecord({ ...rawPool, id: rawPool.id ?? poolId });

    let provider: ProviderPoolShare | null = null;
    let providerError: string | null = null;
    const accountId = params.accountId || process.env.ACCOUNT_ID;
    if (accountId) {
      try {
        const account = await server.loadAccount(accountId);
        provider = extractProviderPoolShare(account as unknown as AccountLike, poolId);
        if (!provider) {
          providerError = `Account ${accountId} has no pool-share trustline for ${poolId}.`;
        }
      } catch (error) {
        providerError = error instanceof Error ? error.message : String(error);
      }
    }

    const previousSnapshotFile =
      params.previousSnapshotFile || process.env.PREVIOUS_POOL_SNAPSHOT_FILE;
    let previousPool: ParsedLiquidityPool | null = null;
    if (previousSnapshotFile) {
      const snapshot = JSON.parse(await readFile(previousSnapshotFile, 'utf8')) as
        | RawLiquidityPoolRecord
        | { pool?: RawLiquidityPoolRecord };
      const rawPrevious = 'pool' in snapshot && snapshot.pool ? snapshot.pool : snapshot;
      previousPool = parseLiquidityPoolRecord(rawPrevious as RawLiquidityPoolRecord);
    }

    const availableShares =
      params.availableShares ||
      process.env.AVAILABLE_POOL_SHARES ||
      provider?.shareBalance ||
      null;

    const report = buildWithdrawalRiskReport({
      pool,
      requestedShares,
      availableShares,
      provider,
      providerError,
      previousPool,
      imbalanceThresholdPercent: threshold,
    });

    console.log(json ? JSON.stringify(report, null, 2) : formatWithdrawalRiskReport(report));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) console.log(JSON.stringify({ poolId: poolIdInput ?? null, error: message }, null, 2));
    else console.error(`Could not analyse liquidity pool withdrawal risk: ${message}`);
  }
}
