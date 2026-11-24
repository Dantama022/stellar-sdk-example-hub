import { Horizon } from '@stellar/stellar-sdk';
import {
  InMemorySequencePersistence,
  JsonFileSequencePersistence,
  LocalSequenceTracker,
  applyTransactionStatus,
  checkTransactionStatus,
  fetchAccountSequence,
  formatSequenceReconciliationReport,
  nextSequence,
  parseSequence,
  reconcileSequenceState,
  recommendTransactionRecovery,
  type QueuedTransactionRecord,
  type TransactionStatusResult,
} from '../src/examples/264-sequence-reconciliation';
import { examples } from '../src/runner/catalog';

const ACCOUNT = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

function record(
  sequence: string,
  status: QueuedTransactionRecord['status'],
  hash = `hash-${sequence}`,
): QueuedTransactionRecord {
  return {
    hash,
    sequence,
    status,
    createdAt: '2026-01-02T03:04:05.000Z',
    updatedAt: '2026-01-02T03:04:05.000Z',
    ledger: status === 'confirmed' ? 100 : null,
    error: null,
    metadata: {},
  };
}

describe('264-sequence-reconciliation: account sequence retrieval', () => {
  it('retrieves and validates the current account sequence', async () => {
    const server = {
      loadAccount: jest.fn().mockResolvedValue({
        sequenceNumber: () => '123456789012345678',
        last_modified_ledger: 99,
      }),
    } as unknown as Horizon.Server;
    const state = await fetchAccountSequence(server, ACCOUNT);
    expect(state.sequence).toBe('123456789012345678');
    expect(state.ledger).toBe(99);
    expect(state.accountId).toBe(ACCOUNT);
  });

  it('propagates account-not-found and Horizon failures', async () => {
    const server = {
      loadAccount: jest.fn().mockRejectedValue(new Error('Account not found')),
    } as unknown as Horizon.Server;
    await expect(fetchAccountSequence(server, ACCOUNT)).rejects.toThrow(/Account not found/);
    await expect(fetchAccountSequence(server, 'not-an-account')).rejects.toThrow(/valid Stellar/);
  });

  it('uses BigInt sequence arithmetic', () => {
    expect(nextSequence('9007199254740993')).toBe('9007199254740994');
    expect(parseSequence('001')).toBe(1n);
    expect(() => parseSequence('-1')).toThrow(/non-negative integer/);
  });
});

describe('264-sequence-reconciliation: local allocation', () => {
  it('allocates consecutive sequences synchronously', () => {
    const tracker = new LocalSequenceTracker(ACCOUNT, '100');
    expect(tracker.allocate().sequence).toBe('101');
    expect(tracker.allocate().sequence).toBe('102');
    expect(tracker.allocate().sequence).toBe('103');
    expect(tracker.nextAvailableSequence).toBe('104');
  });

  it('does not duplicate sequence numbers during repeated allocations', () => {
    const tracker = new LocalSequenceTracker(ACCOUNT, '500');
    const allocations = Array.from({ length: 50 }, () => tracker.allocate());
    const sequences = new Set(allocations.map((allocation) => allocation.sequence));
    expect(sequences.size).toBe(50);
    expect(tracker.nextAvailableSequence).toBe('551');
  });

  it('rejects duplicate hash and sequence records', () => {
    const tracker = new LocalSequenceTracker(ACCOUNT, '100');
    tracker.record(record('101', 'submitted', 'same-hash'));
    expect(() => tracker.record(record('102', 'submitted', 'same-hash'))).toThrow(
      /already tracked/,
    );
    expect(() => tracker.record(record('101', 'submitted', 'other-hash'))).toThrow(
      /already allocated/,
    );
  });

  it('tracks consecutive transactions and status transitions', () => {
    const tracker = new LocalSequenceTracker(ACCOUNT, '10');
    const first = tracker.allocate({ hash: 'first' });
    const second = tracker.allocate({ hash: 'second' });
    tracker.markStatus(first.hash, 'signed');
    tracker.markStatus(first.hash, 'submitted');
    tracker.markStatus(first.hash, 'confirmed', { ledger: 11 });
    expect(tracker.records.find((entry) => entry.hash === 'first')?.status).toBe('confirmed');
    expect(tracker.records.find((entry) => entry.hash === 'second')?.sequence).toBe(
      second.sequence,
    );
  });

  it('detects duplicate allocations restored from external state', () => {
    const tracker = new LocalSequenceTracker(ACCOUNT, '10');
    const state = {
      accountId: ACCOUNT,
      networkSequence: '10',
      nextSequence: '13',
      records: [record('11', 'submitted', 'a'), record('11', 'submitted', 'b')],
    };
    const restored = new LocalSequenceTracker(ACCOUNT, '10', state);
    expect(restored.findDuplicateAllocations()).toEqual([{ sequence: '11', hashes: ['a', 'b'] }]);
  });
});

describe('264-sequence-reconciliation: network reconciliation', () => {
  it('reports a consistent empty queue', () => {
    const report = reconcileSequenceState({
      accountId: ACCOUNT,
      networkSequence: '100',
      records: [],
      nextLocalSequence: '101',
    });
    expect(report.reconciliationStatus).toBe('consistent');
    expect(report.latestLocalAllocatedSequence).toBeNull();
    expect(report.nextLocalSequence).toBe('101');
  });

  it('reconciles confirmed and failed transactions', () => {
    const report = reconcileSequenceState({
      accountId: ACCOUNT,
      networkSequence: '102',
      records: [record('101', 'confirmed'), record('102', 'failed')],
      nextLocalSequence: '103',
    });
    expect(report.confirmedTransactionCount).toBe(1);
    expect(report.failedTransactionCount).toBe(1);
    expect(report.reflectedOnChainCount).toBe(2);
    expect(report.possiblyRejectedCount).toBe(0);
    expect(report.reconciliationStatus).toBe('consistent');
  });

  it('keeps unresolved transactions and recommends status checks', () => {
    const report = reconcileSequenceState({
      accountId: ACCOUNT,
      networkSequence: '100',
      records: [record('101', 'submitted')],
      nextLocalSequence: '102',
    });
    expect(report.unresolvedTransactionCount).toBe(1);
    expect(report.reconciliationStatus).toBe('unresolved');
    expect(report.recoveryRecommendations.join(' ')).toContain('Query Horizon transaction status');
  });

  it('detects local tracker ahead of and behind the network', () => {
    const ahead = reconcileSequenceState({
      accountId: ACCOUNT,
      networkSequence: '100',
      records: [record('101', 'submitted'), record('102', 'allocated')],
      nextLocalSequence: '103',
    });
    expect(ahead.localAheadOfNetwork).toBe(true);
    expect(ahead.networkAheadOfLocal).toBe(false);

    const behind = reconcileSequenceState({
      accountId: ACCOUNT,
      networkSequence: '105',
      records: [record('101', 'confirmed')],
      nextLocalSequence: '102',
    });
    expect(behind.networkAheadOfLocal).toBe(true);
    expect(behind.staleLocalState).toBe(true);
    expect(behind.reconciliationStatus).toBe('needs_refresh');
  });

  it('detects duplicate allocations, ordering conflicts, and sequence gaps', () => {
    const report = reconcileSequenceState({
      accountId: ACCOUNT,
      networkSequence: '100',
      records: [
        record('101', 'submitted', 'a'),
        record('101', 'submitted', 'b'),
        record('103', 'allocated', 'c'),
      ],
      nextLocalSequence: '105',
    });
    expect(report.duplicateSequenceAllocations).toHaveLength(1);
    expect(report.sequenceGaps).toEqual(['102', '104']);
    expect(report.reconciliationStatus).toBe('conflict');
    expect(report.requiresInvestigation).toContain('a');
  });

  it('detects a stale local synchronization baseline', () => {
    const report = reconcileSequenceState({
      accountId: ACCOUNT,
      networkSequence: '110',
      records: [record('111', 'allocated')],
      nextLocalSequence: '112',
      lastSynchronizedNetworkSequence: '105',
    });
    expect(report.staleLocalState).toBe(true);
    expect(report.reconciliationStatus).toBe('needs_refresh');
  });
});

describe('264-sequence-reconciliation: persistence and retry safety', () => {
  it('restores an in-memory tracker after a simulated restart', async () => {
    const persistence = new InMemorySequencePersistence();
    const tracker = new LocalSequenceTracker(ACCOUNT, '100');
    tracker.allocate({ hash: 'pending' });
    await tracker.persist(persistence);

    const restored = await LocalSequenceTracker.restore(ACCOUNT, '101', persistence);
    expect(restored.nextAvailableSequence).toBe('102');
    expect(restored.records[0].hash).toBe('pending');
  });

  it('saves and loads state through the JSON file adapter', async () => {
    const file = '/tmp/opencode/sequence-tracker-test.json';
    const persistence = new JsonFileSequencePersistence(file);
    const tracker = new LocalSequenceTracker(ACCOUNT, '200');
    tracker.allocate({ hash: 'persisted' });
    await tracker.persist(persistence);

    const loaded = await persistence.load();
    expect(loaded?.nextSequence).toBe('202');
    expect(loaded?.records[0].hash).toBe('persisted');
  });

  it('checks network status before recommending resubmission', async () => {
    const server = {
      transactions: () => ({
        transaction: () => ({
          call: jest.fn().mockResolvedValue({ successful: true, ledger: 50 }),
        }),
      }),
    } as unknown as Horizon.Server;
    const status = await checkTransactionStatus(server, 'abc');
    expect(status.found).toBe(true);
    expect(status.successful).toBe(true);

    const updated = applyTransactionStatus(record('101', 'submitted'), status);
    expect(updated.status).toBe('confirmed');
    expect(recommendTransactionRecovery(updated, status, '100')).toContain('Do not resubmit');
  });

  it('treats a 404 transaction lookup as unresolved and blocks reuse', async () => {
    const server = {
      transactions: () => ({
        transaction: () => ({
          call: jest.fn().mockRejectedValue({ response: { status: 404 } }),
        }),
      }),
    } as unknown as Horizon.Server;
    const status: TransactionStatusResult = await checkTransactionStatus(server, 'missing');
    expect(status.found).toBe(false);
    const updated = applyTransactionStatus(record('101', 'submitted'), status);
    expect(updated.status).toBe('unresolved');

    expect(recommendTransactionRecovery(updated, status, '100')).toContain(
      'Keep it unresolved',
    );
  });

  it('formats a reconciliation report and serializes it as JSON', () => {
    const report = reconcileSequenceState({
      accountId: ACCOUNT,
      networkSequence: '100',
      records: [record('101', 'submitted')],
      nextLocalSequence: '102',
    });
    expect(formatSequenceReconciliationReport(report)).toContain('Status: unresolved');
    const json = JSON.parse(JSON.stringify(report));
    expect(json.accountId).toBe(ACCOUNT);
    expect(json.unresolvedTransactionCount).toBe(1);
  });

  it('is registered as a runnable example', () => {
    expect(examples['264-sequence-reconciliation']).toBeDefined();
    expect(typeof examples['264-sequence-reconciliation'].run).toBe('function');
  });
});
