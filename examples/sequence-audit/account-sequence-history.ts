/** #581: historical sequence audit; apparent gaps are not proof of failed transactions. */
import { JsonFetcher, Network, loadAccount, pages } from '../_shared/horizon';

export interface HistoricalTransaction {
  hash: string;
  source_account: string;
  source_account_sequence?: string;
  ledger?: number;
  paging_token?: string;
  created_at?: string;
  successful?: boolean;
}
export interface AuditOptions {
  startLedger?: number;
  endLedger?: number;
  maxPages?: number;
}

function isLedger(value: number | undefined): boolean {
  return value === undefined || (Number.isSafeInteger(value) && value >= 1);
}

export function auditSequences(
  accountId: string, currentSequence: string,
  transactions: HistoricalTransaction[],
  options: AuditOptions = {},
  paginationComplete = true,
) {
  if (!isLedger(options.startLedger) || !isLedger(options.endLedger) ||
      (options.startLedger !== undefined && options.endLedger !== undefined &&
        options.startLedger > options.endLedger)) throw new Error('Invalid ledger range');
  if (!/^\d+$/.test(currentSequence)) throw new Error('Invalid current account sequence');
  const warnings: string[] = [];
  const seen = new Set<string>();
  const included: HistoricalTransaction[] = [];
  let duplicateRecords = 0;
  let originalPreviousToken: bigint | null = null;
  let retrievalOutOfOrder = 0;
  for (const tx of transactions) {
    if (!/^[a-f0-9]{64}$/i.test(tx.hash)) {
      warnings.push('History has a missing or invalid hash; record skipped.'); continue;
    }
    if (seen.has(tx.hash.toLowerCase())) { duplicateRecords++; continue; }
    seen.add(tx.hash.toLowerCase());
    if (tx.paging_token && /^\d+$/.test(tx.paging_token)) {
      const token = BigInt(tx.paging_token);
      if (originalPreviousToken !== null && token < originalPreviousToken) retrievalOutOfOrder++;
      originalPreviousToken = token;
    }
    if (tx.ledger !== undefined && (!Number.isSafeInteger(tx.ledger) || tx.ledger < 1)) {
      warnings.push(`Invalid ledger on transaction ${tx.hash}.`); continue;
    }
    if ((options.startLedger !== undefined && (tx.ledger === undefined || tx.ledger < options.startLedger)) ||
        (options.endLedger !== undefined && (tx.ledger === undefined || tx.ledger > options.endLedger))) continue;
    included.push(tx);
  }
  const sorted = [...included].sort((a, b) => {
    if (a.ledger !== b.ledger) return (a.ledger ?? Infinity) - (b.ledger ?? Infinity);
    const x = a.paging_token && /^\d+$/.test(a.paging_token) ? BigInt(a.paging_token) : null;
    const y = b.paging_token && /^\d+$/.test(b.paging_token) ? BigInt(b.paging_token) : null;
    return x !== null && y !== null ? x < y ? -1 : x > y ? 1 : 0 : 0;
  });
  const lastBySource = new Map<string, bigint>();
  const gaps: Array<{ source: string; from: string; to: string; missing: string }> = [];
  const repeats: Array<{ source: string; sequence: string; hash: string }> = [];
  let missingSequenceFields = 0;
  let missingOrderFields = 0;
  let otherSourceTransactions = 0;
  for (const tx of sorted) {
    if (!tx.source_account || !tx.source_account_sequence || !/^\d+$/.test(tx.source_account_sequence)) {
      missingSequenceFields++; continue;
    }
    if (tx.ledger === undefined || !tx.paging_token || !/^\d+$/.test(tx.paging_token)) {
      missingOrderFields++;
    }
    if (tx.source_account !== accountId) otherSourceTransactions++;
    const sequence = BigInt(tx.source_account_sequence);
    const previous = lastBySource.get(tx.source_account);
    if (previous !== undefined) {
      if (sequence === previous) repeats.push({ source: tx.source_account, sequence: sequence.toString(), hash: tx.hash });
      else if (sequence > previous + 1n) gaps.push({
        source: tx.source_account, from: previous.toString(), to: sequence.toString(),
        missing: (sequence - previous - 1n).toString(),
      });
      else if (sequence < previous) warnings.push(`Non-increasing sequence in confirmed order for ${tx.source_account}: ${sequence}`);
    }
    lastBySource.set(tx.source_account, sequence);
  }
  if (duplicateRecords) warnings.push(`${duplicateRecords} duplicate transaction record(s) removed.`);
  if (retrievalOutOfOrder) warnings.push(`${retrievalOutOfOrder} pagination/order inconsistency(ies) in retrieved records.`);
  if (missingSequenceFields) warnings.push(`${missingSequenceFields} transaction(s) lack usable source/sequence metadata.`);
  if (missingOrderFields) warnings.push(`${missingOrderFields} transaction(s) lack complete ledger ordering metadata.`);
  if (!paginationComplete) warnings.push('Historical pagination limit reached; results are not exhaustive.');
  if (gaps.length) warnings.push('Apparent gaps can reflect history filters, missing records, or bump_sequence; not proof of failed transactions.');
  const highest = sorted.filter((t) => t.source_account === accountId &&
    t.source_account_sequence && /^\d+$/.test(t.source_account_sequence))
    .reduce<bigint | null>((value, tx) => {
      const next = BigInt(tx.source_account_sequence!);
      return value === null || next > value ? next : value;
    }, null);
  const current = BigInt(currentSequence);
  if (highest !== null && current < highest) warnings.push('Current sequence is below observed confirmed history; verify account/network and snapshot consistency.');
  return {
    accountId,
    requestedLedgerRange: { start: options.startLedger ?? null, end: options.endLedger ?? null },
    observedLedgerRange: {
      first: sorted.find((tx) => tx.ledger !== undefined)?.ledger ?? null,
      last: [...sorted].reverse().find((tx) => tx.ledger !== undefined)?.ledger ?? null,
    },
    recordsAnalyzed: sorted.length,
    duplicateRecords,
    paginationComplete,
    otherSourceTransactions,
    retrievalOutOfOrder,
    highestConfirmedSequence: highest?.toString() ?? null,
    currentAccountSequence: currentSequence,
    currentMinusHighest: highest === null ? null : (current - highest).toString(),
    apparentGaps: gaps,
    repeatedSequenceValues: repeats,
    warnings,
    confidence: !paginationComplete || missingSequenceFields || missingOrderFields ? 'limited' : 'bounded-to-retrieved-history',
    note: 'Sequence values belong to source accounts, not ledgers. A filtered Horizon history does not establish all submitted or locally reserved sequences.',
  };
}

export async function analyzeSequenceHistory(
  accountId: string, network: Network, options: AuditOptions = {},
  fetcher: JsonFetcher = fetch,
) {
  // Validate options before network calls.
  if (!isLedger(options.startLedger) || !isLedger(options.endLedger) ||
      (options.startLedger !== undefined && options.endLedger !== undefined && options.startLedger > options.endLedger)) {
    throw new Error('Invalid ledger range');
  }
  const account = await loadAccount(accountId, network, fetcher);
  const result = await pages<HistoricalTransaction>(network,
    `/accounts/${accountId}/transactions?order=asc&limit=200`, options.maxPages ?? 10, fetcher);
  return { network, ...auditSequences(accountId, account.sequence, result.records, options, result.complete) };
}

if (require.main === module) {
  const [accountId, network = 'testnet', start, end] = process.argv.slice(2);
  analyzeSequenceHistory(accountId ?? '', network as Network, {
    startLedger: start ? Number(start) : undefined,
    endLedger: end ? Number(end) : undefined,
  }).then((report) => console.log(JSON.stringify(report, null, 2)))
    .catch((error: unknown) => { console.error(error); process.exitCode = 1; });
}
