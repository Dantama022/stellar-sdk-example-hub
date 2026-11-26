/** #574: read-only memo-based incoming payment reconciliation. */
import {
  Fetcher, Network, amountToUnits, assetId, collect, json, validAccount,
} from '../_shared/horizon-readonly';
import { MemoType, PaymentReference } from './payment-reference-registry';

export interface TxMemo {
  hash: string; memo_type?: string; memo?: string; successful?: boolean; ledger?: number;
  created_at?: string;
}
export interface Payment {
  id: string; type: string; transaction_hash: string; transaction_successful?: boolean;
  from?: string; to?: string; amount?: string; asset_type?: string; asset_code?: string;
  asset_issuer?: string; ledger?: number; created_at?: string;
}
export interface DecodedMemo { type: MemoType; original: string | null; normalized: string | null; error: string | null }
export function decodeMemo(tx: TxMemo): DecodedMemo {
  const type = tx.memo_type ?? 'none';
  if (!['none', 'text', 'id', 'hash', 'return'].includes(type)) {
    return { type: 'none', original: tx.memo ?? null, normalized: null, error: `Unknown memo type ${type}` };
  }
  const memoType = type as MemoType;
  if (memoType === 'none') return { type: memoType, original: null, normalized: null, error: null };
  const raw = tx.memo;
  if (typeof raw !== 'string') return { type: memoType, original: null, normalized: null, error: 'Missing memo value' };
  if (memoType === 'text') return { type: memoType, original: raw, normalized: raw, error: null };
  if (memoType === 'id') {
    if (!/^\d+$/.test(raw)) return { type: memoType, original: raw, normalized: null, error: 'Invalid memo ID' };
    const num = BigInt(raw);
    if (num > 18_446_744_073_709_551_615n) return { type: memoType, original: raw, normalized: null, error: 'Memo ID exceeds uint64 range' };
    return { type: memoType, original: raw, normalized: num.toString(), error: null };
  }
  // Horizon memo_hash and memo_return values are base64-encoded 32-byte buffers.
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw)) {
    return { type: memoType, original: raw, normalized: null, error: 'Invalid base64 hash memo' };
  }
  const bytes = Buffer.from(raw, 'base64');
  return bytes.length === 32
    ? { type: memoType, original: raw, normalized: bytes.toString('hex'), error: null }
    : { type: memoType, original: raw, normalized: null, error: 'Memo hash/return must be 32 bytes' };
}
export type MatchStatus = 'exact-match' | 'amount-mismatch' | 'asset-mismatch' | 'unknown-reference' |
  'duplicate-payment' | 'ambiguous-match' | 'awaiting-verification';
export interface PaymentResult {
  paymentId: string; transactionHash: string; memo: DecodedMemo; status: MatchStatus;
  referenceId: string | null; reason: string; destination: string | null;
  asset: string | null; amount: string | null;
}
export function reconcilePayments(destinationAccount: string, payments: Payment[], transactions: TxMemo[], registry: PaymentReference[]) {
  const txByHash = new Map(transactions.map((tx) => [tx.hash, tx]));
  const seenPayments = new Set<string>();
  const claimedReferences = new Set(registry.filter((r) => r.status === 'paid').map((r) => r.id));
  const results: PaymentResult[] = [];
  const warnings: string[] = [];
  for (const expected of registry) {
    if (!expected.id || !expected.customerOrOrderId || !expected.memo) throw new Error('Invalid payment reference');
    amountToUnits(expected.amount, 'reference amount');
  }
  for (const payment of payments) {
    const tx = txByHash.get(payment.transaction_hash);
    const memo = tx ? decodeMemo(tx) : { type: 'none' as MemoType, original: null, normalized: null, error: 'Missing transaction metadata' };
    let asset: string | null = null;
    let amount: bigint | null = null;
    let broken: string | null = null;
    try {
      if (!payment.asset_type) throw new Error('Missing payment asset');
      asset = assetId(payment.asset_type, payment.asset_code, payment.asset_issuer);
      if (!payment.amount) throw new Error('Missing payment amount');
      amount = amountToUnits(payment.amount);
    } catch (error) { broken = String(error); }
    const result: PaymentResult = {
      paymentId: payment.id, transactionHash: payment.transaction_hash, memo,
      status: 'awaiting-verification', referenceId: null, reason: '',
      destination: payment.to ?? null, asset, amount: payment.amount ?? null,
    };
    if (seenPayments.has(payment.id)) {
      result.status = 'duplicate-payment'; result.reason = 'Duplicate operation record (same operation ID)';
    } else {
      seenPayments.add(payment.id);
      const matching = registry.filter((r) => r.memoType === memo.type && r.memo === memo.normalized);
      if (!tx || memo.error || tx.successful !== true || payment.transaction_successful !== true || broken ||
        payment.to !== destinationAccount || !['payment', 'path_payment_strict_receive', 'path_payment_strict_send'].includes(payment.type)) {
        result.reason = broken ?? memo.error ?? 'Missing proof of successful incoming payment, expected destination, or supported payment operation';
      } else if (!memo.normalized || !matching.length) {
        result.status = 'unknown-reference'; result.reason = 'Memo does not match an expected reference';
      } else if (matching.length > 1) {
        result.status = 'ambiguous-match'; result.reason = 'Multiple expected records share this memo type and value';
      } else {
        const expected = matching[0];
        result.referenceId = expected.id;
        if (claimedReferences.has(expected.id)) {
          result.status = 'duplicate-payment'; result.reason = 'Reference already reconciled by another payment';
        } else if (asset !== expected.asset) {
          result.status = 'asset-mismatch'; result.reason = 'Payment asset differs from expected asset';
        } else if (amount !== amountToUnits(expected.amount)) {
          result.status = 'amount-mismatch'; result.reason = 'Payment amount differs from expected amount (review possible partial/overpayment)';
        } else if (payment.to !== expected.destination) {
          result.reason = 'Matched memo, but expected destination differs';
        } else {
          result.status = 'exact-match'; result.reason = 'Successful incoming transaction, matching destination, asset and exact amount';
          claimedReferences.add(expected.id);
        }
      }
    }
    results.push(result);
  }
  const counts: Record<MatchStatus, number> = {
    'exact-match': 0, 'amount-mismatch': 0, 'asset-mismatch': 0, 'unknown-reference': 0,
    'duplicate-payment': 0, 'ambiguous-match': 0, 'awaiting-verification': 0,
  };
  for (const r of results) counts[r.status]++;
  if (transactions.length < new Set(payments.map((p) => p.transaction_hash)).size) {
    warnings.push('Not all transaction memo/status metadata was retrieved.');
  }
  return {
    destinationAccount, transactionsInspected: new Set(payments.map((p) => p.transaction_hash)).size,
    paymentOperationsInspected: payments.length, counts, results,
    outstandingReferences: registry.filter((r) => !claimedReferences.has(r.id)).map((r) => r.id),
    warnings,
    note: 'Memo reference matching is not proof of settlement without a successful payment operation; memos are public. Persist operation IDs and reconciled reference IDs between runs.',
  };
}
export async function analyzeIncomingReferences(
  accountId: string, network: Network, registry: PaymentReference[], maxPages = 5,
  fetcher: Fetcher = fetch,
) {
  validAccount(accountId);
  const page = await collect<Payment>(network, `/accounts/${accountId}/payments?limit=200&order=asc`, maxPages, fetcher);
  const relevant = page.records.filter((p) => p.to === accountId &&
    ['payment', 'path_payment_strict_receive', 'path_payment_strict_send'].includes(p.type));
  const hashes = Array.from(new Set(relevant.map((p) => p.transaction_hash)));
  // A missing transaction is a hard retrieval error, not a silent successful reconciliation.
  const txs = await Promise.all(hashes.map((hash) => json<TxMemo>(network, `/transactions/${hash}`, fetcher)));
  const report = reconcilePayments(accountId, relevant, txs, registry);
  return { network, ...report, paginationComplete: page.complete,
    warnings: [...report.warnings, ...(!page.complete ? ['Horizon pagination capped; older/newer payments may be missing.'] : [])] };
}
if (require.main === module) {
  const [accountId, network = 'testnet'] = process.argv.slice(2);
  analyzeIncomingReferences(accountId ?? '', network as Network, [])
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e: unknown) => { console.error(e); process.exitCode = 1; });
}
