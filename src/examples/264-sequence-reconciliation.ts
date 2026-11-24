/**
 * 264-sequence-reconciliation: Stellar Account Sequence Recovery and Queue
 * Reconciliation
 *
 * OVERVIEW
 * --------
 * Every transaction from a Stellar account carries a sequence number that must
 * be exactly one greater than the account's current on-ledger sequence. When
 * several workers build transactions from one account, local allocation can
 * drift from Horizon's state, leaving gaps, duplicates, or transactions whose
 * outcome is unknown.
 *
 * This example demonstrates:
 *
 *   1. retrieving the authoritative account sequence from Horizon,
 *   2. allocating sequence numbers atomically from a local tracker,
 *   3. recording allocated, signed, submitted, confirmed, failed, and
 *      unresolved transactions,
 *   4. reconciling local records against the network sequence, and
 *   5. producing recovery recommendations without discarding unresolved work or
 *      automatically resubmitting transactions.
 *
 * PRODUCTION STORAGE
 * ------------------
 * The included JSON file adapter is for demonstration only. Production systems
 * should use durable, concurrency-safe storage (for example a database row with
 * an atomic compare-and-set) so multiple workers sharing one Stellar account
 * cannot allocate the same sequence number.
 */

import { Horizon, StrKey } from '@stellar/stellar-sdk';
import { readFile, writeFile } from 'fs/promises';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const DEFAULT_ACCOUNT_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export type TransactionQueueStatus =
  | 'allocated'
  | 'signed'
  | 'submitted'
  | 'confirmed'
  | 'failed'
  | 'unresolved';

export interface QueuedTransactionRecord {
  hash: string;
  sequence: string;
  status: TransactionQueueStatus;
  createdAt: string;
  updatedAt: string;
  ledger: number | null;
  error: string | null;
  metadata: Record<string, unknown>;
}

export interface SequenceTrackerState {
  accountId: string;
  networkSequence: string;
  nextSequence: string;
  records: QueuedTransactionRecord[];
}

export interface AccountSequenceState {
  accountId: string;
  sequence: string;
  ledger: number | null;
  retrievedAt: string;
}

export interface TransactionStatusResult {
  hash: string;
  found: boolean;
  successful: boolean | null;
  ledger: number | null;
  resultCode: string | null;
  error: string | null;
}

export interface DuplicateSequenceAllocation {
  sequence: string;
  hashes: string[];
}

export interface SequenceReconciliationInput {
  accountId: string;
  networkSequence: string;
  networkLedger?: number | null;
  retrievedAt?: string;
  records: QueuedTransactionRecord[];
  nextLocalSequence?: string;
  lastSynchronizedNetworkSequence?: string | null;
}

export interface SequenceReconciliationReport {
  accountId: string;
  networkSequence: string;
  networkLedger: number | null;
  retrievedAt: string;
  latestLocalAllocatedSequence: string | null;
  nextLocalSequence: string;
  queuedTransactionCount: number;
  confirmedTransactionCount: number;
  unresolvedTransactionCount: number;
  failedTransactionCount: number;
  reflectedOnChainCount: number;
  possiblyRejectedCount: number;
  duplicateSequenceAllocations: DuplicateSequenceAllocation[];
  sequenceGaps: string[];
  orderingConflicts: string[];
  localAheadOfNetwork: boolean;
  networkAheadOfLocal: boolean;
  staleLocalState: boolean;
  confirmedTransactions: QueuedTransactionRecord[];
  unresolvedTransactions: QueuedTransactionRecord[];
  failedTransactions: QueuedTransactionRecord[];
  requiresInvestigation: string[];
  recoveryRecommendations: string[];
  reconciliationStatus:
    | 'consistent'
    | 'needs_refresh'
    | 'unresolved'
    | 'conflict'
    | 'incomplete';
  limitations: string[];
}

export interface SequenceReconciliationParams {
  accountId?: string;
  horizonUrl?: string;
  queueFile?: string;
  checkPendingStatuses?: boolean | string;
  json?: boolean | string;
}

export interface SequencePersistenceAdapter {
  load(): Promise<SequenceTrackerState | null>;
  save(state: SequenceTrackerState): Promise<void>;
}

// ──────────────────────────────────────────────────────────────────────────────
// Sequence helpers
// ──────────────────────────────────────────────────────────────────────────────

export function isValidAccountId(accountId: unknown): accountId is string {
  return typeof accountId === 'string' && StrKey.isValidEd25519PublicKey(accountId);
}

export function parseSequence(value: unknown, field = 'sequence'): bigint {
  try {
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') {
      throw new Error('unsupported type');
    }
    const parsed = BigInt(value);
    if (parsed < 0n) throw new Error('negative');
    return parsed;
  } catch {
    throw new Error(`${field} must be a non-negative integer.`);
  }
}

export function nextSequence(sequence: string): string {
  return (parseSequence(sequence) + 1n).toString();
}

export function sequencesEqual(left: string, right: string): boolean {
  return parseSequence(left) === parseSequence(right);
}

export async function fetchAccountSequence(
  server: Horizon.Server,
  accountId: string,
): Promise<AccountSequenceState> {
  if (!isValidAccountId(accountId)) {
    throw new Error('accountId must be a valid Stellar G... public key.');
  }
  const account = await server.loadAccount(accountId);
  const sequence = account.sequenceNumber();
  parseSequence(sequence, 'Horizon account sequence');
  const record = account as unknown as {
    last_modified_ledger?: number;
    last_modified_time?: string;
  };
  return {
    accountId,
    sequence,
    ledger: record.last_modified_ledger ?? null,
    retrievedAt: new Date().toISOString(),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Local sequence tracking
// ──────────────────────────────────────────────────────────────────────────────

function cloneRecord(record: QueuedTransactionRecord): QueuedTransactionRecord {
  return { ...record, metadata: { ...record.metadata } };
}

function cloneState(state: SequenceTrackerState): SequenceTrackerState {
  return {
    ...state,
    records: state.records.map(cloneRecord),
  };
}

/**
 * Tracks sequence allocations and transaction states for one account.
 *
 * `allocate()` is synchronous: within a single Node.js process, no other
 * allocation can interleave between reading the cursor and advancing it. This
 * does not make allocation safe across processes; use durable atomic storage in
 * production.
 */
export class LocalSequenceTracker {
  private readonly accountId: string;
  private networkSequence: bigint;
  private next: bigint;
  private readonly recordsByHash = new Map<string, QueuedTransactionRecord>();

  constructor(accountId: string, networkSequence: string, state?: SequenceTrackerState | null) {
    if (!isValidAccountId(accountId)) {
      throw new Error('accountId must be a valid Stellar G... public key.');
    }
    this.accountId = accountId;
    this.networkSequence = parseSequence(networkSequence, 'network sequence');
    this.next = state?.nextSequence
      ? parseSequence(state.nextSequence, 'next sequence')
      : this.networkSequence + 1n;

    if (state) {
      if (state.accountId !== accountId) {
        throw new Error('Persisted sequence state belongs to a different account.');
      }
      for (const record of state.records) {
        const parsed = parseSequence(record.sequence, 'queued transaction sequence');
        if (this.recordsByHash.has(record.hash)) {
          throw new Error(`Duplicate transaction hash in persisted state: ${record.hash}`);
        }
        this.recordsByHash.set(record.hash, cloneRecord(record));
        if (parsed >= this.next) this.next = parsed + 1n;
      }
    }
  }

  get account(): string {
    return this.accountId;
  }

  get chainSequence(): string {
    return this.networkSequence.toString();
  }

  get nextAvailableSequence(): string {
    return this.next.toString();
  }

  get records(): QueuedTransactionRecord[] {
    return [...this.recordsByHash.values()]
      .sort((left, right) => {
        const difference = parseSequence(left.sequence) - parseSequence(right.sequence);
        return difference === 0n ? left.hash.localeCompare(right.hash) : difference > 0n ? 1 : -1;
      })
      .map(cloneRecord);
  }

  /**
   * Atomically allocates the next sequence number and records an allocation.
   * The optional hash lets callers reserve a hash before signing; when omitted a
   * deterministic local placeholder is used.
   */
  allocate(options: {
    hash?: string;
    status?: TransactionQueueStatus;
    metadata?: Record<string, unknown>;
  } = {}): QueuedTransactionRecord {
    const sequence = this.next.toString();
    const hash = options.hash ?? `local-${sequence}`;
    if (this.recordsByHash.has(hash)) {
      throw new Error(`Transaction hash ${hash} is already tracked.`);
    }
    if ([...this.recordsByHash.values()].some((record) => record.sequence === sequence)) {
      throw new Error(`Sequence ${sequence} is already allocated.`);
    }
    const now = new Date().toISOString();
    const record: QueuedTransactionRecord = {
      hash,
      sequence,
      status: options.status ?? 'allocated',
      createdAt: now,
      updatedAt: now,
      ledger: null,
      error: null,
      metadata: { ...(options.metadata ?? {}) },
    };
    this.recordsByHash.set(hash, record);
    this.next = parseSequence(sequence) + 1n;
    return cloneRecord(record);
  }

  allocateMany(
    count: number,
    options: { metadata?: Record<string, unknown> } = {},
  ): QueuedTransactionRecord[] {
    if (!Number.isSafeInteger(count) || count < 1) {
      throw new Error('count must be a positive integer.');
    }
    return Array.from({ length: count }, () => this.allocate({ metadata: options.metadata }));
  }

  /** Adds an externally produced transaction record without changing the cursor backwards. */
  record(record: QueuedTransactionRecord): QueuedTransactionRecord {
    const sequence = parseSequence(record.sequence, 'queued transaction sequence');
    if (this.recordsByHash.has(record.hash)) {
      throw new Error(`Transaction hash ${record.hash} is already tracked.`);
    }
    if ([...this.recordsByHash.values()].some((entry) => entry.sequence === record.sequence)) {
      throw new Error(`Sequence ${record.sequence} is already allocated.`);
    }
    const stored = cloneRecord(record);
    this.recordsByHash.set(stored.hash, stored);
    if (sequence >= this.next) this.next = sequence + 1n;
    return cloneRecord(stored);
  }

  markStatus(
    hash: string,
    status: TransactionQueueStatus,
    details: { ledger?: number | null; error?: string | null } = {},
  ): QueuedTransactionRecord {
    const record = this.recordsByHash.get(hash);
    if (!record) throw new Error(`Transaction hash ${hash} is not tracked.`);
    record.status = status;
    record.updatedAt = new Date().toISOString();
    if (details.ledger !== undefined) record.ledger = details.ledger;
    if (details.error !== undefined) record.error = details.error;
    if (status === 'confirmed') {
      const sequence = parseSequence(record.sequence);
      if (sequence > this.networkSequence) this.networkSequence = sequence;
    }
    return cloneRecord(record);
  }

  findDuplicateAllocations(): DuplicateSequenceAllocation[] {
    return findDuplicateSequences([...this.recordsByHash.values()]);
  }

  /** Refreshes the network baseline while preserving all transaction records. */
  refreshNetworkSequence(sequence: string): void {
    const parsed = parseSequence(sequence, 'network sequence');
    this.networkSequence = parsed;
    if (this.next <= parsed) this.next = parsed + 1n;
  }

  snapshot(): SequenceTrackerState {
    return {
      accountId: this.accountId,
      networkSequence: this.networkSequence.toString(),
      nextSequence: this.next.toString(),
      records: this.records,
    };
  }

  async persist(adapter: SequencePersistenceAdapter): Promise<void> {
    await adapter.save(this.snapshot());
  }

  static async restore(
    accountId: string,
    networkSequence: string,
    adapter: SequencePersistenceAdapter,
  ): Promise<LocalSequenceTracker> {
    const state = await adapter.load();
    return new LocalSequenceTracker(
      accountId,
      networkSequence,
      state?.accountId === accountId ? state : null,
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Persistence adapters
// ──────────────────────────────────────────────────────────────────────────────

export class InMemorySequencePersistence implements SequencePersistenceAdapter {
  private state: SequenceTrackerState | null = null;

  async load(): Promise<SequenceTrackerState | null> {
    return this.state ? cloneState(this.state) : null;
  }

  async save(state: SequenceTrackerState): Promise<void> {
    this.state = cloneState(state);
  }
}

export class JsonFileSequencePersistence implements SequencePersistenceAdapter {
  constructor(private readonly filePath: string) {}

  async load(): Promise<SequenceTrackerState | null> {
    try {
      const content = await readFile(this.filePath, 'utf8');
      return JSON.parse(content) as SequenceTrackerState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async save(state: SequenceTrackerState): Promise<void> {
    await writeFile(this.filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  }
}

/** Alias retained for callers that prefer the shorter adapter name. */
export { JsonFileSequencePersistence as FileSequencePersistence };

// ──────────────────────────────────────────────────────────────────────────────
// Reconciliation
// ──────────────────────────────────────────────────────────────────────────────

function findDuplicateSequences(
  records: QueuedTransactionRecord[],
): DuplicateSequenceAllocation[] {
  const bySequence = new Map<string, string[]>();
  for (const record of records) {
    const hashes = bySequence.get(record.sequence) ?? [];
    hashes.push(record.hash);
    bySequence.set(record.sequence, hashes);
  }
  return [...bySequence.entries()]
    .filter(([, hashes]) => hashes.length > 1)
    .map(([sequence, hashes]) => ({ sequence, hashes: hashes.sort() }))
    .sort((left, right) => (parseSequence(left.sequence) < parseSequence(right.sequence) ? -1 : 1));
}

function findSequenceGaps(
  sequences: bigint[],
  networkSequence: bigint,
  nextLocalSequence: bigint,
): string[] {
  const pending = [...new Set(sequences.filter((sequence) => sequence > networkSequence))].sort(
    (left, right) => (left < right ? -1 : left > right ? 1 : 0),
  );
  const gaps: string[] = [];
  let expected = networkSequence + 1n;
  for (const sequence of pending) {
    while (expected < sequence) {
      gaps.push(expected.toString());
      expected += 1n;
    }
    expected = sequence + 1n;
  }
  while (expected < nextLocalSequence) {
    gaps.push(expected.toString());
    expected += 1n;
  }
  return gaps;
}

export function reconcileSequenceState(
  input: SequenceReconciliationInput,
): SequenceReconciliationReport {
  const networkSequence = parseSequence(input.networkSequence, 'network sequence');
  const records = input.records
    .map(cloneRecord)
    .sort((left, right) => {
      const difference = parseSequence(left.sequence) - parseSequence(right.sequence);
      return difference === 0n ? left.hash.localeCompare(right.hash) : difference > 0n ? 1 : -1;
    });
  const latestLocal =
    records.length > 0
      ? records
          .map((record) => parseSequence(record.sequence))
          .reduce((maximum, sequence) => (sequence > maximum ? sequence : maximum))
      : null;
  const nextLocal = input.nextLocalSequence
    ? parseSequence(input.nextLocalSequence, 'next local sequence')
    : latestLocal === null
      ? networkSequence + 1n
      : latestLocal + 1n;

  const duplicateSequenceAllocations = findDuplicateSequences(records);
  const sequenceGaps = findSequenceGaps(
    records.map((record) => parseSequence(record.sequence)),
    networkSequence,
    nextLocal,
  );
  const confirmedTransactions = records.filter((record) => record.status === 'confirmed');
  const failedTransactions = records.filter((record) => record.status === 'failed');
  const unresolvedTransactions = records.filter(
    (record) => record.status !== 'confirmed' && record.status !== 'failed',
  );
  const reflected = records.filter(
    (record) => parseSequence(record.sequence) <= networkSequence,
  );
  const possiblyRejected = reflected.filter(
    (record) => record.status !== 'confirmed' && record.status !== 'failed',
  );
  const orderingConflicts = unresolvedTransactions
    .filter((record) => parseSequence(record.sequence) <= networkSequence)
    .map((record) => record.hash);
  const requiresInvestigation = [
    ...new Set([
      ...possiblyRejected.map((record) => record.hash),
      ...duplicateSequenceAllocations.flatMap((duplicate) => duplicate.hashes),
      ...orderingConflicts,
    ]),
  ].sort();

  const localAheadOfNetwork = latestLocal !== null && latestLocal > networkSequence;
  const networkAheadOfLocal = nextLocal <= networkSequence;
  const staleLocalState =
    networkAheadOfLocal ||
    (input.lastSynchronizedNetworkSequence !== undefined &&
      input.lastSynchronizedNetworkSequence !== null &&
      parseSequence(input.lastSynchronizedNetworkSequence) !== networkSequence);

  const recoveryRecommendations: string[] = [];
  if (networkAheadOfLocal) {
    recoveryRecommendations.push(
      'Refresh the local cursor from Horizon before allocating another sequence; the network has advanced past the local next sequence.',
    );
  }
  if (duplicateSequenceAllocations.length > 0) {
    recoveryRecommendations.push(
      'Resolve duplicate local sequence allocations before submitting any of the affected transactions.',
    );
  }
  if (sequenceGaps.length > 0) {
    recoveryRecommendations.push(
      `Investigate missing local sequence allocation(s): ${sequenceGaps.join(', ')}. Do not reuse a gap while an unresolved transaction may still reference it.`,
    );
  }
  if (possiblyRejected.length > 0) {
    recoveryRecommendations.push(
      'Some local records are at or below the network sequence but are not marked confirmed. Check each transaction hash and result code before rebuilding or retrying.',
    );
  }
  if (unresolvedTransactions.length > 0) {
    recoveryRecommendations.push(
      'Query Horizon transaction status for every unresolved hash before deciding whether to retry. Preserve unresolved records until their network outcome is known.',
    );
  }
  if (localAheadOfNetwork && unresolvedTransactions.length > 0) {
    recoveryRecommendations.push(
      'Submit or resolve already-allocated transactions in sequence order; do not allocate around unresolved sequence numbers.',
    );
  }
  if (recoveryRecommendations.length === 0) {
    recoveryRecommendations.push(
      'Local allocation is aligned with the network sequence and no unresolved sequence conflicts were detected.',
    );
  }

  let reconciliationStatus: SequenceReconciliationReport['reconciliationStatus'];
  if (orderingConflicts.length > 0 || duplicateSequenceAllocations.length > 0) {
    reconciliationStatus = 'conflict';
  } else if (networkAheadOfLocal || staleLocalState) {
    reconciliationStatus = 'needs_refresh';
  } else if (unresolvedTransactions.length > 0 || possiblyRejected.length > 0) {
    reconciliationStatus = 'unresolved';
  } else if (input.accountId && !isValidAccountId(input.accountId)) {
    reconciliationStatus = 'incomplete';
  } else {
    reconciliationStatus = 'consistent';
  }

  return {
    accountId: input.accountId,
    networkSequence: networkSequence.toString(),
    networkLedger: input.networkLedger ?? null,
    retrievedAt: input.retrievedAt ?? new Date().toISOString(),
    latestLocalAllocatedSequence: latestLocal?.toString() ?? null,
    nextLocalSequence: nextLocal.toString(),
    queuedTransactionCount: records.length,
    confirmedTransactionCount: confirmedTransactions.length,
    unresolvedTransactionCount: unresolvedTransactions.length,
    failedTransactionCount: failedTransactions.length,
    reflectedOnChainCount: reflected.length,
    possiblyRejectedCount: possiblyRejected.length,
    duplicateSequenceAllocations,
    sequenceGaps,
    orderingConflicts,
    localAheadOfNetwork,
    networkAheadOfLocal,
    staleLocalState,
    confirmedTransactions,
    unresolvedTransactions,
    failedTransactions,
    requiresInvestigation,
    recoveryRecommendations,
    reconciliationStatus,
    limitations: [
      'A sequence at or below the network sequence does not prove that the local transaction itself was the one applied.',
      'A missing local record does not prove that the corresponding network transaction failed.',
      'This example never automatically discards unresolved records or resubmits transactions.',
      'Production deployments need durable, atomic sequence allocation shared by every worker using the account.',
    ],
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Network status checks and retry safety
// ──────────────────────────────────────────────────────────────────────────────

export async function checkTransactionStatus(
  server: Horizon.Server,
  hash: string,
): Promise<TransactionStatusResult> {
  try {
    const transaction = await server.transactions().transaction(hash).call();
    const record = transaction as unknown as {
      successful?: boolean;
      ledger?: number;
      result_codes?: { transaction?: string };
    };
    return {
      hash,
      found: true,
      successful: record.successful ?? null,
      ledger: record.ledger ?? null,
      resultCode: record.result_codes?.transaction ?? null,
      error: null,
    };
  } catch (error) {
    const status = (error as { response?: { status?: number } }).response?.status;
    if (status === 404) {
      return {
        hash,
        found: false,
        successful: null,
        ledger: null,
        resultCode: null,
        error: null,
      };
    }
    return {
      hash,
      found: false,
      successful: null,
      ledger: null,
      resultCode: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function applyTransactionStatus(
  record: QueuedTransactionRecord,
  status: TransactionStatusResult,
): QueuedTransactionRecord {
  const updated = cloneRecord(record);
  updated.updatedAt = new Date().toISOString();
  if (status.found && status.successful === true) {
    updated.status = 'confirmed';
    updated.ledger = status.ledger;
    updated.error = null;
  } else if (status.found && status.successful === false) {
    updated.status = 'failed';
    updated.ledger = status.ledger;
    updated.error = status.resultCode ?? status.error ?? 'Transaction failed on ledger.';
  } else if (!status.found && !status.error) {
    updated.status = 'unresolved';
  } else if (status.error) {
    updated.error = status.error;
  }
  return updated;
}

export function recommendTransactionRecovery(
  record: QueuedTransactionRecord,
  status: TransactionStatusResult,
  networkSequence: string,
): string {
  const network = parseSequence(networkSequence, 'network sequence');
  const sequence = parseSequence(record.sequence, 'record sequence');
  if (status.found && status.successful === true) {
    return `Do not resubmit ${record.hash}: Horizon confirms it succeeded in ledger ${status.ledger ?? 'unknown'}.`;
  }
  if (status.found && status.successful === false) {
    return `Do not resubmit ${record.hash} unchanged: it is recorded on ledger ${status.ledger ?? 'unknown'} as failed. Inspect result codes and build a new transaction if appropriate.`;
  }
  if (status.error) {
    return `Do not resubmit ${record.hash} yet: its network status could not be verified (${status.error}).`;
  }
  if (sequence <= network) {
    return `Do not resubmit ${record.hash}: its sequence ${record.sequence} is already at or below the network sequence ${networkSequence}, but Horizon did not return the transaction. Investigate before using another sequence.`;
  }
  return `Transaction ${record.hash} was not found and sequence ${record.sequence} is still ahead of the network sequence. Keep it unresolved until its status can be checked again; do not allocate a replacement with the same sequence.`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Display
// ──────────────────────────────────────────────────────────────────────────────

export function formatSequenceReconciliationReport(report: SequenceReconciliationReport): string {
  const lines = [
    '=== Stellar Account Sequence Reconciliation ===',
    `Account: ${report.accountId}`,
    `Network sequence: ${report.networkSequence}`,
    `Network ledger: ${report.networkLedger ?? 'unknown'}`,
    `Retrieved at: ${report.retrievedAt}`,
    `Latest local allocation: ${report.latestLocalAllocatedSequence ?? '(none)'}`,
    `Next local sequence: ${report.nextLocalSequence}`,
    `Queued transactions: ${report.queuedTransactionCount}`,
    `Confirmed: ${report.confirmedTransactionCount}`,
    `Unresolved: ${report.unresolvedTransactionCount}`,
    `Failed: ${report.failedTransactionCount}`,
    `Reflected on-chain: ${report.reflectedOnChainCount}`,
    `Possibly rejected or consumed: ${report.possiblyRejectedCount}`,
    `Local ahead of network: ${report.localAheadOfNetwork}`,
    `Network ahead of local: ${report.networkAheadOfLocal}`,
    `Stale local state: ${report.staleLocalState}`,
    `Status: ${report.reconciliationStatus}`,
  ];

  lines.push('', 'Duplicate sequence allocations:');
  if (report.duplicateSequenceAllocations.length === 0) lines.push('  (none)');
  for (const duplicate of report.duplicateSequenceAllocations) {
    lines.push(`  ${duplicate.sequence}: ${duplicate.hashes.join(', ')}`);
  }

  lines.push('', 'Sequence gaps in the active local queue:');
  if (report.sequenceGaps.length === 0) lines.push('  (none)');
  else lines.push(`  ${report.sequenceGaps.join(', ')}`);

  lines.push('', 'Unresolved transactions:');
  if (report.unresolvedTransactions.length === 0) lines.push('  (none)');
  for (const transaction of report.unresolvedTransactions) {
    lines.push(
      `  ${transaction.hash} sequence=${transaction.sequence} status=${transaction.status}` +
        (transaction.error ? ` error=${transaction.error}` : ''),
    );
  }

  lines.push('', 'Recovery recommendations:');
  for (const recommendation of report.recoveryRecommendations) {
    lines.push(`  - ${recommendation}`);
  }

  if (report.requiresInvestigation.length > 0) {
    lines.push('', 'Requires investigation:');
    for (const hash of report.requiresInvestigation) lines.push(`  - ${hash}`);
  }

  lines.push('', 'Limitations:');
  for (const limitation of report.limitations) lines.push(`  - ${limitation}`);
  return lines.join('\n');
}

function wantsJson(value: boolean | string | undefined): boolean {
  return value === true || value === 'true' || process.env.JSON_OUTPUT === 'true';
}

function wantsStatusChecks(value: boolean | string | undefined): boolean {
  return value === true || value === 'true' || process.env.CHECK_PENDING_STATUSES === 'true';
}

// ──────────────────────────────────────────────────────────────────────────────
// Entry point
// ──────────────────────────────────────────────────────────────────────────────

export async function run(params: SequenceReconciliationParams = {}): Promise<void> {
  const horizonUrl = params.horizonUrl || process.env.HORIZON_URL || DEFAULT_HORIZON_URL;
  const accountId = params.accountId || process.env.ACCOUNT_ID || DEFAULT_ACCOUNT_ID;
  const queueFile = params.queueFile || process.env.SEQUENCE_QUEUE_FILE;
  const json = wantsJson(params.json);
  const checkStatuses = wantsStatusChecks(params.checkPendingStatuses);

  try {
    if (!isValidAccountId(accountId)) {
      throw new Error('accountId must be a valid Stellar G... public key.');
    }
    const server = new Horizon.Server(horizonUrl);
    const network = await fetchAccountSequence(server, accountId);
    const adapter: SequencePersistenceAdapter = queueFile
      ? new JsonFileSequencePersistence(queueFile)
      : new InMemorySequencePersistence();
    const tracker = await LocalSequenceTracker.restore(accountId, network.sequence, adapter);

    if (checkStatuses) {
      for (const record of tracker.records.filter(
        (entry) => entry.status !== 'confirmed' && entry.status !== 'failed',
      )) {
        const status = await checkTransactionStatus(server, record.hash);
        const updated = applyTransactionStatus(record, status);
        tracker.markStatus(updated.hash, updated.status, {
          ledger: updated.ledger,
          error: updated.error,
        });
        console.log(recommendTransactionRecovery(updated, status, network.sequence));
      }
    }

    const snapshot = tracker.snapshot();
    const report = reconcileSequenceState({
      accountId,
      networkSequence: network.sequence,
      networkLedger: network.ledger,
      retrievedAt: network.retrievedAt,
      records: snapshot.records,
      nextLocalSequence: snapshot.nextSequence,
      lastSynchronizedNetworkSequence: snapshot.networkSequence,
    });

    console.log(
      json ? JSON.stringify(report, null, 2) : formatSequenceReconciliationReport(report),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) console.log(JSON.stringify({ accountId, error: message }, null, 2));
    else console.error(`Could not reconcile account sequence state: ${message}`);
  }
}
