/** #575: account balance changes from known Horizon operations; fees separate. */
import {
  Fetcher, Network, account, amountToUnits, assetId, collect,
  unitsToAmount, validAccount,
} from '../_shared/horizon-readonly';
import { ActivityOperation, classifyOperation, Movement } from './operation-classification';

export interface TxRecord {
  hash: string; source_account?: string; fee_account?: string; fee_charged?: string | number;
  successful?: boolean; ledger?: number; created_at?: string;
  /** Fee-bump status must be established from transaction envelope by the caller. */
  fee_bump_transaction?: unknown; // Horizon provides this for outer fee-bump transactions.
}
export interface AnalysisRange { fromLedger?: number; toLedger?: number; maxPages?: number }
export function validateRange(range: AnalysisRange) {
  if (range.fromLedger !== undefined && (!Number.isSafeInteger(range.fromLedger) || range.fromLedger < 1)) throw new Error('Invalid fromLedger');
  if (range.toLedger !== undefined && (!Number.isSafeInteger(range.toLedger) || range.toLedger < 1)) throw new Error('Invalid toLedger');
  if (range.fromLedger !== undefined && range.toLedger !== undefined && range.fromLedger > range.toLedger) throw new Error('Ledger range is reversed');
}
export function attributeMovements(
  accountId: string, operations: ActivityOperation[], transactions: TxRecord[], range: AnalysisRange = {},
) {
  validateRange(range);
  const txByHash = new Map(transactions.map((t) => [t.hash, t]));
  const seen = new Set<string>();
  const movements: Movement[] = [];
  const warnings: string[] = [];
  const opaque: Array<{ hash: string; operationId: string; type: string; explanation: string }> = [];
  const totals = new Map<string, { incoming: bigint; outgoing: bigint }>();
  const include = (ledger?: number) =>
    (range.fromLedger === undefined || (ledger !== undefined && ledger >= range.fromLedger)) &&
    (range.toLedger === undefined || (ledger !== undefined && ledger <= range.toLedger));
  for (const op of operations) {
    if (!include(op.ledger)) continue;
    if (seen.has(op.id)) { warnings.push(`Duplicate operation record ${op.id}`); continue; }
    seen.add(op.id);
    const tx = txByHash.get(op.transaction_hash);
    if (op.transaction_successful === false || tx?.successful === false) continue;
    if (!tx) warnings.push(`Missing transaction metadata for operation ${op.id}`);
    const interpreted = classifyOperation(op, accountId);
    movements.push(...interpreted.movements);
    for (const explanation of interpreted.notes) opaque.push({ hash: op.transaction_hash, operationId: op.id, type: op.type, explanation });
  }
  for (const m of movements) {
    const tally = totals.get(m.asset) ?? { incoming: 0n, outgoing: 0n };
    tally[m.direction] += amountToUnits(m.amount);
    totals.set(m.asset, tally);
  }
  let fees = 0n;
  const feeHashes = new Set<string>();
  for (const t of transactions) {
    if (!include(t.ledger) || feeHashes.has(t.hash)) continue; // Failed transactions can still pay fees.
    feeHashes.add(t.hash);
    // The inner source of a fee bump is not necessarily the fee payer.
    const isFeeBump = t.fee_bump_transaction !== undefined;
    if (isFeeBump && !t.fee_account) { warnings.push(`Fee-bump fee payer unknown: ${t.hash}`); continue; }
    const feeAccount = t.fee_account ?? (isFeeBump ? undefined : t.source_account);
    if (feeAccount !== accountId) continue;
    if (t.fee_charged === undefined || !/^\d+$/.test(String(t.fee_charged))) {
      warnings.push(`Missing or invalid fee for ${t.hash}`); continue;
    }
    fees += BigInt(t.fee_charged);
  }
  const byAsset = Array.from(totals, ([asset, { incoming, outgoing }]) => ({
    asset, incoming: unitsToAmount(incoming), outgoing: unitsToAmount(outgoing), net: unitsToAmount(incoming - outgoing),
  }));
  if (!operations.length) warnings.push('No operation history supplied; no historical balances can be reconstructed.');
  return {
    accountId, analysedOperations: seen.size, byAsset, transactionFeesXlm: unitsToAmount(fees),
    movements, opaqueOperations: opaque, warnings,
    limitations: 'These are identified movements, not a historical balance proof. Trades, claimables, merges, reserve changes, fee bumps and excluded history can require effects or ledger entry snapshots.',
  };
}
export async function analyzeAccountBalances(
  accountId: string, network: Network, range: AnalysisRange = {}, fetcher: Fetcher = fetch,
) {
  validAccount(accountId);
  validateRange(range);
  const acc = await account(accountId, network, fetcher);
  const max = range.maxPages ?? 5;
  const [ops, txs] = await Promise.all([
    collect<ActivityOperation>(network, `/accounts/${accountId}/operations?limit=200&order=asc`, max, fetcher),
    collect<TxRecord>(network, `/accounts/${accountId}/transactions?limit=200&order=asc`, max, fetcher),
  ]);
  const result = attributeMovements(accountId, ops.records, txs.records, range);
  const balances = acc.balances.map((b) => ({
    asset: assetId(b.asset_type, b.asset_code, b.asset_issuer, b.liquidity_pool_id),
    balance: b.balance, sellingLiabilities: b.selling_liabilities ?? null,
  }));
  return {
    network, ...result, range, currentBalances: balances,
    openingBalances: null, historicalBalanceReconstructionComplete: false,
    paginationComplete: ops.complete && txs.complete,
    warnings: [...result.warnings,
      ...(!ops.complete || !txs.complete ? ['Page cap reached; analysed history may be incomplete.'] : []),
    ],
  };
}
if (require.main === module) {
  const [accountId, network = 'testnet'] = process.argv.slice(2);
  analyzeAccountBalances(accountId ?? '', network as Network)
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e: unknown) => { console.error(e); process.exitCode = 1; });
}
