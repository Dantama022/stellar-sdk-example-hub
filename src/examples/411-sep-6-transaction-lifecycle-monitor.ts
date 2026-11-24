export const SEP6_STATUSES = [
  'incomplete',
  'pending_user_transfer_start',
  'pending_user_transfer_complete',
  'pending_external',
  'pending_anchor',
  'pending_stellar',
  'pending_trust',
  'pending_user',
  'completed',
  'refunded',
  'expired',
  'error',
] as const;

export type Sep6Status = (typeof SEP6_STATUSES)[number] | (string & {});

export const TERMINAL_STATUSES = ['completed', 'refunded', 'expired', 'error'];

export interface Sep6Transaction {
  id: string;
  type: 'deposit' | 'withdrawal' | 'unknown';
  status: Sep6Status;
  updatedAt: string | null;
  stellarTransactionHash: string | null;
  unknownStatus: boolean;
}

export interface Observation {
  at: number;
  transaction: Sep6Transaction | null;
  retrievalError?: string;
}

export interface OnChainComparison {
  status: 'verified' | 'mismatch' | 'unavailable' | 'no-hash';
  detail: string;
}

export interface MonitoringResult {
  transactionId: string;
  anchorService: string;
  type: Sep6Transaction['type'];
  currentStatus: string;
  previousStatus: string | null;
  lastObservation: number | null;
  statusChanged: boolean;
  timeInCurrentStatusMs: number | null;
  stale: boolean;
  completedMonitoring: boolean;
  stellarTransactionHash: string | null;
  onChain: OnChainComparison;
  retries: number;
  retrievalErrors: string[];
  anomalies: string[];
  result: 'completed' | 'failed' | 'stale-pending' | 'monitoring';
}

export interface Sep6Record {
  [key: string]: unknown;
}

function read(record: Sep6Record, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

export function normalizeSep6Transaction(record: Sep6Record): Sep6Transaction {
  const status = read(record, 'status') ?? 'unknown';
  const type = read(record, 'transaction_type', 'type');
  return {
    id: read(record, 'id', 'transaction_id') ?? 'unknown',
    type: type === 'deposit' || type === 'withdrawal' ? type : 'unknown',
    status,
    updatedAt: read(record, 'updated_at', 'completed_at', 'status_timestamp'),
    stellarTransactionHash: read(
      record,
      'stellar_transaction_id',
      'stellar_transaction_hash',
      'transaction_hash',
    ),
    unknownStatus: !(SEP6_STATUSES as readonly string[]).includes(status),
  };
}

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function isPendingStatus(status: string): boolean {
  return status.startsWith('pending_') || status === 'incomplete';
}

/** Only reports a transition that clearly conflicts with SEP-6 lifecycle rules. */
export function isInvalidTransition(previous: string | null, next: string): boolean {
  if (!previous || previous === next || !(SEP6_STATUSES as readonly string[]).includes(next)) {
    return false;
  }
  if (isTerminalStatus(previous) && previous !== next) return true;
  if (isTerminalStatus(next) && isPendingStatus(previous)) {
    return next === 'completed' && (previous === 'error' || previous === 'expired');
  }
  return false;
}

export function detectStatusChange(
  previous: Sep6Transaction | null,
  current: Sep6Transaction | null,
): boolean {
  return !!previous && !!current && previous.status !== current.status;
}

export interface OnChainPaymentLike {
  successful?: boolean;
  amount?: string;
  asset?: string;
}

/** Compares anchor-reported settlement with an independently retrieved transaction. */
export function compareOnChain(
  transaction: Sep6Transaction,
  onChain: OnChainPaymentLike | null,
): OnChainComparison {
  if (!transaction.stellarTransactionHash) {
    return { status: 'no-hash', detail: 'No Stellar transaction hash was reported.' };
  }
  if (!onChain) {
    return { status: 'unavailable', detail: 'The reported Stellar transaction could not be retrieved.' };
  }
  if (onChain.successful === false) {
    return { status: 'mismatch', detail: 'The Stellar transaction failed on-chain.' };
  }
  return {
    status: 'verified',
    detail: 'A Stellar transaction was retrieved; external bank payout remains unverified.',
  };
}

/**
 * Replays a sequence of observations deterministically. A caller supplies the
 * timestamps and retrieved records, so no wall-clock delay is needed in tests.
 * Monitoring stops after a terminal status.
 */
export function analyzeObservations(
  anchorService: string,
  observations: Observation[],
  options: { staleThresholdMs?: number; onChain?: OnChainPaymentLike | null } = {},
): MonitoringResult[] {
  const results = new Map<string, MonitoringResult>();
  const staleThresholdMs = options.staleThresholdMs ?? 15 * 60 * 1000;

  for (const observation of observations) {
    if (observation.retrievalError) {
      // Errors are attached to the most recent result for the same transaction;
      // without an identifier they remain a visible diagnostic.
      const latest = [...results.values()].pop();
      if (latest) {
        latest.retries += 1;
        latest.retrievalErrors.push(observation.retrievalError);
      }
      continue;
    }

    const transaction = observation.transaction;
    if (!transaction) continue;

    const existing = results.get(transaction.id);
    // A terminal status stops further monitoring of that transaction.
    if (existing?.completedMonitoring) continue;

    const previous = existing;
    const anomalies: string[] = existing ? [...existing.anomalies] : [];
    if (transaction.unknownStatus) {
      anomalies.push(`unknown status "${transaction.status}" reported`);
    }
    if (isInvalidTransition(previous?.currentStatus ?? null, transaction.status)) {
      anomalies.push(
        `unexpected status transition ${previous?.currentStatus} -> ${transaction.status}`,
      );
    }
    if (isTerminalStatus(transaction.status) && !transaction.stellarTransactionHash) {
      anomalies.push('terminal status without a Stellar transaction hash');
    }

    const timeInStatusMs =
      previous && previous.currentStatus === transaction.status
        ? observation.at - (previous.lastObservation ?? observation.at)
        : 0;
    const stale = isPendingStatus(transaction.status) && timeInStatusMs >= staleThresholdMs;
    if (stale && !anomalies.includes('transaction stale in pending status')) {
      anomalies.push('transaction stale in pending status');
    }

    const terminal = isTerminalStatus(transaction.status);
    const onChain = compareOnChain(transaction, options.onChain ?? null);
    if (onChain.status === 'mismatch') anomalies.push('anchor and on-chain records are inconsistent');

    let result: MonitoringResult['result'] = terminal ? 'completed' : 'monitoring';
    if (terminal && ['error', 'expired'].includes(transaction.status)) result = 'failed';
    if (!terminal && stale) result = 'stale-pending';

    results.set(transaction.id, {
      transactionId: transaction.id,
      anchorService,
      type: transaction.type,
      currentStatus: transaction.status,
      previousStatus: previous?.currentStatus ?? null,
      lastObservation: observation.at,
      statusChanged: detectStatusChange(
        previous ? { ...transaction, status: previous.currentStatus } : null,
        transaction,
      ),
      timeInCurrentStatusMs: timeInStatusMs,
      stale,
      completedMonitoring: terminal,
      stellarTransactionHash: transaction.stellarTransactionHash,
      onChain,
      retries: previous?.retries ?? 0,
      retrievalErrors: previous?.retrievalErrors ?? [],
      anomalies,
      result,
    });
  }

  return [...results.values()];
}

export function formatTextReport(results: MonitoringResult[]): string {
  const lines = ['=== SEP-6 Transaction Lifecycle Monitor ==='];
  if (results.length === 0) lines.push('No transactions were observed.');
  for (const result of results) {
    lines.push(
      '',
      `Transaction: ${result.transactionId} (${result.type})`,
      `Anchor service: ${result.anchorService}`,
      `Status: ${result.previousStatus ?? 'none'} -> ${result.currentStatus}`,
      `Last observation: ${result.lastObservation ?? 'unknown'}`,
      `Time in current status: ${result.timeInCurrentStatusMs ?? 'unknown'} ms`,
      `Stellar hash: ${result.stellarTransactionHash ?? 'unavailable'}`,
      `On-chain: ${result.onChain.status} - ${result.onChain.detail}`,
      `Retries: ${result.retries}; errors: ${result.retrievalErrors.length}`,
      `Result: ${result.result}${result.completedMonitoring ? ' (monitoring stopped)' : ''}`,
      `Anomalies: ${result.anomalies.length ? result.anomalies.join('; ') : 'none'}`,
    );
  }
  return lines.join('\n');
}

export function toJson(results: MonitoringResult[]): string {
  return JSON.stringify(results, null, 2);
}

/** Finds repeated identifiers in a batch response without deduplicating silently. */
export function findDuplicateIds(transactions: Sep6Transaction[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const transaction of transactions) {
    if (seen.has(transaction.id)) duplicates.add(transaction.id);
    seen.add(transaction.id);
  }
  return [...duplicates];
}

/** Fetches one transaction. Temporary failures are counted, never retried blindly here. */
async function fetchTransaction(
  anchorUrl: string,
  transactionId: string,
  token?: string,
): Promise<Sep6Transaction> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const url = `${anchorUrl}/sep6/transaction?id=${encodeURIComponent(transactionId)}`;
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`SEP-6 endpoint returned HTTP ${response.status}`);
  const body = (await response.json()) as Sep6Record;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('SEP-6 endpoint returned a malformed transaction response');
  }
  return normalizeSep6Transaction(body);
}

/**
 * Polls a single SEP-6 transaction without initiating any financial action.
 * Polling intervals and retries are bounded and configurable.
 */
export async function run(
  params: {
    anchorUrl?: string;
    transactionId?: string;
    authToken?: string;
    intervalMs?: number;
    maxPolls?: number;
    maxRetries?: number;
    staleThresholdMs?: number;
    json?: boolean;
  } = {},
): Promise<void> {
  const anchorUrl = (params.anchorUrl ?? process.env.SEP6_ANCHOR_URL ?? '').replace(/\/$/, '');
  const transactionId = params.transactionId ?? process.env.SEP6_TRANSACTION_ID;
  if (!anchorUrl) throw new Error('An anchor service URL is required (SEP6_ANCHOR_URL).');
  if (!transactionId) throw new Error('A SEP-6 transaction ID is required.');

  const token = params.authToken ?? process.env.SEP6_AUTH_TOKEN;
  const intervalMs = params.intervalMs ?? Number(process.env.SEP6_POLL_INTERVAL_MS ?? 5000);
  const maxPolls = params.maxPolls ?? Number(process.env.SEP6_MAX_POLLS ?? 10);
  const maxRetries = params.maxRetries ?? Number(process.env.SEP6_MAX_RETRIES ?? 3);
  const staleThresholdMs = params.staleThresholdMs ?? 15 * 60 * 1000;

  const observations: Observation[] = [];
  let retries = 0;
  for (let poll = 0; poll < maxPolls; poll += 1) {
    const at = Date.now();
    try {
      const transaction = await fetchTransaction(anchorUrl, transactionId, token);
      if (transaction.id !== transactionId) {
        observations.push({ at, retrievalError: 'anchor returned a different transaction ID' });
      } else {
        observations.push({ at, transaction });
        if (isTerminalStatus(transaction.status)) break;
      }
    } catch (error) {
      retries += 1;
      observations.push({
        at,
        retrievalError: error instanceof Error ? error.message : String(error),
      });
      if (retries > maxRetries) break;
    }
    if (poll < maxPolls - 1) {
      await new Promise((resolve) => setTimeout(resolve, Math.max(1000, intervalMs)));
    }
  }

  const results = analyzeObservations(anchorUrl, observations, { staleThresholdMs });
  // Retries counted during polling are surfaced on the resulting report.
  if (retries > 0 && results.length === 0) {
    results.push({
      transactionId,
      anchorService: anchorUrl,
      type: 'unknown',
      currentStatus: 'unavailable',
      previousStatus: null,
      lastObservation: null,
      statusChanged: false,
      timeInCurrentStatusMs: null,
      stale: false,
      completedMonitoring: false,
      stellarTransactionHash: null,
      onChain: { status: 'no-hash', detail: 'No transaction was retrieved.' },
      retries,
      retrievalErrors: observations
        .filter((observation) => observation.retrievalError)
        .map((observation) => observation.retrievalError as string),
      anomalies: ['repeated anchor API failures'],
      result: 'failed',
    });
  }

  const asJson = params.json === true || process.env.JSON_OUTPUT === 'true';
  console.log(asJson ? toJson(results) : formatTextReport(results));
}
