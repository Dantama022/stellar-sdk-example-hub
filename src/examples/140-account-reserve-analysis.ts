/**
 * 140-account-reserve-analysis: Stellar Account Reserve and Spendable Balance Analysis
 *
 * OVERVIEW
 * --------
 * A Stellar account's total XLM balance does not represent the full amount
 * available for spending. Minimum reserve requirements, subentries, selling
 * liabilities, and sponsorship relationships all reduce the amount that can
 * be freely transferred.
 *
 * RESERVE FORMULA
 * ---------------
 * minimumReserve = (2 + subentryCount - numSponsored + numSponsoring) * baseReserve
 *
 * Where:
 *   - 2               base entries (account itself)
 *   - subentryCount   trustlines, offers, signers (above master), data entries
 *   - numSponsored    subentries whose reserve is paid by a sponsor (exempt)
 *   - numSponsoring   subentries this account is sponsoring for others (extra cost)
 *   - baseReserve     currently 0.5 XLM per entry on Testnet and Mainnet
 *
 * SPENDABLE BALANCE
 * -----------------
 * spendable = max(0, nativeBalance - minimumReserve - sellingLiabilities)
 *
 * Selling liabilities represent XLM already committed to open SDEX offers and
 * must be reserved on top of the minimum reserve.
 *
 * RECOVERABLE RESERVE
 * -------------------
 * Each subentry that the account itself sponsors can, in principle, be removed
 * to recover 1 × baseReserve. Sponsored entries can NOT be individually removed
 * by the account without the sponsor's cooperation.
 *
 * SUBENTRY TYPES
 * --------------
 *   - Trustline         one entry per non-native asset the account trusts
 *   - Open offer        one entry per resting SDEX offer
 *   - Extra signer      one entry per signer added above the master key
 *   - Data entry        one entry per manageData key-value pair
 *   - Claimable balance one entry per balance this account sponsors
 *
 * SPONSORSHIP
 * -----------
 * When another account sponsors a subentry, the sponsor's XLM covers the
 * reserve, not the account holder's. Removing a sponsorship shifts reserve
 * responsibility back to the owner.
 */

import { Horizon } from '@stellar/stellar-sdk';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const BASE_RESERVE_XLM = 0.5; // Current standard value on both Testnet and Mainnet

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export interface ReserveAnalysisResult {
  accountId: string;
  totalXlmBalance: number;
  sequenceNumber: string;
  subentryCount: number;
  numSponsored: number;
  numSponsoring: number;
  baseReserve: number;
  minimumReserve: number;
  sellingLiabilities: number;
  buyingLiabilities: number;
  estimatedSpendable: number;
  recoverableReserve: number;
  trustlineCount: number;
  offerCount: number;
  extraSignerCount: number;
  dataEntryCount: number;
  warnings: string[];
}

export interface RunParams {
  accountId?: string;
  json?: boolean;
}

// ──────────────────────────────────────────────────────────────────────────────
// Reserve calculation helpers (exported for unit testing)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Calculates the minimum XLM reserve required to keep an account open.
 *
 * The two base entries represent the account ledger object itself. Every
 * subentry beyond that costs one additional base reserve.
 *
 * Entries that are sponsored by ANOTHER account (numSponsored) do not consume
 * the owner's reserve. Entries this account sponsors for OTHERS (numSponsoring)
 * add reserve responsibility even though the subentry does not appear on this
 * account's own subentry count.
 */
export function calculateMinimumReserve(
  subentryCount: number,
  numSponsored: number,
  numSponsoring: number,
  baseReserve: number,
): number {
  const effectiveEntries = 2 + Math.max(0, subentryCount - numSponsored) + numSponsoring;
  return Number((effectiveEntries * baseReserve).toFixed(7));
}

/**
 * Calculates the amount of XLM the account can actually spend.
 *
 * Selling liabilities represent XLM already locked into open SDEX offers. That
 * amount is unavailable for transfers regardless of reserve calculations.
 */
export function calculateSpendableBalance(
  nativeBalance: number,
  minimumReserve: number,
  sellingLiabilities: number,
): number {
  return Math.max(0, Number((nativeBalance - minimumReserve - sellingLiabilities).toFixed(7)));
}

/**
 * Calculates the XLM that could be recovered by removing self-sponsored
 * subentries (i.e., entries not currently sponsored by another account).
 *
 * Only unsponsored subentries can be individually removed by the account holder.
 */
export function calculateRecoverableReserve(
  subentryCount: number,
  numSponsored: number,
  baseReserve: number,
): number {
  const removableEntries = Math.max(0, subentryCount - numSponsored);
  return Number((removableEntries * baseReserve).toFixed(7));
}

// ──────────────────────────────────────────────────────────────────────────────
// Account data parsing
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Analyses a raw Horizon AccountResponse and produces a complete reserve report.
 */
export function analyseAccountReserves(
  account: Horizon.AccountResponse,
  baseReserve: number = BASE_RESERVE_XLM,
): ReserveAnalysisResult {
  // Native balance and liabilities
  const nativeEntry = account.balances.find((b) => b.asset_type === 'native') as
    | (Horizon.HorizonApi.BalanceLine & {
        selling_liabilities?: string;
        buying_liabilities?: string;
      })
    | undefined;

  const totalXlmBalance = nativeEntry ? parseFloat(nativeEntry.balance) : 0;
  const sellingLiabilities = nativeEntry?.selling_liabilities
    ? parseFloat(nativeEntry.selling_liabilities)
    : 0;
  const buyingLiabilities = nativeEntry?.buying_liabilities
    ? parseFloat(nativeEntry.buying_liabilities)
    : 0;

  const subentryCount = account.subentry_count ?? 0;
  const numSponsored = (account as any).num_sponsored ?? 0;
  const numSponsoring = (account as any).num_sponsoring ?? 0;

  const minimumReserve = calculateMinimumReserve(
    subentryCount,
    numSponsored,
    numSponsoring,
    baseReserve,
  );

  const estimatedSpendable = calculateSpendableBalance(
    totalXlmBalance,
    minimumReserve,
    sellingLiabilities,
  );

  const recoverableReserve = calculateRecoverableReserve(subentryCount, numSponsored, baseReserve);

  // Subentry breakdown
  const trustlineCount = account.balances.filter((b) => b.asset_type !== 'native').length;
  const offerCount = Math.round(sellingLiabilities > 0 ? sellingLiabilities / 0.0000001 : 0); // best-effort; actual count not directly available from AccountResponse
  const signers = account.signers ?? [];
  const extraSignerCount = Math.max(0, signers.length - 1); // subtract master key
  const dataEntries = Object.keys(account.data_attr ?? {}).length;

  // Assemble warnings
  const warnings: string[] = [];

  if (estimatedSpendable === 0) {
    warnings.push('WARNING: This account has NO spendable XLM. Any outgoing payment will fail.');
  } else if (estimatedSpendable < 1) {
    warnings.push(
      `WARNING: Spendable balance is very low (${estimatedSpendable.toFixed(7)} XLM). ` +
        'Some operations may fail if fees push the balance below the minimum reserve.',
    );
  }

  if (numSponsored > 0) {
    warnings.push(
      `NOTE: ${numSponsored} subentries are sponsored by another account. ` +
        'If sponsorship is revoked, reserve responsibility shifts back to this account.',
    );
  }

  if (numSponsoring > 0) {
    warnings.push(
      `NOTE: This account is sponsoring ${numSponsoring} entries for other accounts, ` +
        'which increases its own minimum reserve.',
    );
  }

  return {
    accountId: account.id,
    totalXlmBalance,
    sequenceNumber: account.sequence,
    subentryCount,
    numSponsored,
    numSponsoring,
    baseReserve,
    minimumReserve,
    sellingLiabilities,
    buyingLiabilities,
    estimatedSpendable,
    recoverableReserve,
    trustlineCount,
    offerCount,
    extraSignerCount,
    dataEntryCount: dataEntries,
    warnings,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Display helpers
// ──────────────────────────────────────────────────────────────────────────────

function pad(label: string, width = 36): string {
  return label.padEnd(width);
}

function printReport(result: ReserveAnalysisResult): void {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║         Stellar Account Reserve & Balance Analysis       ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  console.log(`${pad('Account ID:')}${result.accountId}`);
  console.log(`${pad('Sequence Number:')}${result.sequenceNumber}`);

  console.log('\n── Balance ────────────────────────────────────────────────');
  console.log(`${pad('Total XLM Balance:')}${result.totalXlmBalance.toFixed(7)} XLM`);
  console.log(
    `${pad('Selling Liabilities (SDEX offers:')}${result.sellingLiabilities.toFixed(7)} XLM`,
  );
  console.log(
    `${pad('Buying Liabilities (SDEX bids):')}${result.buyingLiabilities.toFixed(7)} XLM`,
  );

  console.log('\n── Reserve Breakdown ──────────────────────────────────────');
  console.log(`${pad('Base Reserve Rate:')}${result.baseReserve} XLM per entry`);
  console.log(`${pad('Account Base Entries:')}2  → ${(2 * result.baseReserve).toFixed(1)} XLM`);
  console.log(`${pad('Total Subentries:')}${result.subentryCount}`);
  console.log(`${pad('  — Trustlines:')}${result.trustlineCount}`);
  console.log(`${pad('  — Extra Signers:')}${result.extraSignerCount}`);
  console.log(`${pad('  — Data Entries:')}${result.dataEntryCount}`);
  console.log(`${pad('Sponsored by Others (exempt):')}${result.numSponsored}`);
  console.log(`${pad('Sponsoring for Others (extra cost):')}${result.numSponsoring}`);

  console.log('\n── Calculated Reserves ────────────────────────────────────');
  console.log(`${pad('Minimum Required Reserve:')}${result.minimumReserve.toFixed(7)} XLM`);
  console.log(`${pad('Estimated Spendable XLM:')}${result.estimatedSpendable.toFixed(7)} XLM`);
  console.log(
    `${pad('Recoverable via Entry Removal:')}${result.recoverableReserve.toFixed(7)} XLM`,
  );

  if (result.warnings.length > 0) {
    console.log('\n── Warnings / Notes ───────────────────────────────────────');
    result.warnings.forEach((w) => console.log(`  ${w}`));
  }

  console.log('\n── How Reserves Work ──────────────────────────────────────');
  console.log('  • Every Stellar account must hold a minimum XLM balance (the minimum reserve).');
  console.log('  • Each subentry (trustline, offer, signer, data entry) adds 1 × base reserve.');
  console.log(
    '  • Sponsored subentries shift reserve cost to the sponsor, not the account holder.',
  );
  console.log('  • Selling liabilities lock XLM into open SDEX offers — that XLM cannot be spent.');
  console.log(
    '  • To recover locked reserve, remove eligible subentries (offers, trustlines, etc.).',
  );
  console.log(
    '  • Submitting a payment that would drop the balance below the minimum reserve fails.',
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Entry point
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Runs the account reserve analysis example.
 */
export async function run(params: RunParams = {}): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL ?? DEFAULT_HORIZON_URL;
  const outputJson =
    params.json === true || process.env.OUTPUT_JSON === 'true' || process.argv.includes('--json');

  const server = new Horizon.Server(horizonUrl);

  let accountId =
    params.accountId?.trim() || process.env.ACCOUNT_ID?.trim() || process.argv[3]?.trim();

  console.log('Starting Account Reserve Analysis Example...');
  console.log(`Using Horizon: ${horizonUrl}`);

  // Discover a recent account if none was supplied
  if (!accountId) {
    console.log('No account ID supplied — discovering a recent active account from Horizon...');
    try {
      const recentOps = await server.operations().order('desc').limit(1).call();
      if (recentOps.records.length > 0) {
        accountId =
          (recentOps.records[0] as any).source_account ?? (recentOps.records[0] as any).account;
      }
    } catch {
      // fallback below
    }
  }

  // Final fallback to a well-known Testnet account
  if (!accountId) {
    accountId = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
    console.log(`Using fallback well-known account: ${accountId}`);
  }

  console.log(`Analysing reserves for account: ${accountId}`);

  let result: ReserveAnalysisResult;

  try {
    const accountResponse = await server.loadAccount(accountId);
    result = analyseAccountReserves(accountResponse as any, BASE_RESERVE_XLM);
  } catch (error: any) {
    // Graceful fallback: demonstrate the calculation model with synthetic data
    console.log(`\nCould not load account from Horizon: ${error?.message ?? String(error)}`);
    console.log('Demonstrating the reserve calculation model with a synthetic example instead.\n');

    const syntheticSubentries = 4;
    const syntheticSponsored = 1;
    const syntheticSponsoring = 0;
    const syntheticBalance = 15.0;
    const syntheticSellingLiabilities = 0.5;

    const minReserve = calculateMinimumReserve(
      syntheticSubentries,
      syntheticSponsored,
      syntheticSponsoring,
      BASE_RESERVE_XLM,
    );

    result = {
      accountId,
      totalXlmBalance: syntheticBalance,
      sequenceNumber: '(unavailable)',
      subentryCount: syntheticSubentries,
      numSponsored: syntheticSponsored,
      numSponsoring: syntheticSponsoring,
      baseReserve: BASE_RESERVE_XLM,
      minimumReserve: minReserve,
      sellingLiabilities: syntheticSellingLiabilities,
      buyingLiabilities: 0,
      estimatedSpendable: calculateSpendableBalance(
        syntheticBalance,
        minReserve,
        syntheticSellingLiabilities,
      ),
      recoverableReserve: calculateRecoverableReserve(
        syntheticSubentries,
        syntheticSponsored,
        BASE_RESERVE_XLM,
      ),
      trustlineCount: 2,
      offerCount: 1,
      extraSignerCount: 1,
      dataEntryCount: 0,
      warnings: [
        'NOTE: This is a synthetic example — actual Horizon data was unavailable.',
        'NOTE: 1 subentry is sponsored by another account.',
      ],
    };
  }

  if (outputJson) {
    console.log('\nJSON Output:');
    console.log(JSON.stringify(result, null, 2));
  } else {
    printReport(result);
  }

  console.log('\nAccount reserve analysis completed successfully.');
}
