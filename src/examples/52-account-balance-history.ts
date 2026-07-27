import { Horizon } from '@stellar/stellar-sdk';

/**
 * Example 52: Account Balance History
 *
 * Wallets and explorers often need to show how an account's XLM balance changed
 * over time. Horizon does not expose a ready-made "balance history" endpoint.
 * Instead, applications reconstruct balance changes from effects — the ledger
 * state transitions produced by successful operations.
 *
 * Relevant effect types for native XLM:
 *   - account_credited  — balance increased (payment received, claim, etc.)
 *   - account_debited   — balance decreased (payment sent, fees, etc.)
 *   - account_created   — starting balance when the account was funded
 *
 * This example is educational, not a production ledger. Reconstructing balances
 * from a limited window has important caveats (documented in the report):
 * effects outside the window are invisible, failed transactions produce no
 * effects, and starting from "current balance − sum(window)" only approximates
 * history within that window.
 */

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;

/** Effect types that change an account's native XLM balance. */
export const BALANCE_CHANGING_EFFECT_TYPES = new Set([
  'account_credited',
  'account_debited',
  'account_created',
]);

export interface BalanceHistoryParams {
  accountId?: string;
  limit?: number | string;
  horizonUrl?: string;
}

export interface RawBalanceEffect {
  id?: string;
  type: string;
  account?: string;
  amount?: string;
  starting_balance?: string;
  created_at?: string;
  paging_token?: string;
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
  _links?: {
    operation?: { href?: string };
    succeeds?: { href?: string };
    precedes?: { href?: string };
  };
}

export interface BalanceChange {
  effectId: string;
  type: string;
  /** Signed XLM delta: positive for credits, negative for debits. */
  deltaXlm: number;
  /** Absolute amount from the effect (always positive). */
  amountXlm: number;
  createdAt: string;
  asset: string;
  operationId?: string;
  transactionHash?: string;
  ledger?: number;
  /** Running balance after applying this change (when reconstructable). */
  balanceAfter?: number;
}

export interface BalanceHistoryReport {
  accountId: string;
  currentBalanceXlm: number;
  changes: BalanceChange[];
  windowLimit: number;
  reconstructed: boolean;
}

/**
 * Clamps a requested result limit into Horizon's accepted range.
 */
export function normalizeLimit(value?: number | string): number {
  const parsed = typeof value === 'string' ? parseInt(value.trim(), 10) : value;

  if (parsed === undefined || parsed === null || Number.isNaN(parsed)) {
    return DEFAULT_LIMIT;
  }

  return Math.min(Math.max(Math.trunc(parsed), 1), MAX_LIMIT);
}

/**
 * Returns true when an effect changes native XLM balance for the account.
 */
export function isNativeBalanceChangingEffect(effect: RawBalanceEffect): boolean {
  if (!BALANCE_CHANGING_EFFECT_TYPES.has(effect.type)) {
    return false;
  }

  // account_created always concerns native XLM starting balance.
  if (effect.type === 'account_created') {
    return true;
  }

  // Credits/debits may be for issued assets; keep only native.
  return !effect.asset_type || effect.asset_type === 'native';
}

/**
 * Extracts an operation ID from a Horizon effect `_links.operation.href`.
 */
export function extractOperationId(effect: RawBalanceEffect): string | undefined {
  const href = effect._links?.operation?.href;
  if (!href) {
    return undefined;
  }

  const parts = href.split('?')[0].split('/');
  const id = parts[parts.length - 1];
  return id || undefined;
}

/**
 * Converts a Horizon effect into a signed balance change.
 */
export function parseBalanceEffect(effect: RawBalanceEffect): BalanceChange | null {
  if (!isNativeBalanceChangingEffect(effect)) {
    return null;
  }

  let amountXlm = 0;
  let deltaXlm = 0;

  if (effect.type === 'account_created') {
    amountXlm = parseFloat(effect.starting_balance ?? effect.amount ?? '0') || 0;
    deltaXlm = amountXlm;
  } else if (effect.type === 'account_credited') {
    amountXlm = parseFloat(effect.amount ?? '0') || 0;
    deltaXlm = amountXlm;
  } else if (effect.type === 'account_debited') {
    amountXlm = parseFloat(effect.amount ?? '0') || 0;
    deltaXlm = -amountXlm;
  }

  return {
    effectId: effect.id ?? effect.paging_token ?? '',
    type: effect.type,
    deltaXlm,
    amountXlm,
    createdAt: effect.created_at ?? '',
    asset: 'XLM (native)',
    operationId: extractOperationId(effect),
  };
}

/**
 * Orders balance changes oldest → newest for chronological display.
 *
 * Horizon effects are typically returned newest-first; reverse for history.
 */
export function sortChronologically(changes: BalanceChange[]): BalanceChange[] {
  return [...changes].sort((a, b) => {
    if (a.createdAt && b.createdAt && a.createdAt !== b.createdAt) {
      return a.createdAt.localeCompare(b.createdAt);
    }
    return a.effectId.localeCompare(b.effectId);
  });
}

/**
 * Walks chronological changes and attaches a running balance after each one.
 *
 * Starting from `currentBalance`, we walk newest→oldest to find the balance
 * before the window, then walk oldest→newest to fill `balanceAfter`.
 */
export function attachRunningBalances(
  chronological: BalanceChange[],
  currentBalanceXlm: number,
): BalanceChange[] {
  const windowDelta = chronological.reduce((sum, change) => sum + change.deltaXlm, 0);
  let running = currentBalanceXlm - windowDelta;

  return chronological.map((change) => {
    running += change.deltaXlm;
    return {
      ...change,
      balanceAfter: Number(running.toFixed(7)),
    };
  });
}

/**
 * Formats the balance history report for console output.
 */
export function formatBalanceHistoryReport(report: BalanceHistoryReport): string {
  const lines: string[] = [];

  lines.push('=== Stellar Account Balance History ===');
  lines.push(`Account ID:         ${report.accountId}`);
  lines.push(`Current XLM Balance: ${report.currentBalanceXlm.toFixed(7)} XLM`);
  lines.push(
    `History Window:     last ${report.windowLimit} effects (filtered to native balance changes)`,
  );
  lines.push(`Changes Found:      ${report.changes.length}`);

  if (report.changes.length === 0) {
    lines.push('');
    lines.push('No native XLM balance-changing effects were found in this window.');
    lines.push('This is normal for accounts with little recent activity, or when the');
    lines.push('retrieved effects only involve issued assets / non-balance events.');
    return lines.join('\n');
  }

  lines.push('');
  lines.push('Chronological Balance Changes (oldest → newest):');

  report.changes.forEach((change, index) => {
    const sign = change.deltaXlm >= 0 ? '+' : '';
    lines.push('');
    lines.push(`  [${index + 1}] ${change.createdAt || 'unknown time'}`);
    lines.push(`      Effect:        ${change.type}`);
    lines.push(`      Delta:         ${sign}${change.deltaXlm.toFixed(7)} XLM`);
    if (change.balanceAfter !== undefined) {
      lines.push(`      Balance After: ${change.balanceAfter.toFixed(7)} XLM`);
    }
    if (change.transactionHash) {
      lines.push(`      Tx Hash:       ${change.transactionHash}`);
    }
    if (change.ledger !== undefined) {
      lines.push(`      Ledger:        ${change.ledger}`);
    }
    if (change.operationId) {
      lines.push(`      Operation ID:  ${change.operationId}`);
    }
    lines.push(`      Effect ID:     ${change.effectId}`);
  });

  lines.push('');
  lines.push('How this history was derived:');
  lines.push('  1. Load the account to read its current native balance.');
  lines.push('  2. Fetch recent Horizon effects for the account.');
  lines.push('  3. Keep only native account_credited / account_debited / account_created.');
  lines.push('  4. Sort oldest→newest and reconstruct running balances from the window.');
  lines.push('');
  lines.push('Limitations of a limited history window:');
  lines.push('  - Effects outside the window are invisible; older balance is inferred.');
  lines.push('  - Failed transactions produce no effects and do not appear here.');
  lines.push('  - This is not a full double-entry ledger — widen the limit for more history.');

  return lines.join('\n');
}

/**
 * Resolves transaction hash and ledger for an operation, best-effort.
 */
export async function resolveOperationRefs(
  server: Horizon.Server,
  operationId: string,
): Promise<{ transactionHash?: string; ledger?: number }> {
  if (!operationId) {
    return {};
  }

  try {
    const operation = await server.operations().operation(operationId).call();
    const record = operation as { transaction_hash?: string; ledger?: number };
    return {
      transactionHash: record.transaction_hash,
      ledger: record.ledger,
    };
  } catch {
    return {};
  }
}

/**
 * Runs the account balance history example.
 */
export async function run(params: BalanceHistoryParams = {}): Promise<void> {
  const horizonUrl = params.horizonUrl || process.env.HORIZON_URL || DEFAULT_HORIZON_URL;
  const server = new Horizon.Server(horizonUrl);
  const limit = normalizeLimit(params.limit ?? process.env.HISTORY_LIMIT ?? process.argv[4]);

  let accountId =
    params.accountId?.trim() || process.env.ACCOUNT_ID?.trim() || process.argv[3]?.trim();

  console.log('Starting Account Balance History Example...');
  console.log(`Using Horizon: ${horizonUrl}`);
  console.log(
    'Balance history is reconstructed from native XLM effects, not a dedicated endpoint.',
  );

  if (!accountId) {
    console.log('No account ID supplied. Fetching a recently active account from Horizon...');
    try {
      const recentOps = await server.operations().order('desc').limit(1).call();
      if (recentOps.records.length > 0) {
        accountId = recentOps.records[0].source_account;
      }
    } catch {
      // Falls through.
    }
  }

  if (!accountId) {
    accountId = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
  }

  console.log(`Inspecting balance history for: ${accountId}`);
  console.log(`Effect window limit: ${limit}`);

  let currentBalanceXlm = 0;
  try {
    const account = await server.loadAccount(accountId);
    const native = account.balances.find((b) => b.asset_type === 'native');
    currentBalanceXlm = native ? parseFloat(native.balance) : 0;
  } catch (error: any) {
    const status = error?.response?.status;
    if (status === 404) {
      console.log(`Account ${accountId} does not exist on this network.`);
      console.log(
        '\n' +
          formatBalanceHistoryReport({
            accountId,
            currentBalanceXlm: 0,
            changes: [],
            windowLimit: limit,
            reconstructed: false,
          }),
      );
      console.log('\nAccount balance history completed (empty account handled).');
      return;
    }
    console.log(`Could not load account ${accountId}: ${error?.message || error}`);
    return;
  }

  let effects: RawBalanceEffect[] = [];
  try {
    const page = await server.effects().forAccount(accountId).order('desc').limit(limit).call();
    effects = page.records as unknown as RawBalanceEffect[];
  } catch (error: any) {
    console.log(`Could not retrieve effects: ${error?.message || error}`);
    return;
  }

  const parsed = effects
    .map(parseBalanceEffect)
    .filter((change): change is BalanceChange => change !== null);

  const chronological = sortChronologically(parsed);
  const withBalances = attachRunningBalances(chronological, currentBalanceXlm);

  // Resolve tx/ledger refs for the first few changes (extra Horizon calls).
  for (const change of withBalances.slice(-5)) {
    if (!change.operationId) {
      continue;
    }
    const refs = await resolveOperationRefs(server, change.operationId);
    change.transactionHash = refs.transactionHash;
    change.ledger = refs.ledger;
  }

  const report: BalanceHistoryReport = {
    accountId,
    currentBalanceXlm,
    changes: withBalances,
    windowLimit: limit,
    reconstructed: withBalances.length > 0,
  };

  console.log('\n' + formatBalanceHistoryReport(report));
  console.log('\nAccount balance history example completed successfully.');
}
