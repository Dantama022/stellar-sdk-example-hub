import {
  estimateFeeBid,
  parseFeeStatsSnapshot,
} from '../src/examples/259-transaction-fee-bid-analysis';
import { examples } from '../src/runner/catalog';

const stats = {
  last_ledger: '1000',
  last_ledger_base_fee: '100',
  min_accepted_fee: '100',
  p50_accepted_fee: '200',
  p90_accepted_fee: '500',
};

describe('259-transaction-fee-bid-analysis', () => {
  it('uses current fee stats and scales the bid by operation count', () => {
    const snapshot = parseFeeStatsSnapshot(stats, 1001);
    const estimate = estimateFeeBid(snapshot, 3, 'standard', 1000, 2);

    expect(estimate).toMatchObject({
      feePerOperation: 200,
      estimatedTotalFee: 600,
      operationCount: 3,
      statsLedger: 1000,
      latestLedger: 1001,
      ledgerLag: 1,
    });
  });

  it('uses the selected fee percentile while respecting the base fee', () => {
    const snapshot = parseFeeStatsSnapshot(stats, 1000);

    expect(estimateFeeBid(snapshot, 1, 'economy', 1000, 0).feePerOperation).toBe(100);
    expect(estimateFeeBid(snapshot, 1, 'priority', 1000, 0).feePerOperation).toBe(500);
  });

  it('rejects fee statistics older than the configured ledger-lag limit', () => {
    const snapshot = parseFeeStatsSnapshot(stats, 1004);

    expect(() => estimateFeeBid(snapshot, 1, 'standard', 1000, 2)).toThrow(/stale by 4 ledgers/);
  });

  it('rejects a bid above the maximum total fee instead of underbidding', () => {
    const snapshot = parseFeeStatsSnapshot(stats, 1000);

    expect(() => estimateFeeBid(snapshot, 3, 'priority', 1000, 0)).toThrow(
      /exceeds maxTotalFee 1000/,
    );
  });

  it('rejects invalid operation counts and malformed fee stats', () => {
    const snapshot = parseFeeStatsSnapshot(stats, 1000);

    expect(() => estimateFeeBid(snapshot, 0, 'standard', 1000, 0)).toThrow(/operationCount/);
    expect(() => parseFeeStatsSnapshot({ ...stats, p90_accepted_fee: 'unknown' }, 1000)).toThrow(
      /p90_accepted_fee/,
    );
  });

  it('is registered in the example catalog', () => {
    expect(examples['259-transaction-fee-bid-analysis']).toBeDefined();
    expect(typeof examples['259-transaction-fee-bid-analysis'].run).toBe('function');
  });
});