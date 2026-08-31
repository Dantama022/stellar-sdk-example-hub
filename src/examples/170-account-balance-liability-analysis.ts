/**
 * 170-account-balance-liability-analysis: Account Balance and Liability Analysis
 *
 * OVERVIEW
 * --------
 * The balance Horizon reports for an account is the amount the ledger holds,
 * not the amount the account can immediately spend. Two things reduce it:
 *
 *   - Selling liabilities: amounts already committed to open SDEX offers.
 *   - The minimum reserve (native XLM only): base reserve plus one reserve per
 *     subentry, which can never be spent while those subentries exist.
 *
 * Buying liabilities work in the other direction — they are amounts the account
 * has committed to *receive*, and they count against a trustline's limit rather
 * than against its balance.
 *
 * AVAILABLE AMOUNT
 * ----------------
 *   Issued asset:  available = balance - sellingLiabilities
 *   Native XLM:    available = balance - sellingLiabilities - minimumReserve
 *   Headroom:      headroom  = limit - balance - buyingLiabilities
 *
 * `minimumReserve = (2 + subentryCount - numSponsored + numSponsoring) × 0.5 XLM`
 *
 * All three are *derived* values computed from ledger-reported fields. The
 * report keeps them visually separate from what Horizon actually returned, so a
 * reader is never misled into treating a computed figure as authoritative
 * ledger state.
 *
 * TRUSTLINE LIMITS
 * ----------------
 * A trustline caps how much of an asset an account may hold. Once
 * `balance + buyingLiabilities` approaches `limit`, further incoming payments
 * and buy offers start failing with `op_line_full`, so trustlines close to
 * their limit are flagged.
 *
 * AUTHORIZATION
 * -------------
 * An issuer using `AUTH_REQUIRED` must authorize each trustline. An
 * unauthorized trustline may still report a balance, but that balance cannot be
 * transferred; a trustline authorized only "to maintain liabilities" can settle
 * existing offers but cannot accept new payments.
 *
 * This example is read-only and submits nothing to the network.
 */

import { Horizon, StrKey } from '@stellar/stellar-sdk';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const FALLBACK_ACCOUNT_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
const BASE_RESERVE_XLM = 0.5;
const BASE_ENTRY_COUNT = 2;
/** Fraction of a trustline limit above which the line is reported as "near limit". */
const NEAR_LIMIT_THRESHOLD = 0.9;
/** Fraction of a balance above which liabilities are reported as "significant". */
const SIGNIFICANT_LIABILITY_THRESHOLD = 0.5;

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export interface BalanceLine {
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
  balance?: string;
  limit?: string;
  buying_liabilities?: string;
  selling_liabilities?: string;
  is_authorized?: boolean;
  is_authorized_to_maintain_liabilities?: boolean;
}

export interface AccountLike {
  account_id?: string;
  id?: string;
  sequence?: string;
  subentry_count?: number;
  num_sponsored?: number;
  num_sponsoring?: number;
  balances?: BalanceLine[];
}

/** One analysed balance line. `reported` fields come from Horizon verbatim. */
export interface AssetPosition {
  assetType: string;
  assetCode: string;
  assetIssuer: string | null;
  isNative: boolean;
  reported: {
    balance: number;
    limit: number | null;
    buyingLiabilities: number;
    sellingLiabilities: number;
    authorized: boolean;
    authorizedToMaintainLiabilities: boolean;
  };
  derived: {
    totalLiabilities: number;
    availableAmount: number;
    reserveDeduction: number;
    limitUtilization: number | null;
    limitHeadroom: number | null;
    nearLimit: boolean;
    significantLiabilities: boolean;
  };
}

export interface AccountLiabilityReport {
  accountId: string;
  horizonUrl: string;
  sequence: string | null;
  reported: {
    balanceCount: number;
    subentryCount: number;
    numSponsored: number;
    numSponsoring: number;
  };
  derived: {
    minimumReserveXlm: number;
    nativeBalance: number;
    nativeAvailable: number;
    nativeBuyingLiabilities: number;
    nativeSellingLiabilities: number;
    issuedAssetCount: number;
    unauthorizedTrustlineCount: number;
    nearLimitTrustlineCount: number;
  };
  native: AssetPosition | null;
  issuedAssets: AssetPosition[];
  warnings: string[];
}

export interface RunParams {
  accountId?: string;
  json?: boolean | string;
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

/** Checks that a string is a valid ed25519 public key (`G…`). */
export function isValidAccountId(accountId: unknown): accountId is string {
  if (typeof accountId !== 'string') return false;
  return StrKey.isValidEd25519PublicKey(accountId);
}

/** Parses a Horizon amount string into a number, treating anything unusable as 0. */
export function parseAmount(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Formats a numeric amount using Stellar's 7-decimal convention. */
export function formatAmount(value: number): string {
  return value.toFixed(7);
}

/**
 * Minimum XLM an account must retain.
 *
 * Sponsored subentries are paid for by a sponsor and so are subtracted, while
 * subentries this account sponsors for others are added to its own requirement.
 */
export function calculateMinimumReserve(
  subentryCount: number,
  numSponsored = 0,
  numSponsoring = 0,
  baseReserve = BASE_RESERVE_XLM,
): number {
  const entries = BASE_ENTRY_COUNT + subentryCount - numSponsored + numSponsoring;
  return Math.max(0, entries) * baseReserve;
}

/** Human-readable label for a balance line. */
export function describeAsset(line: BalanceLine): string {
  if (line.asset_type === 'native') return 'XLM (native)';
  if (line.asset_type === 'liquidity_pool_shares') return 'Liquidity pool shares';
  return line.asset_code ?? 'unknown';
}

// ──────────────────────────────────────────────────────────────────────────────
// Analysis
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Analyses one balance line into reported and derived halves.
 *
 * `reserveDeduction` is non-zero only for the native balance: issued assets
 * carry no reserve of their own. Available amounts are floored at zero because
 * a negative "available" is not meaningful — it just means the whole balance is
 * spoken for.
 */
export function analysePosition(line: BalanceLine, reserveDeduction = 0): AssetPosition {
  const isNative = line.asset_type === 'native';
  const balance = parseAmount(line.balance);
  const buyingLiabilities = parseAmount(line.buying_liabilities);
  const sellingLiabilities = parseAmount(line.selling_liabilities);
  const limit = line.limit === undefined ? null : parseAmount(line.limit);

  const availableAmount = Math.max(0, balance - sellingLiabilities - reserveDeduction);
  // Headroom counts buying liabilities because incoming amounts already
  // committed to open buy offers will land on this trustline.
  const limitHeadroom = limit === null ? null : Math.max(0, limit - balance - buyingLiabilities);
  const limitUtilization =
    limit === null || limit <= 0 ? null : ((balance + buyingLiabilities) / limit) * 100;

  return {
    assetType: line.asset_type ?? 'unknown',
    assetCode: describeAsset(line),
    assetIssuer: line.asset_issuer ?? null,
    isNative,
    reported: {
      balance,
      limit,
      buyingLiabilities,
      sellingLiabilities,
      // Horizon omits these flags when the issuer does not use AUTH_REQUIRED,
      // in which case the trustline is authorized by default.
      authorized: line.is_authorized !== false,
      authorizedToMaintainLiabilities: line.is_authorized_to_maintain_liabilities !== false,
    },
    derived: {
      totalLiabilities: buyingLiabilities + sellingLiabilities,
      availableAmount,
      reserveDeduction,
      limitUtilization,
      limitHeadroom,
      nearLimit: limitUtilization !== null && limitUtilization >= NEAR_LIMIT_THRESHOLD * 100,
      significantLiabilities:
        balance > 0 &&
        buyingLiabilities + sellingLiabilities >= balance * SIGNIFICANT_LIABILITY_THRESHOLD,
    },
  };
}

/** Builds the complete balance-and-liability report for an account record. */
export function analyseAccount(
  account: AccountLike,
  horizonUrl: string,
  baseReserve = BASE_RESERVE_XLM,
): AccountLiabilityReport {
  const balances = account.balances ?? [];
  const subentryCount = account.subentry_count ?? 0;
  const numSponsored = account.num_sponsored ?? 0;
  const numSponsoring = account.num_sponsoring ?? 0;
  const minimumReserveXlm = calculateMinimumReserve(
    subentryCount,
    numSponsored,
    numSponsoring,
    baseReserve,
  );

  const nativeLine = balances.find((line) => line.asset_type === 'native');
  const native = nativeLine ? analysePosition(nativeLine, minimumReserveXlm) : null;
  const issuedAssets = balances
    .filter((line) => line.asset_type !== 'native')
    .map((line) => analysePosition(line));

  const warnings: string[] = [];
  if (!native) {
    warnings.push('Account has no native XLM balance line — unusual for a funded account.');
  }
  if (issuedAssets.length === 0) {
    warnings.push('Account holds no issued assets; only the native balance is analysed.');
  }
  if (native?.derived.availableAmount === 0 && native.reported.balance > 0) {
    warnings.push(
      'Entire native balance is locked by the minimum reserve and selling liabilities.',
    );
  }
  issuedAssets
    .filter((position) => !position.reported.authorized)
    .forEach((position) =>
      warnings.push(`Trustline for ${position.assetCode} is not authorized by its issuer.`),
    );
  issuedAssets
    .filter((position) => position.derived.nearLimit)
    .forEach((position) =>
      warnings.push(
        `Trustline for ${position.assetCode} is at ` +
          `${position.derived.limitUtilization?.toFixed(2)}% of its limit — ` +
          'further inbound payments may fail with op_line_full.',
      ),
    );

  return {
    accountId: account.account_id ?? account.id ?? 'unknown',
    horizonUrl,
    sequence: account.sequence ?? null,
    reported: {
      balanceCount: balances.length,
      subentryCount,
      numSponsored,
      numSponsoring,
    },
    derived: {
      minimumReserveXlm,
      nativeBalance: native?.reported.balance ?? 0,
      nativeAvailable: native?.derived.availableAmount ?? 0,
      nativeBuyingLiabilities: native?.reported.buyingLiabilities ?? 0,
      nativeSellingLiabilities: native?.reported.sellingLiabilities ?? 0,
      issuedAssetCount: issuedAssets.length,
      unauthorizedTrustlineCount: issuedAssets.filter((p) => !p.reported.authorized).length,
      nearLimitTrustlineCount: issuedAssets.filter((p) => p.derived.nearLimit).length,
    },
    native,
    issuedAssets,
    warnings,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Display
// ──────────────────────────────────────────────────────────────────────────────

function displayPosition(position: AssetPosition): void {
  const issuer = position.assetIssuer ? `${position.assetIssuer.slice(0, 8)}…` : 'n/a';
  console.log(`\n  ${position.assetCode}  (issuer: ${issuer})`);
  console.log('    Ledger-reported:');
  console.log(`      balance             = ${formatAmount(position.reported.balance)}`);
  console.log(
    `      limit               = ${position.reported.limit === null ? 'n/a (native)' : formatAmount(position.reported.limit)}`,
  );
  console.log(`      buying liabilities  = ${formatAmount(position.reported.buyingLiabilities)}`);
  console.log(`      selling liabilities = ${formatAmount(position.reported.sellingLiabilities)}`);
  console.log(`      authorized          = ${position.reported.authorized}`);
  console.log(`      auth. to maintain   = ${position.reported.authorizedToMaintainLiabilities}`);
  console.log('    Derived:');
  console.log(`      available amount    = ${formatAmount(position.derived.availableAmount)}`);
  if (position.derived.reserveDeduction > 0) {
    console.log(
      `      reserve deduction   = ${formatAmount(position.derived.reserveDeduction)} (native only)`,
    );
  }
  if (position.derived.limitUtilization !== null) {
    console.log(`      limit utilization   = ${position.derived.limitUtilization.toFixed(2)}%`);
    console.log(`      headroom            = ${formatAmount(position.derived.limitHeadroom ?? 0)}`);
  }
  if (position.derived.nearLimit) {
    console.log('      ⚠ trustline is near its limit');
  }
  if (position.derived.significantLiabilities) {
    console.log('      ⚠ liabilities are significant relative to the balance');
  }
}

function displayReport(report: AccountLiabilityReport): void {
  console.log('\n=== Account Balance and Liability Analysis ===');
  console.log(`  Account:  ${report.accountId}`);
  console.log(`  Horizon:  ${report.horizonUrl}`);
  console.log(`  Sequence: ${report.sequence ?? 'unknown'}`);

  console.log('\n── Account Summary ────────────────────────────────────────');
  console.log(`  Balance lines:       ${report.reported.balanceCount}`);
  console.log(`  Issued assets:       ${report.derived.issuedAssetCount}`);
  console.log(`  Subentries:          ${report.reported.subentryCount}`);
  console.log(`  Sponsored entries:   ${report.reported.numSponsored}`);
  console.log(`  Sponsoring entries:  ${report.reported.numSponsoring}`);
  console.log(
    `  Minimum reserve:     ${formatAmount(report.derived.minimumReserveXlm)} XLM (derived)`,
  );
  console.log(
    `  Native available:    ${formatAmount(report.derived.nativeAvailable)} XLM (derived)`,
  );
  console.log(`  Unauthorized lines:  ${report.derived.unauthorizedTrustlineCount}`);
  console.log(`  Near-limit lines:    ${report.derived.nearLimitTrustlineCount}`);

  console.log('\n── Native XLM ─────────────────────────────────────────────');
  if (report.native) {
    displayPosition(report.native);
  } else {
    console.log('  No native balance line found.');
  }

  console.log('\n── Issued Assets ──────────────────────────────────────────');
  if (report.issuedAssets.length === 0) {
    console.log('  This account holds no issued assets.');
  } else {
    report.issuedAssets.forEach(displayPosition);
  }

  if (report.warnings.length > 0) {
    console.log('\n── Notes and Warnings ─────────────────────────────────────');
    report.warnings.forEach((warning) => console.log(`  • ${warning}`));
  }

  console.log('\n── How to Read This ───────────────────────────────────────');
  console.log('  • "Ledger-reported" values come straight from Horizon.');
  console.log('  • "Derived" values are computed by this example, not by the ledger.');
  console.log('  • Selling liabilities are already committed to open offers.');
  console.log('  • Buying liabilities count against a trustline limit, not the balance.');
  console.log('  • Only the native balance carries the minimum reserve deduction.');
}

// ──────────────────────────────────────────────────────────────────────────────
// Entry point
// ──────────────────────────────────────────────────────────────────────────────

function wantsJson(params: RunParams): boolean {
  return (
    params.json === true ||
    params.json === 'true' ||
    process.env.OUTPUT_FORMAT === 'json' ||
    process.argv.includes('--json')
  );
}

/**
 * Runs the account balance and liability analysis example.
 */
export async function run(params: RunParams = {}): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL ?? DEFAULT_HORIZON_URL;
  const outputJson = wantsJson(params);

  const accountId =
    (typeof params.accountId === 'string' && params.accountId.trim()) ||
    process.env.ACCOUNT_ID?.trim() ||
    FALLBACK_ACCOUNT_ID;

  console.log('Starting Account Balance and Liability Analysis Example...');
  console.log(`Using Horizon: ${horizonUrl}`);

  if (!isValidAccountId(accountId)) {
    throw new Error(
      `Invalid account ID "${accountId}": expected a 56-character G… ed25519 public key.`,
    );
  }

  console.log(`Analysing account: ${accountId}`);

  const server = new Horizon.Server(horizonUrl);

  let account: AccountLike;
  try {
    account = (await server.loadAccount(accountId)) as unknown as AccountLike;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not load account ${accountId} from ${horizonUrl}: ${message}. ` +
        'Verify the account exists on this network and has been funded.',
    );
  }

  const report = analyseAccount(account, horizonUrl);

  if (outputJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  displayReport(report);
  console.log('\nAccount balance and liability analysis completed.');
}
