/**
 * 171-account-activity-profile: Stellar Account Activity Profile
 *
 * OVERVIEW
 * --------
 * Wallets, explorers, and monitoring systems usually need a single summary of
 * what an account has been doing rather than four separate Horizon responses.
 * This example collects account metadata, transaction history, operation
 * history, and payment history, then reduces them to one structured profile.
 *
 * SCOPE — DESCRIPTIVE ONLY
 * ------------------------
 * This profile is purely descriptive. It reports what the ledger records and
 * nothing more. It deliberately does NOT score, rank, or classify an account as
 * trustworthy, risky, or fraudulent, and it makes no attempt to associate an
 * account with a real-world identity. On-chain activity does not support those
 * conclusions, and presenting derived statistics as if it did would be
 * misleading.
 *
 * PARTIAL FAILURES
 * ----------------
 * The profile is assembled from four independent Horizon requests. Any one of
 * them can fail on its own (rate limiting, a retention window, a transient
 * error). Rather than aborting or silently reporting zeros — which would look
 * identical to a genuinely inactive account — each section records its own
 * status, and the profile lists which sections are incomplete.
 *
 * OBSERVED VS DERIVED
 * -------------------
 * "Observed" counts describe only the records actually retrieved, which are
 * bounded by the configured page limit and by Horizon's own history retention.
 * They are not lifetime totals for the account. Every derived figure — averages,
 * rates, groupings — is computed from that same bounded sample and is labelled
 * as derived throughout.
 *
 * This example is read-only and submits nothing to the network.
 */

import { Horizon, StrKey } from '@stellar/stellar-sdk';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const FALLBACK_ACCOUNT_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
const DEFAULT_RECORD_LIMIT = 50;
const MAX_RECORD_LIMIT = 200;
const DEFAULT_RECENT_ACTIVITY_COUNT = 5;
/** Stroops per lumen — Horizon reports transaction fees in stroops. */
const STROOPS_PER_XLM = 10_000_000;

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export interface TransactionRecord {
  id?: string;
  hash?: string;
  ledger?: number;
  ledger_attr?: number;
  created_at?: string;
  successful?: boolean;
  fee_charged?: string | number;
  operation_count?: number;
  source_account?: string;
}

export interface OperationRecord {
  id?: string;
  type?: string;
  created_at?: string;
  source_account?: string;
  transaction_successful?: boolean;
}

export interface PaymentRecord {
  id?: string;
  type?: string;
  created_at?: string;
  from?: string;
  to?: string;
  source_account?: string;
  amount?: string;
  asset_type?: string;
  asset_code?: string;
}

export interface AccountLike {
  account_id?: string;
  id?: string;
  sequence?: string;
  subentry_count?: number;
  last_modified_ledger?: number;
  balances?: Array<{
    asset_type?: string;
    asset_code?: string;
    balance?: string;
  }>;
}

export interface SectionStatus {
  ok: boolean;
  error: string | null;
}

export interface TransactionStatistics {
  total: number;
  successful: number;
  failed: number;
  successRate: number;
  totalFeeStroops: number;
  totalFeeXlm: number;
  averageFeeStroops: number;
  operationCountFromTransactions: number;
  firstObservedAt: string | null;
  lastObservedAt: string | null;
  activeLedgers: number;
}

export interface OperationStatistics {
  total: number;
  byType: Record<string, number>;
  mostFrequentTypes: Array<{ type: string; count: number }>;
}

export interface PaymentStatistics {
  total: number;
  incoming: number;
  outgoing: number;
  selfPayments: number;
  byAsset: Record<string, number>;
}

export interface BalanceSummary {
  balanceCount: number;
  nativeBalance: string | null;
  trustlineCount: number;
  assets: string[];
}

export interface ActivityProfile {
  accountId: string;
  horizonUrl: string;
  recordLimit: number;
  observedAt: string;
  account: {
    sequence: string | null;
    subentryCount: number;
    lastModifiedLedger: number | null;
  };
  balances: BalanceSummary;
  transactions: TransactionStatistics;
  operations: OperationStatistics;
  payments: PaymentStatistics;
  recentActivity: Array<{ at: string; type: string; detail: string }>;
  derived: {
    operationsPerTransaction: number;
    observedWindowHours: number | null;
    transactionsPerDay: number | null;
  };
  sections: {
    account: SectionStatus;
    transactions: SectionStatus;
    operations: SectionStatus;
    payments: SectionStatus;
  };
  incompleteSections: string[];
}

export interface RunParams {
  accountId?: string;
  limit?: string | number;
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

/** Clamps a requested page size into Horizon's accepted 1–200 range. */
export function normalizeLimit(value: unknown, fallback = DEFAULT_RECORD_LIMIT): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, MAX_RECORD_LIMIT);
}

function okStatus(): SectionStatus {
  return { ok: true, error: null };
}

function errorStatus(error: unknown): SectionStatus {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

// ──────────────────────────────────────────────────────────────────────────────
// Statistics
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Reduces retrieved transactions to counts, fee totals, and an observed window.
 *
 * Fees are reported by Horizon in stroops as `fee_charged` — the amount actually
 * taken, which for a failed transaction is still non-zero. Both the stroop total
 * and its XLM equivalent are reported so callers do not have to remember the
 * conversion.
 */
export function summarizeTransactions(records: TransactionRecord[]): TransactionStatistics {
  const successful = records.filter((record) => record.successful === true).length;
  // Horizon marks failed transactions explicitly; anything not marked successful
  // and included in the account's history is counted as failed.
  const failed = records.length - successful;
  const totalFeeStroops = records.reduce((sum, record) => {
    const fee = Number(record.fee_charged);
    return sum + (Number.isFinite(fee) ? fee : 0);
  }, 0);

  const timestamps = records
    .map((record) => record.created_at)
    .filter((value): value is string => typeof value === 'string')
    .sort();

  const ledgers = new Set(
    records
      .map((record) => record.ledger ?? record.ledger_attr)
      .filter((value): value is number => typeof value === 'number'),
  );

  return {
    total: records.length,
    successful,
    failed,
    successRate: records.length === 0 ? 0 : (successful / records.length) * 100,
    totalFeeStroops,
    totalFeeXlm: totalFeeStroops / STROOPS_PER_XLM,
    averageFeeStroops: records.length === 0 ? 0 : totalFeeStroops / records.length,
    operationCountFromTransactions: records.reduce(
      (sum, record) => sum + (record.operation_count ?? 0),
      0,
    ),
    firstObservedAt: timestamps[0] ?? null,
    lastObservedAt: timestamps[timestamps.length - 1] ?? null,
    activeLedgers: ledgers.size,
  };
}

/** Groups operations by type and identifies the most frequent ones. */
export function summarizeOperations(records: OperationRecord[]): OperationStatistics {
  const byType: Record<string, number> = {};
  for (const record of records) {
    const type = record.type ?? 'unknown';
    byType[type] = (byType[type] ?? 0) + 1;
  }

  const mostFrequentTypes = Object.entries(byType)
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type))
    .slice(0, 5);

  return { total: records.length, byType, mostFrequentTypes };
}

/**
 * Splits payments into incoming and outgoing relative to `accountId`.
 *
 * `create_account` operations use `funder`/`account` rather than `from`/`to`,
 * so the source account is used as the sender fallback. A payment where the
 * account is both sender and receiver is counted once in each direction and
 * also tracked separately, so the two never silently double-count.
 */
export function summarizePayments(records: PaymentRecord[], accountId: string): PaymentStatistics {
  let incoming = 0;
  let outgoing = 0;
  let selfPayments = 0;
  const byAsset: Record<string, number> = {};

  for (const record of records) {
    const from = record.from ?? record.source_account;
    const to = record.to;
    const isIncoming = to === accountId;
    const isOutgoing = from === accountId;

    if (isIncoming) incoming += 1;
    if (isOutgoing) outgoing += 1;
    if (isIncoming && isOutgoing) selfPayments += 1;

    const asset = record.asset_type === 'native' ? 'XLM' : (record.asset_code ?? 'unknown');
    byAsset[asset] = (byAsset[asset] ?? 0) + 1;
  }

  return { total: records.length, incoming, outgoing, selfPayments, byAsset };
}

/** Summarizes the account's current balances and trustlines. */
export function summarizeBalances(account: AccountLike): BalanceSummary {
  const balances = account.balances ?? [];
  const native = balances.find((balance) => balance.asset_type === 'native');
  const trustlines = balances.filter((balance) => balance.asset_type !== 'native');

  return {
    balanceCount: balances.length,
    nativeBalance: native?.balance ?? null,
    trustlineCount: trustlines.length,
    assets: trustlines.map((balance) => balance.asset_code ?? 'unknown'),
  };
}

/** Most recent operations, newest first, rendered as short activity lines. */
export function buildRecentActivity(
  operations: OperationRecord[],
  count = DEFAULT_RECENT_ACTIVITY_COUNT,
): Array<{ at: string; type: string; detail: string }> {
  return [...operations]
    .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
    .slice(0, count)
    .map((operation) => ({
      at: operation.created_at ?? 'unknown',
      type: operation.type ?? 'unknown',
      detail:
        `source=${operation.source_account ?? 'unknown'}` +
        (operation.transaction_successful === false ? ' (transaction failed)' : ''),
    }));
}

/**
 * Elapsed hours between the first and last observed transaction.
 *
 * Returns `null` when fewer than two timestamps are available, because a single
 * record gives a zero-length window and any rate derived from it would be
 * meaningless rather than merely imprecise.
 */
export function observedWindowHours(stats: TransactionStatistics): number | null {
  if (!stats.firstObservedAt || !stats.lastObservedAt) return null;
  const first = Date.parse(stats.firstObservedAt);
  const last = Date.parse(stats.lastObservedAt);
  if (!Number.isFinite(first) || !Number.isFinite(last) || last <= first) return null;
  return (last - first) / (1000 * 60 * 60);
}

/** Builds the assembled profile from each section's retrieved records. */
export function buildProfile(input: {
  accountId: string;
  horizonUrl: string;
  recordLimit: number;
  account: AccountLike | null;
  transactions: TransactionRecord[];
  operations: OperationRecord[];
  payments: PaymentRecord[];
  sections: ActivityProfile['sections'];
}): ActivityProfile {
  const transactionStats = summarizeTransactions(input.transactions);
  const operationStats = summarizeOperations(input.operations);
  const paymentStats = summarizePayments(input.payments, input.accountId);
  const windowHours = observedWindowHours(transactionStats);

  const incompleteSections = Object.entries(input.sections)
    .filter(([, status]) => !status.ok)
    .map(([name]) => name);

  return {
    accountId: input.accountId,
    horizonUrl: input.horizonUrl,
    recordLimit: input.recordLimit,
    observedAt: new Date().toISOString(),
    account: {
      sequence: input.account?.sequence ?? null,
      subentryCount: input.account?.subentry_count ?? 0,
      lastModifiedLedger: input.account?.last_modified_ledger ?? null,
    },
    balances: input.account
      ? summarizeBalances(input.account)
      : { balanceCount: 0, nativeBalance: null, trustlineCount: 0, assets: [] },
    transactions: transactionStats,
    operations: operationStats,
    payments: paymentStats,
    recentActivity: buildRecentActivity(input.operations),
    derived: {
      operationsPerTransaction:
        transactionStats.total === 0 ? 0 : operationStats.total / transactionStats.total,
      observedWindowHours: windowHours,
      transactionsPerDay:
        windowHours === null || windowHours === 0
          ? null
          : transactionStats.total / (windowHours / 24),
    },
    sections: input.sections,
    incompleteSections,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Display
// ──────────────────────────────────────────────────────────────────────────────

function displayProfile(profile: ActivityProfile): void {
  console.log('\n=== Account Activity Profile ===');
  console.log(`  Account:      ${profile.accountId}`);
  console.log(`  Horizon:      ${profile.horizonUrl}`);
  console.log(`  Record limit: ${profile.recordLimit} per resource`);
  console.log(`  Observed at:  ${profile.observedAt}`);

  console.log('\n── Account (observed) ─────────────────────────────────────');
  console.log(`  Sequence:              ${profile.account.sequence ?? 'unknown'}`);
  console.log(`  Subentries:            ${profile.account.subentryCount}`);
  console.log(`  Last modified ledger:  ${profile.account.lastModifiedLedger ?? 'unknown'}`);
  console.log(`  Balance lines:         ${profile.balances.balanceCount}`);
  console.log(`  Native XLM balance:    ${profile.balances.nativeBalance ?? 'none'}`);
  console.log(`  Trustlines:            ${profile.balances.trustlineCount}`);
  if (profile.balances.assets.length > 0) {
    console.log(`  Assets held:           ${profile.balances.assets.join(', ')}`);
  }

  const tx = profile.transactions;
  console.log('\n── Transactions (observed) ────────────────────────────────');
  console.log(`  Retrieved:    ${tx.total}`);
  console.log(`  Successful:   ${tx.successful}`);
  console.log(`  Failed:       ${tx.failed}`);
  console.log(`  Success rate: ${tx.successRate.toFixed(2)}% (derived)`);
  console.log(`  Active ledgers: ${tx.activeLedgers}`);
  console.log(`  First observed: ${tx.firstObservedAt ?? 'n/a'}`);
  console.log(`  Last observed:  ${tx.lastObservedAt ?? 'n/a'}`);

  console.log('\n── Fees (observed) ────────────────────────────────────────');
  console.log(`  Total fees charged: ${tx.totalFeeStroops} stroops`);
  console.log(`  Total fees charged: ${tx.totalFeeXlm.toFixed(7)} XLM (derived)`);
  console.log(`  Average fee:        ${tx.averageFeeStroops.toFixed(2)} stroops (derived)`);

  console.log('\n── Operations (observed) ──────────────────────────────────');
  console.log(`  Retrieved: ${profile.operations.total}`);
  console.log(
    `  Operations per transaction: ${profile.derived.operationsPerTransaction.toFixed(2)} (derived)`,
  );
  if (profile.operations.mostFrequentTypes.length === 0) {
    console.log('  No operations retrieved.');
  } else {
    console.log('  Most frequent types:');
    profile.operations.mostFrequentTypes.forEach((entry) =>
      console.log(`    ${entry.type}: ${entry.count}`),
    );
  }

  console.log('\n── Payments (observed) ────────────────────────────────────');
  console.log(`  Retrieved: ${profile.payments.total}`);
  console.log(`  Incoming:  ${profile.payments.incoming}`);
  console.log(`  Outgoing:  ${profile.payments.outgoing}`);
  if (profile.payments.selfPayments > 0) {
    console.log(`  Self-payments (counted in both directions): ${profile.payments.selfPayments}`);
  }
  const assetEntries = Object.entries(profile.payments.byAsset);
  if (assetEntries.length > 0) {
    console.log('  By asset:');
    assetEntries.forEach(([asset, count]) => console.log(`    ${asset}: ${count}`));
  }

  console.log('\n── Activity Frequency (derived) ───────────────────────────');
  console.log(
    `  Observed window: ${profile.derived.observedWindowHours === null ? 'n/a (need 2+ dated transactions)' : `${profile.derived.observedWindowHours.toFixed(2)} hours`}`,
  );
  console.log(
    `  Transactions/day: ${profile.derived.transactionsPerDay === null ? 'n/a' : profile.derived.transactionsPerDay.toFixed(2)}`,
  );

  console.log('\n── Recent Activity ────────────────────────────────────────');
  if (profile.recentActivity.length === 0) {
    console.log('  No recent operations found for this account.');
  } else {
    profile.recentActivity.forEach((entry) =>
      console.log(`  ${entry.at}  ${entry.type}  ${entry.detail}`),
    );
  }

  if (profile.incompleteSections.length > 0) {
    console.log('\n── Incomplete Sections ────────────────────────────────────');
    console.log(
      `  The following Horizon requests failed: ${profile.incompleteSections.join(', ')}.`,
    );
    console.log('  Statistics above exclude those sections and are therefore partial.');
    for (const [name, status] of Object.entries(profile.sections)) {
      if (!status.ok) console.log(`    ${name}: ${status.error}`);
    }
  }

  console.log('\n── Scope ──────────────────────────────────────────────────');
  console.log('  • Counts describe retrieved records only, not lifetime account totals.');
  console.log('  • Horizon history retention bounds how far back records go.');
  console.log('  • This profile is descriptive; it does not assess or classify the account.');
  console.log('  • No ledger state was modified.');
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
 * Runs the account activity profile example.
 */
export async function run(params: RunParams = {}): Promise<void> {
  const horizonUrl = process.env.HORIZON_URL ?? DEFAULT_HORIZON_URL;
  const outputJson = wantsJson(params);
  const recordLimit = normalizeLimit(params.limit ?? process.env.RECORD_LIMIT);

  const accountId =
    (typeof params.accountId === 'string' && params.accountId.trim()) ||
    process.env.ACCOUNT_ID?.trim() ||
    FALLBACK_ACCOUNT_ID;

  console.log('Starting Account Activity Profile Example...');
  console.log(`Using Horizon: ${horizonUrl}`);

  if (!isValidAccountId(accountId)) {
    throw new Error(
      `Invalid account ID "${accountId}": expected a 56-character G… ed25519 public key.`,
    );
  }

  console.log(`Profiling account: ${accountId}`);
  console.log(`Retrieving up to ${recordLimit} records per resource...`);

  const server = new Horizon.Server(horizonUrl);
  const sections: ActivityProfile['sections'] = {
    account: okStatus(),
    transactions: okStatus(),
    operations: okStatus(),
    payments: okStatus(),
  };

  let account: AccountLike | null = null;
  try {
    account = (await server.loadAccount(accountId)) as unknown as AccountLike;
  } catch (error: unknown) {
    sections.account = errorStatus(error);
  }

  // The account itself must exist for the rest of the profile to mean anything;
  // the history sections are optional and degrade independently below.
  if (!account) {
    throw new Error(
      `Could not load account ${accountId} from ${horizonUrl}: ${sections.account.error}. ` +
        'Verify the account exists on this network and has been funded.',
    );
  }

  let transactions: TransactionRecord[] = [];
  try {
    const page = await server
      .transactions()
      .forAccount(accountId)
      .includeFailed(true)
      .order('desc')
      .limit(recordLimit)
      .call();
    transactions = page.records as unknown as TransactionRecord[];
  } catch (error: unknown) {
    sections.transactions = errorStatus(error);
  }

  let operations: OperationRecord[] = [];
  try {
    const page = await server
      .operations()
      .forAccount(accountId)
      .includeFailed(true)
      .order('desc')
      .limit(recordLimit)
      .call();
    operations = page.records as unknown as OperationRecord[];
  } catch (error: unknown) {
    sections.operations = errorStatus(error);
  }

  let payments: PaymentRecord[] = [];
  try {
    const page = await server
      .payments()
      .forAccount(accountId)
      .order('desc')
      .limit(recordLimit)
      .call();
    payments = page.records as unknown as PaymentRecord[];
  } catch (error: unknown) {
    sections.payments = errorStatus(error);
  }

  const profile = buildProfile({
    accountId,
    horizonUrl,
    recordLimit,
    account,
    transactions,
    operations,
    payments,
    sections,
  });

  if (outputJson) {
    console.log(JSON.stringify(profile, null, 2));
    return;
  }

  displayProfile(profile);
  console.log('\nAccount activity profile completed.');
}
