import { endpoint, HORIZON, HttpClient, HorizonHttp, Network, validateRange } from '../_analysis/core';

export interface LedgerRecord { sequence: number; closed_at: string; transaction_count?: number; successful_transaction_count?: number; failed_transaction_count?: number }
export interface LedgerView { sequence: number; closeTimeUtc: string; originalTimestamp: string; transactionCountReported: number | null }

export function normalizeLedger(ledger: LedgerRecord): LedgerView {
  if (!Number.isSafeInteger(ledger.sequence) || ledger.sequence < 1) throw new Error('Malformed ledger sequence');
  const millis = Date.parse(ledger.closed_at);
  if (!ledger.closed_at || !Number.isFinite(millis) || !/Z$|[+-]\d\d:\d\d$/.test(ledger.closed_at)) {
    throw new Error(`Invalid ledger close time for ${ledger.sequence}`);
  }
  const count = ledger.transaction_count ??
    (ledger.successful_transaction_count !== undefined && ledger.failed_transaction_count !== undefined ?
      ledger.successful_transaction_count + ledger.failed_transaction_count : null);
  if (count !== null && (!Number.isSafeInteger(count) || count < 0)) throw new Error('Invalid transaction count');
  return { sequence: ledger.sequence, closeTimeUtc: new Date(millis).toISOString(), originalTimestamp: ledger.closed_at, transactionCountReported: count };
}

export async function retrieveLedger(network: Network, sequence: number, client: HttpClient = new HorizonHttp(), horizon = HORIZON[network]): Promise<LedgerView> {
  validateRange(sequence, sequence);
  const ledger = await client.get<LedgerRecord>(`${endpoint(network, horizon)}/ledgers/${sequence}`);
  if (ledger.sequence !== sequence) throw new Error('Ledger ID does not match requested sequence');
  return normalizeLedger(ledger);
}

export interface LedgerTimingReport { ledgers: LedgerView[]; earliestCloseUtc: string | null; latestCloseUtc: string | null; intervalsSeconds: number[]; averageIntervalSeconds: string | null }
export function ledgerTiming(ledgers: LedgerView[]): LedgerTimingReport {
  const sorted = [...ledgers].sort((a, b) => a.sequence - b.sequence);
  const intervalsSeconds: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].sequence === sorted[i - 1].sequence) throw new Error('Duplicate ledger sequence');
    if (sorted[i].sequence !== sorted[i - 1].sequence + 1) throw new Error('Missing ledger in timing sample');
    const duration = (Date.parse(sorted[i].closeTimeUtc) - Date.parse(sorted[i - 1].closeTimeUtc)) / 1000;
    if (!Number.isFinite(duration) || duration < 0) throw new Error('Non-monotonic ledger close times');
    intervalsSeconds.push(duration);
  }
  const sumMs = intervalsSeconds.reduce((sum, seconds) => sum + BigInt(Math.round(seconds * 1000)), 0n);
  const count = BigInt(intervalsSeconds.length);
  const mean = count ? sumMs / count : 0n;
  return {
    ledgers: sorted, earliestCloseUtc: sorted[0]?.closeTimeUtc ?? null,
    latestCloseUtc: sorted[sorted.length - 1]?.closeTimeUtc ?? null, intervalsSeconds,
    averageIntervalSeconds: count ? `${mean / 1000n}.${(mean % 1000n).toString().padStart(3, '0')}` : null,
  };
}

export function formatLocalTime(timestamp: string, timeZone: string): string {
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error('Invalid timestamp');
  return new Intl.DateTimeFormat('en-US', { timeZone, dateStyle: 'medium', timeStyle: 'long' }).format(new Date(timestamp));
}
