/**
 * Reserve and residual balance analysis (ISSUE-378).
 *
 * Every Stellar account has to keep a minimum balance that covers the base
 * reserve of the account itself plus the base reserve of every entry it
 * owns. The numbers below are computed from the ledger state that was
 * inspected, and every assumption is stated explicitly because the balance
 * can change between the audit and the submission of a merge transaction.
 */

import type { AccountSnapshot, ReserveAnalysis } from './types';

/** The base reserve of a single ledger entry, in XLM. */
export const BASE_RESERVE_XLM = 0.5;

/** The assumed transaction fee of a merge transaction, in XLM. */
export const DEFAULT_MERGE_FEE_XLM = 0.00001;

/** Options of the reserve analysis. */
export interface ReserveOptions {
  /** The base reserve per entry, in XLM. */
  baseReserve?: number;
  /** The estimated fee of the merge transaction, in XLM. */
  fee?: number;
  /** Number of sponsored entries whose reserve is paid by a sponsor. */
  sponsoredEntryCount?: number;
}

/**
 * Calculates the minimum balance an account has to keep.
 *
 * The account itself always costs one base reserve. Every entry it owns adds
 * another one. Entries whose reserve is paid by a sponsor are not counted.
 */
export function calculateMinimumBalance(
  subentryCount: number,
  baseReserve: number = BASE_RESERVE_XLM,
  sponsoredEntryCount = 0,
): number {
  const ownedEntries = Math.max(0, subentryCount - Math.max(0, sponsoredEntryCount));
  return round(baseReserve * (1 + ownedEntries));
}

/** Calculates the balance that is available above the minimum balance. */
export function calculateAvailableBalance(balance: number, minimumBalance: number): number {
  return round(balance - minimumBalance);
}

/**
 * Estimates how much the destination account receives from a merge.
 *
 * The source account is removed by the merge, so its base reserve
 * requirement disappears together with it and the whole remaining balance
 * ends up on the destination account. The transaction fee is paid by the
 * source account before the transfer.
 */
export function calculateDestinationIncrease(
  balance: number,
  fee: number = DEFAULT_MERGE_FEE_XLM,
  baseReserve: number = BASE_RESERVE_XLM,
): number {
  const afterFee = Math.max(0, balance - fee);
  const released = releasedBaseReserve(baseReserve);
  return round(afterFee + released);
}

/** The base reserve that is released when the account is merged away. */
export function releasedBaseReserve(baseReserve: number = BASE_RESERVE_XLM): number {
  return round(baseReserve);
}

/** Rounds a number to seven decimal places (one stroop). */
function round(value: number): number {
  return Math.round(value * 1e7) / 1e7;
}

/**
 * Builds the reserve and balance section of the audit report.
 */
export function analyzeReserves(
  snapshot: AccountSnapshot,
  options: ReserveOptions = {},
): ReserveAnalysis {
  const baseReserve = options.baseReserve ?? BASE_RESERVE_XLM;
  const fee = options.fee ?? DEFAULT_MERGE_FEE_XLM;
  const sponsoredEntryCount = options.sponsoredEntryCount ?? 0;

  const balance = Number(snapshot.nativeBalance);
  const minimumBalance = calculateMinimumBalance(
    snapshot.subentryCount,
    baseReserve,
    sponsoredEntryCount,
  );
  const availableBalance = calculateAvailableBalance(balance, minimumBalance);

  const assumptions = [
    `The base reserve of ${baseReserve} XLM per ledger entry is used.`,
    `The balance of ${balance} XLM was observed at audit time and may change before a ` +
      'merge transaction is submitted.',
    `The estimated fee of ${fee} XLM is subtracted from the balance before the transfer.`,
    'The source account is removed by the merge, so the base reserve of the account ' +
      'itself is released to the destination account.',
    'Fees, sponsorship changes and other ledger changes between the audit and the ' +
      'submission of the transaction are not included.',
  ];

  if (sponsoredEntryCount > 0) {
    assumptions.push(
      `${sponsoredEntryCount} sponsored entr(y|ies) are excluded from the reserve ` +
        'requirement because their reserve is paid by a sponsor.',
    );
  }

  return {
    baseReserve: String(baseReserve),
    subentryCount: snapshot.subentryCount,
    sponsoredEntryCount,
    minimumBalance: String(minimumBalance),
    balance: String(balance),
    availableBalance: String(availableBalance),
    releasedBaseReserve: String(releasedBaseReserve(baseReserve)),
    projectedDestinationIncrease: String(calculateDestinationIncrease(balance, fee, baseReserve)),
    estimatedFee: String(fee),
    assumptions,
  };
}
