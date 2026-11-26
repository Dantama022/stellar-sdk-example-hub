import { allPages, endpoint, HORIZON, HttpClient, HorizonHttp, Network, validateRange } from '../_analysis/core';
import { ledgerTiming, LedgerTimingReport, retrieveLedger } from './ledger-close-time';

export interface TxRecord { hash: string; ledger: number; created_at: string; successful?: boolean; paging_token?: string }
export interface TxView { hash: string; ledger: number; ledgerCloseUtc: string; transactionTimestampUtc: string; originalTimestamp: string; successful: boolean | null; pagingToken: string | null }
export interface Checkpoint { lastCompletedLedger: number }
export class RetrievalInterruptedError extends Error {
  constructor(public readonly checkpoint: Checkpoint, cause: unknown) {
    super(`Ledger retrieval interrupted after ${checkpoint.lastCompletedLedger}: ${String(cause)}`);
    this.name = 'RetrievalInterruptedError';
  }
}
export interface TimestampReport {
  network: Network; range: { start: number; end: number }; checkpoint: Checkpoint;
  transactions: TxView[]; transactionCount: number; timing: LedgerTimingReport;
  warning: string;
}

export async function retrieveTransactionTimestamps(options: {
  network: Network; start: number; end: number; resume?: Checkpoint; pageSize?: number; horizon?: string;
}, client: HttpClient = new HorizonHttp()): Promise<TimestampReport> {
  const { network, start, end } = options;
  validateRange(start, end, 100);
  const pageSize = options.pageSize ?? 200;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) throw new Error('Page size must be 1-200');
  const previous = options.resume?.lastCompletedLedger ?? start - 1;
  if (!Number.isSafeInteger(previous) || previous < start - 1 || previous > end) throw new Error('Invalid checkpoint');
  const transactions: TxView[] = [];
  const seen = new Set<string>();
  const ledgers: LedgerTimingReport['ledgers'] = [];
  const checkpoint = { lastCompletedLedger: previous };
  for (let seq = previous + 1; seq <= end; seq++) {
    try {
      const ledger = await retrieveLedger(network, seq, client, options.horizon);
      const url = `${endpoint(network, options.horizon ?? HORIZON[network])}/ledgers/${seq}/transactions?order=asc&limit=${pageSize}`;
      const fetched = await allPages<TxRecord>(client, url, 50_000);
      const pending: TxView[] = [];
      const pendingHashes = new Set<string>();
      for (const tx of fetched) {
        if (tx.ledger !== seq || !/^[0-9a-f]{64}$/i.test(tx.hash)) throw new Error('Malformed transaction in ledger page');
        if (!seen.has(tx.hash) && !pendingHashes.has(tx.hash)) {
          const txTime = new Date(tx.created_at).getTime();
          if (!Number.isFinite(txTime)) throw new Error('Missing transaction inclusion timestamp');
          pendingHashes.add(tx.hash);
          pending.push({ hash: tx.hash, ledger: seq, ledgerCloseUtc: ledger.closeTimeUtc, transactionTimestampUtc: new Date(txTime).toISOString(), originalTimestamp: tx.created_at,
            successful: typeof tx.successful === 'boolean' ? tx.successful : null,
            pagingToken: tx.paging_token ?? null });
        }
      }
      if (ledger.transactionCountReported !== null && ledger.transactionCountReported !== pending.length) {
        throw new Error(`Ledger ${seq} reports ${ledger.transactionCountReported} transactions but ${pending.length} unique records were retrieved`);
      }
      // Commit the ledger's records/checkpoint only after its complete pagination succeeds.
      pending.forEach((tx) => { seen.add(tx.hash); transactions.push(tx); });
      ledgers.push(ledger);
      checkpoint.lastCompletedLedger = seq;
    } catch (error) { throw new RetrievalInterruptedError({ ...checkpoint }, error); }
  }
  return {
    network, range: { start: previous + 1, end }, checkpoint,
    transactions, transactionCount: transactions.length, timing: ledgerTiming(ledgers),
    warning: 'Transaction created_at reflects ledger inclusion/close, NOT initial wallet submission. Resume checkpoints must be stored by the caller; do not silently treat missing ledgers as empty.',
  };
}
