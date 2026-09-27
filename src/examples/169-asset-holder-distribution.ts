/**
 * 169-asset-holder-distribution: Stellar Asset Holder Distribution Analysis
 *
 * OVERVIEW
 * --------
 * Asset explorers, dashboards, and analytics tools frequently need to answer
 * one question about an issued Stellar asset: who holds it, and how evenly is
 * it spread? Horizon exposes the raw material through `/accounts?asset=...`,
 * which lists every account holding a trustline for the asset, but the
 * aggregation and ranking has to happen client side.
 *
 * WHAT THIS EXAMPLE DOES
 * ----------------------
 *   1. Validates an asset code and issuer account ID.
 *   2. Pages through every trustline Horizon reports for that asset.
 *   3. Extracts holder, balance, limit, authorization state, and liabilities.
 *   4. Aggregates supply statistics (total, average, median, largest).
 *   5. Ranks holders and reports top-N concentration percentages.
 *
 * The example is strictly read-only — it never builds or submits a transaction.
 *
 * HORIZON PAGINATION
 * ------------------
 * `server.accounts().forAsset(asset)` returns at most 200 records per page.
 * A complete holder set is assembled by following `page.next()` until a page
 * comes back empty or a configured page/holder cap is reached. Because Horizon
 * pages are cursor-based over live data, a page request can fail midway; this
 * example records the failure and reports statistics over the holders it did
 * retrieve rather than silently presenting a partial set as complete.
 *
 * BALANCES VS LIABILITIES
 * -----------------------
 * A trustline balance is the ledger-reported amount held. Selling liabilities
 * are amounts already committed to open SDEX offers, so a holder's balance is
 * not necessarily freely transferable. Both are reported separately here; no
 * netting is applied to the distribution totals, which are pure ledger sums.
 *
 * AUTHORIZATION
 * -------------
 * Issuers using `AUTH_REQUIRED` must explicitly authorize each trustline. An
 * unauthorized trustline can still report a non-zero balance (for example after
 * a revocation), so authorized and unauthorized balances are tallied apart.
 */

import { Asset, Horizon, StrKey } from '@stellar/stellar-sdk';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const DEFAULT_ASSET_CODE = 'USDC';
const DEFAULT_ASSET_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const HORIZON_PAGE_LIMIT = 200;
const DEFAULT_MAX_HOLDERS = 400;
const DEFAULT_TOP_N = 10;
const DEFAULT_CONCENTRATION_TIERS = [1, 5, 10, 25, 50];

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export interface AssetHolder {
  account: string;
  balance: number;
  limit: number | null;
  authorized: boolean;
  authorizedToMaintainLiabilities: boolean;
  buyingLiabilities: number;
  sellingLiabilities: number;
}

export interface RankedHolder extends AssetHolder {
  rank: number;
  percentOfTotal: number;
}

export interface ConcentrationTier {
  topN: number;
  balance: number;
  percentOfTotal: number;
}

export interface HolderStatistics {
  holderCount: number;
  nonZeroHolderCount: number;
  zeroBalanceHolderCount: number;
  totalBalance: number;
  averageBalance: number;
  medianBalance: number;
  largestBalance: number;
  authorizedHolderCount: number;
  unauthorizedHolderCount: number;
  authorizedBalance: number;
  unauthorizedBalance: number;
}

export interface HolderDistributionReport {
  assetCode: string;
  assetIssuer: string;
  horizonUrl: string;
  statistics: HolderStatistics;
  topHolders: RankedHolder[];
  concentration: ConcentrationTier[];
  pagesFetched: number;
  truncated: boolean;
  paginationError: string | null;
}

export interface RunParams {
  assetCode?: string;
  assetIssuer?: string;
  maxHolders?: string | number;
  topN?: string | number;
  json?: boolean | string;
}

// ──────────────────────────────────────────────────────────────────────────────
// Validation helpers
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Checks an asset code against the Stellar alphanumeric-4 / alphanumeric-12
 * rules. `XLM` is rejected because the native asset has no issuer and no
 * trustlines, so it has no holder distribution to analyse.
 */
export function isValidAssetCode(code: unknown): code is string {
  if (typeof code !== 'string') return false;
  return /^[A-Za-z0-9]{1,12}$/.test(code);
}

/** Checks that a string is a valid ed25519 public key (`G…`). */
export function isValidAccountId(accountId: unknown): accountId is string {
  if (typeof accountId !== 'string') return false;
  return StrKey.isValidEd25519PublicKey(accountId);
}

/**
 * Builds an `Asset` after validating both halves of its identifier, so that a
 * bad input fails with an actionable message instead of an SDK assertion.
 */
export function buildAsset(code: string, issuer: string): Asset {
  if (!isValidAssetCode(code)) {
    throw new Error(
      `Invalid asset code "${code}": expected 1-12 alphanumeric characters (e.g. USDC).`,
    );
  }
  if (!isValidAccountId(issuer)) {
    throw new Error(`Invalid issuer account "${issuer}": expected a valid G… public key.`);
  }
  return new Asset(code, issuer);
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

// ──────────────────────────────────────────────────────────────────────────────
// Extraction
// ──────────────────────────────────────────────────────────────────────────────

interface BalanceLine {
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
  balance?: string;
  limit?: string;
  is_authorized?: boolean;
  is_authorized_to_maintain_liabilities?: boolean;
  buying_liabilities?: string;
  selling_liabilities?: string;
}

interface AccountLike {
  account_id?: string;
  id?: string;
  balances?: BalanceLine[];
}

/**
 * Pulls the trustline for one asset out of an account record.
 *
 * Horizon returns an account's full balance list, so the matching line has to
 * be selected by code *and* issuer — two different issuers can use the same
 * code. Accounts without a matching line (which Horizon should not return, but
 * which appear if the query is reused) yield `null` and are skipped.
 */
export function extractHolder(
  account: AccountLike,
  code: string,
  issuer: string,
): AssetHolder | null {
  const accountId = account.account_id ?? account.id;
  if (!accountId) return null;

  const line = (account.balances ?? []).find(
    (balance) => balance.asset_code === code && balance.asset_issuer === issuer,
  );
  if (!line) return null;

  return {
    account: accountId,
    balance: parseAmount(line.balance),
    limit: line.limit === undefined ? null : parseAmount(line.limit),
    // Horizon omits the authorization flags entirely for issuers that do not
    // use AUTH_REQUIRED; an absent flag means the trustline is usable.
    authorized: line.is_authorized !== false,
    authorizedToMaintainLiabilities: line.is_authorized_to_maintain_liabilities !== false,
    buyingLiabilities: parseAmount(line.buying_liabilities),
    sellingLiabilities: parseAmount(line.selling_liabilities),
  };
}

/** Maps a page of Horizon account records to holders, dropping non-matches. */
export function extractHolders(
  accounts: AccountLike[],
  code: string,
  issuer: string,
): AssetHolder[] {
  return accounts
    .map((account) => extractHolder(account, code, issuer))
    .filter((holder): holder is AssetHolder => holder !== null);
}

// ──────────────────────────────────────────────────────────────────────────────
// Statistics
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Median of a numeric list. Even-length lists average the two middle values.
 * The input is copied before sorting so callers keep their original ordering.
 */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/** Percentage of `total` represented by `part`, guarding against a zero supply. */
export function percentOf(part: number, total: number): number {
  if (total <= 0) return 0;
  return (part / total) * 100;
}

/** Sorts holders by balance, largest first, without mutating the input. */
export function rankHolders(holders: AssetHolder[]): RankedHolder[] {
  const total = holders.reduce((sum, holder) => sum + holder.balance, 0);
  return [...holders]
    .sort((a, b) => b.balance - a.balance)
    .map((holder, index) => ({
      ...holder,
      rank: index + 1,
      percentOfTotal: percentOf(holder.balance, total),
    }));
}

/** Aggregate supply statistics over a holder set. */
export function computeStatistics(holders: AssetHolder[]): HolderStatistics {
  const balances = holders.map((holder) => holder.balance);
  const totalBalance = balances.reduce((sum, balance) => sum + balance, 0);
  const authorized = holders.filter((holder) => holder.authorized);
  const unauthorized = holders.filter((holder) => !holder.authorized);
  const sumOf = (subset: AssetHolder[]): number =>
    subset.reduce((sum, holder) => sum + holder.balance, 0);

  return {
    holderCount: holders.length,
    // Zero-balance trustlines are real ledger entries, so they count as holders
    // but are surfaced separately — they otherwise drag the average downwards
    // in a way that misrepresents actual circulation.
    nonZeroHolderCount: holders.filter((holder) => holder.balance > 0).length,
    zeroBalanceHolderCount: holders.filter((holder) => holder.balance === 0).length,
    totalBalance,
    averageBalance: holders.length === 0 ? 0 : totalBalance / holders.length,
    medianBalance: median(balances),
    largestBalance: holders.length === 0 ? 0 : Math.max(...balances),
    authorizedHolderCount: authorized.length,
    unauthorizedHolderCount: unauthorized.length,
    authorizedBalance: sumOf(authorized),
    unauthorizedBalance: sumOf(unauthorized),
  };
}

/**
 * Cumulative share of supply held by the largest N holders, for each requested
 * tier. Tiers larger than the holder count are clamped so that, for example,
 * "top 50" over 12 holders reports 12 holders at 100% rather than being dropped.
 */
export function computeConcentration(
  ranked: RankedHolder[],
  totalBalance: number,
  tiers: number[] = DEFAULT_CONCENTRATION_TIERS,
): ConcentrationTier[] {
  const seen = new Set<number>();
  const result: ConcentrationTier[] = [];

  for (const tier of tiers) {
    const size = Math.min(tier, ranked.length);
    if (size <= 0 || seen.has(size)) continue;
    seen.add(size);

    const balance = ranked.slice(0, size).reduce((sum, holder) => sum + holder.balance, 0);
    result.push({ topN: size, balance, percentOfTotal: percentOf(balance, totalBalance) });
  }

  return result;
}

/** Builds the full report from a holder set. */
export function buildReport(
  holders: AssetHolder[],
  options: {
    assetCode: string;
    assetIssuer: string;
    horizonUrl: string;
    topN?: number;
    pagesFetched?: number;
    truncated?: boolean;
    paginationError?: string | null;
  },
): HolderDistributionReport {
  const statistics = computeStatistics(holders);
  const ranked = rankHolders(holders);

  return {
    assetCode: options.assetCode,
    assetIssuer: options.assetIssuer,
    horizonUrl: options.horizonUrl,
    statistics,
    topHolders: ranked.slice(0, options.topN ?? DEFAULT_TOP_N),
    concentration: computeConcentration(ranked, statistics.totalBalance),
    pagesFetched: options.pagesFetched ?? 0,
    truncated: options.truncated ?? false,
    paginationError: options.paginationError ?? null,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Horizon retrieval
// ──────────────────────────────────────────────────────────────────────────────

interface HorizonPage<T> {
  records: T[];
  next: () => Promise<HorizonPage<T>>;
}

export interface FetchResult {
  holders: AssetHolder[];
  pagesFetched: number;
  truncated: boolean;
  paginationError: string | null;
}

/**
 * Pages through every trustline Horizon reports for the asset.
 *
 * Stops when a page comes back empty, when `maxHolders` is reached, or when a
 * page request throws. A mid-stream failure is returned rather than raised so
 * the caller can still report on the holders already collected, clearly marked
 * as incomplete.
 */
export async function fetchAllHolders(
  server: Horizon.Server,
  asset: Asset,
  maxHolders: number = DEFAULT_MAX_HOLDERS,
): Promise<FetchResult> {
  const holders: AssetHolder[] = [];
  const code = asset.getCode();
  const issuer = asset.getIssuer();
  let pagesFetched = 0;
  let truncated = false;
  let paginationError: string | null = null;

  try {
    let page = (await server
      .accounts()
      .forAsset(asset)
      .limit(Math.min(HORIZON_PAGE_LIMIT, Math.max(1, maxHolders)))
      .call()) as unknown as HorizonPage<AccountLike>;

    while (page.records.length > 0) {
      pagesFetched += 1;
      holders.push(...extractHolders(page.records, code, issuer));

      if (holders.length >= maxHolders) {
        truncated = true;
        break;
      }

      page = await page.next();
    }
  } catch (error: unknown) {
    paginationError = error instanceof Error ? error.message : String(error);
  }

  return {
    holders: holders.slice(0, maxHolders),
    pagesFetched,
    truncated,
    paginationError,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Display
// ──────────────────────────────────────────────────────────────────────────────

function displayReport(report: HolderDistributionReport): void {
  const { statistics: stats } = report;

  console.log('\n=== Asset Holder Distribution ===');
  console.log(`  Asset:   ${report.assetCode}`);
  console.log(`  Issuer:  ${report.assetIssuer}`);
  console.log(`  Horizon: ${report.horizonUrl}`);
  console.log(`  Pages fetched: ${report.pagesFetched}`);

  if (stats.holderCount === 0) {
    console.log('\n  No trustlines found for this asset.');
    console.log('  An asset has no holders until at least one account creates a trustline.');
    return;
  }

  console.log('\n── Supply Statistics (ledger-reported) ────────────────────');
  console.log(`  Holders (trustlines):   ${stats.holderCount}`);
  console.log(`  With non-zero balance:  ${stats.nonZeroHolderCount}`);
  console.log(`  With zero balance:      ${stats.zeroBalanceHolderCount}`);
  console.log(`  Total balance:          ${formatAmount(stats.totalBalance)} ${report.assetCode}`);
  console.log(`  Largest holder balance: ${formatAmount(stats.largestBalance)}`);

  console.log('\n── Derived Statistics ─────────────────────────────────────');
  console.log(`  Average balance:        ${formatAmount(stats.averageBalance)}`);
  console.log(`  Median balance:         ${formatAmount(stats.medianBalance)}`);

  console.log('\n── Authorization ──────────────────────────────────────────');
  console.log(
    `  Authorized:   ${stats.authorizedHolderCount} holders / ${formatAmount(stats.authorizedBalance)}`,
  );
  console.log(
    `  Unauthorized: ${stats.unauthorizedHolderCount} holders / ${formatAmount(stats.unauthorizedBalance)}`,
  );

  console.log(
    `\n── Top ${report.topHolders.length} Holders ──────────────────────────────────────`,
  );
  report.topHolders.forEach((holder) => {
    console.log(
      `  ${String(holder.rank).padStart(3)}. ${holder.account}` +
        `\n       balance=${formatAmount(holder.balance)}` +
        ` (${holder.percentOfTotal.toFixed(2)}% of supply)` +
        ` limit=${holder.limit === null ? 'none' : formatAmount(holder.limit)}` +
        ` authorized=${holder.authorized}` +
        `\n       buyingLiabilities=${formatAmount(holder.buyingLiabilities)}` +
        ` sellingLiabilities=${formatAmount(holder.sellingLiabilities)}`,
    );
  });

  console.log('\n── Concentration ──────────────────────────────────────────');
  report.concentration.forEach((tier) => {
    console.log(
      `  Top ${String(tier.topN).padStart(3)}: ${formatAmount(tier.balance)}` +
        ` (${tier.percentOfTotal.toFixed(2)}% of supply)`,
    );
  });

  if (report.truncated) {
    console.log(
      '\n  NOTE: the holder limit was reached — statistics cover the largest retrieved page set only.',
    );
  }
  if (report.paginationError) {
    console.log(`\n  WARNING: pagination stopped early: ${report.paginationError}`);
    console.log('  Statistics above cover only the holders retrieved before the failure.');
  }
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

function parsePositiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Runs the asset holder distribution example.
 */
export async function run(params: RunParams = {}): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL ?? DEFAULT_HORIZON_URL;
  const outputJson = wantsJson(params);

  const assetCode =
    (typeof params.assetCode === 'string' && params.assetCode.trim()) ||
    process.env.ASSET_CODE?.trim() ||
    DEFAULT_ASSET_CODE;
  const assetIssuer =
    (typeof params.assetIssuer === 'string' && params.assetIssuer.trim()) ||
    process.env.ASSET_ISSUER?.trim() ||
    DEFAULT_ASSET_ISSUER;
  const maxHolders = parsePositiveInt(
    params.maxHolders ?? process.env.MAX_HOLDERS,
    DEFAULT_MAX_HOLDERS,
  );
  const topN = parsePositiveInt(params.topN ?? process.env.TOP_HOLDERS, DEFAULT_TOP_N);

  console.log('Starting Asset Holder Distribution Example...');
  console.log(`Using Horizon: ${horizonUrl}`);

  const asset = buildAsset(assetCode, assetIssuer);
  console.log(`Analysing holders of ${asset.getCode()} issued by ${asset.getIssuer()}`);
  console.log(`Holder cap: ${maxHolders} · Top holders displayed: ${topN}`);

  const server = new Horizon.Server(horizonUrl);
  const fetched = await fetchAllHolders(server, asset, maxHolders);

  const report = buildReport(fetched.holders, {
    assetCode: asset.getCode(),
    assetIssuer: asset.getIssuer(),
    horizonUrl,
    topN,
    pagesFetched: fetched.pagesFetched,
    truncated: fetched.truncated,
    paginationError: fetched.paginationError,
  });

  if (outputJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  displayReport(report);

  console.log('\n── Notes ──────────────────────────────────────────────────');
  console.log('  • This example is read-only; no ledger state was modified.');
  console.log('  • Totals are sums of trustline balances, not the issuer supply figure.');
  console.log('  • Balances committed to open offers appear as selling liabilities.');
  console.log('\nAsset holder distribution analysis completed.');
}
