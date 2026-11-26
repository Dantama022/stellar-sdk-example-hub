import { normalizeLedger, ledgerTiming, formatLocalTime } from '../examples/ledger-analysis/ledger-close-time';
import { retrieveTransactionTimestamps, RetrievalInterruptedError } from '../examples/ledger-analysis/transaction-timestamps';
import { HttpClient } from '../examples/_analysis/core';

const ledger = (sequence: number) => ({ sequence, closed_at: `2026-01-01T00:00:${(sequence - 10) * 5 + 10}Z`, transaction_count: 1 });
const tx = (ledgerNumber: number) => ({ hash: ledgerNumber.toString(16).padStart(64, '0'), ledger: ledgerNumber, created_at: ledger(ledgerNumber).closed_at, successful: true });

describe('ledger close time #571', () => {
  it('calculates intervals and preserves UTC timestamps', () => {
    const stats = ledgerTiming([normalizeLedger(ledger(12)), normalizeLedger(ledger(10)), normalizeLedger(ledger(11))]);
    expect(stats.intervalsSeconds).toEqual([5, 5]);
    expect(stats.averageIntervalSeconds).toBe('5.000');
    expect(stats.earliestCloseUtc).toBe('2026-01-01T00:00:10.000Z');
    expect(formatLocalTime(stats.earliestCloseUtc!, 'UTC')).toContain('2026');
    expect(() => normalizeLedger({ sequence: 1, closed_at: 'bad' })).toThrow();
  });
  it('pages, deduplicates, and returns a checkpoint after complete ledgers', async () => {
    const get = jest.fn(async (url: string) => {
      if (url.endsWith('/ledgers/10')) return ledger(10);
      if (url.endsWith('/ledgers/11')) return ledger(11);
      if (url.includes('/ledgers/10/transactions') && !url.includes('cursor=')) return { _embedded: { records: [tx(10)] }, _links: { next: { href: 'https://horizon-testnet.stellar.org/ledgers/10/transactions?cursor=1' } } };
      if (url.includes('/ledgers/10/transactions') && url.includes('cursor=')) return { _embedded: { records: [tx(10)] } };
      if (url.includes('/ledgers/11/transactions')) return { _embedded: { records: [tx(11)] } };
      throw new Error(`Unknown ${url}`);
    });
    const report = await retrieveTransactionTimestamps({ network: 'testnet', start: 10, end: 11 }, { get } as HttpClient);
    expect(report.transactionCount).toBe(2);
    expect(report.checkpoint.lastCompletedLedger).toBe(11);
    expect(report.timing.averageIntervalSeconds).toBe('5.000');
  });
  it('does not advance checkpoint when a later page fails', async () => {
    const get = async <T>(url: string): Promise<T> => {
      if (url.endsWith('/ledgers/10')) return ledger(10) as T;
      if (url.endsWith('/ledgers/11')) throw new Error('connection lost');
      return { _embedded: { records: [tx(10)] } } as T;
    };
    await expect(retrieveTransactionTimestamps({ network: 'testnet', start: 10, end: 11 }, { get }))
      .rejects.toMatchObject({ name: 'RetrievalInterruptedError', checkpoint: { lastCompletedLedger: 10 } });
    expect(new RetrievalInterruptedError({ lastCompletedLedger: 10 }, 'broken').checkpoint.lastCompletedLedger).toBe(10);
  });
  it('rejects invalid ranges, allows empty pages, supports resuming', async () => {
    const get = async <T>(url: string): Promise<T> => url.endsWith('/ledgers/11') ? ledger(11) as T : { _embedded: { records: [] } } as T;
    await expect(retrieveTransactionTimestamps({ network: 'testnet', start: 11, end: 10 }, { get })).rejects.toThrow();
    const report = await retrieveTransactionTimestamps({ network: 'testnet', start: 10, end: 11, resume: { lastCompletedLedger: 10 } }, { get });
    expect(report.transactionCount).toBe(0);
    expect(report.checkpoint.lastCompletedLedger).toBe(11);
  });
});
