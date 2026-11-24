import {
  analyzeObservations,
  detectStatusChange,
  findDuplicateIds,
  formatTextReport,
  isInvalidTransition,
  isPendingStatus,
  isTerminalStatus,
  normalizeSep6Transaction,
  toJson,
} from '../src/examples/411-sep-6-transaction-lifecycle-monitor';

const observe = (at: number, status: string, hash: string | null = 'a'.repeat(64)) => ({
  at,
  transaction: normalizeSep6Transaction({
    id: 'tx-1',
    type: 'withdrawal',
    status,
    updated_at: new Date(at).toISOString(),
    stellar_transaction_id: hash,
  }),
});

describe('Issue #411: SEP-6 lifecycle monitor', () => {
  it('interprets known, pending, unknown and terminal statuses', () => {
    expect(isPendingStatus('pending_anchor')).toBe(true);
    expect(isTerminalStatus('completed')).toBe(true);
    expect(isTerminalStatus('refunded')).toBe(true);
    expect(normalizeSep6Transaction({ id: '1', status: 'mystery' }).unknownStatus).toBe(true);
  });

  it('detects status changes and only flags clearly invalid transitions', () => {
    const first = observe(0, 'pending_anchor').transaction;
    const second = observe(1000, 'completed').transaction;
    expect(detectStatusChange(first, second)).toBe(true);
    expect(isInvalidTransition('pending_anchor', 'completed')).toBe(false);
    expect(isInvalidTransition('completed', 'pending_anchor')).toBe(true);
    expect(isInvalidTransition('error', 'completed')).toBe(true);
    expect(isInvalidTransition(null, 'unknown')).toBe(false);
  });

  it('stops monitoring after a terminal status', () => {
    const results = analyzeObservations('anchor', [observe(0, 'pending_stellar'), observe(1000, 'completed')], {
      staleThresholdMs: 500,
    });
    expect(results).toHaveLength(1);
    expect(results[0].result).toBe('completed');
    expect(results[0].completedMonitoring).toBe(true);
    expect(results[0].previousStatus).toBe('pending_stellar');
    expect(results[0].statusChanged).toBe(true);
  });

  it('identifies stale pending transactions using injected timestamps', () => {
    const results = analyzeObservations('anchor', [observe(0, 'pending_external'), observe(900000, 'pending_external')], {
      staleThresholdMs: 1000,
    });
    expect(results[0].stale).toBe(true);
    expect(results[0].anomalies).toContain('transaction stale in pending status');
    expect(results[0].result).toBe('stale-pending');
  });

  it('flags unknown statuses, failure statuses and missing Stellar hashes', () => {
    const unknown = analyzeObservations('anchor', [observe(0, 'mystery')])[0];
    expect(unknown.anomalies.join(' ')).toMatch(/unknown status/);
    const failed = analyzeObservations('anchor', [observe(0, 'error')])[0];
    expect(failed.result).toBe('failed');
    const noHash = analyzeObservations('anchor', [observe(0, 'completed', null)])[0];
    expect(noHash.anomalies).toContain('terminal status without a Stellar transaction hash');
    expect(noHash.onChain.status).toBe('no-hash');
  });

  it('counts bounded retrieval failures without losing records', () => {
    const results = analyzeObservations('anchor', [
      observe(0, 'pending_anchor'),
      { at: 1000, transaction: null, retrievalError: 'HTTP 503' },
      { at: 2000, transaction: null, retrievalError: 'HTTP 503' },
    ]);
    expect(results[0].retries).toBe(2);
    expect(results[0].retrievalErrors).toHaveLength(2);
  });

  it('detects duplicate identifiers and emits JSON reports', () => {
    const tx = observe(0, 'completed').transaction!;
    expect(findDuplicateIds([tx, tx])).toEqual(['tx-1']);
    const results = analyzeObservations('anchor', [observe(0, 'completed')], {
      onChain: { successful: true },
    });
    expect(results[0].onChain.status).toBe('verified');
    expect(formatTextReport(results)).toContain('SEP-6 Transaction Lifecycle Monitor');
    expect(JSON.parse(toJson(results))[0].transactionId).toBe('tx-1');
  });
});
