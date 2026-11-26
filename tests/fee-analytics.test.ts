import { analyzeFees, normalizeTransaction, parseStroops, retrieveFeeReport } from '../examples/fee-analytics/transaction-fee-analysis';
import { feeDistribution, feeStats, feesByLedger } from '../examples/fee-analytics/ledger-fee-summary';
import { HttpClient } from '../examples/_analysis/core';
const row = (n: number, ledger = 10, fee: string | number = 100) => ({ hash: n.toString(16).padStart(64, '0'), ledger, fee_charged: fee, max_fee: 300 });

describe('transaction fee analytics #572', () => {
  it('uses actual charged fees, not bids, and deduplicates hashes', () => {
    const report = analyzeFees('testnet', 10, 11, [row(1,10,100),row(2,10,200),row(3,11,300),row(2,10,200)]);
    expect(report.statistics).toMatchObject({ count: 3, totalStroops: '600', totalXlm: '0.0000600', averageStroops: '200.0000', medianStroops: '200', minStroops: '100', maxStroops: '300' });
    expect(report.ledgers.map((l) => l.changeFromPreviousTotalStroops)).toEqual([null,'0']);
    expect(report.distribution[1].count).toBe(3);
    expect(report.transactions[0].feeBidStroops).toBe('300');
  });
  it('handles empty, even, invalid and very large fees exactly', () => {
    expect(feeStats([]).medianStroops).toBeNull();
    const rows = [normalizeTransaction(row(1,10,'100')), normalizeTransaction(row(2,10,'101'))];
    expect(feeStats(rows).medianStroops).toBe('100.5');
    expect(parseStroops('900719925474099312345')).toBe(900719925474099312345n);
    expect(() => parseStroops(-3)).toThrow();
    expect(() => parseStroops(1.5)).toThrow();
    expect(() => normalizeTransaction({ ...row(1), fee_charged: undefined })).toThrow();
    expect(() => feeDistribution(rows, [{ name: 'bad', minStroops: 0n, maxStroops: 100n }])).toThrow();
    expect(feesByLedger(rows)).toHaveLength(1);
  });
  it('retrieves across ledgers and handles pagination errors', async () => {
    const get = jest.fn(async (url: string) => ({ _embedded: { records: url.includes('/10/') ? [row(1)] : [row(2,11)] } }));
    const report = await retrieveFeeReport({ network: 'testnet', start: 10, end: 11 }, { get } as HttpClient);
    expect(report.statistics.count).toBe(2);
    expect(get).toHaveBeenCalledTimes(2);
    await expect(retrieveFeeReport({ network: 'testnet', start: 10, end: 10 },
      { get: async () => { throw new Error('timeout'); } })).rejects.toThrow('timeout');
  });
});
