import {
  computeReconnectDelay,
  formatConnectionStatus,
} from '../src/examples/44-resilient-horizon-stream';
import {
  formatLedgerSummary,
  hasExceededReconnectLimit,
  isMalformedStreamRecord,
} from '../src/examples/158-resilient-horizon-streaming';

describe('Resilient Horizon stream helpers', () => {
  it('applies exponential backoff with a ceiling', () => {
    expect(computeReconnectDelay(1, 1000, 5000)).toBe(1000);
    expect(computeReconnectDelay(2, 1000, 5000)).toBe(2000);
    expect(computeReconnectDelay(3, 1000, 5000)).toBe(4000);
    expect(computeReconnectDelay(4, 1000, 5000)).toBe(5000);
  });

  it('formats connection status messages', () => {
    expect(formatConnectionStatus('connected', { cursor: 'now' })).toContain('cursor=now');
    expect(
      formatConnectionStatus('reconnecting', { cursor: '123', attempt: 2, delayMs: 4000 }),
    ).toContain('attempt 2');
  });

  it('validates ledger close records and formats useful metadata', () => {
    const ledger = {
      paging_token: '42',
      sequence: 42,
      closed_at: '2026-10-19T12:00:00Z',
    };

    expect(isMalformedStreamRecord(ledger, 'ledgers')).toBe(false);
    expect(isMalformedStreamRecord({ ...ledger, sequence: '42' }, 'ledgers')).toBe(true);
    expect(isMalformedStreamRecord({ ...ledger, closed_at: 'invalid' }, 'ledgers')).toBe(true);
    expect(formatLedgerSummary(42, ledger.closed_at, ledger.paging_token, 1)).toContain(
      'Sequence:      42',
    );
    expect(formatLedgerSummary(42, ledger.closed_at, ledger.paging_token, 1)).toContain(
      ledger.closed_at,
    );
  });

  it('stops after the configured number of reconnect attempts', () => {
    expect(hasExceededReconnectLimit(8, 8)).toBe(false);
    expect(hasExceededReconnectLimit(9, 8)).toBe(true);
  });
});
