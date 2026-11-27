import { calculateQuote, canonicalAsset, retrievePool, Pool } from '../examples/liquidity-pools/swap-quote';
import { slippageScenarios } from '../examples/liquidity-pools/slippage-analysis';
import { HttpClient } from '../examples/_analysis/core';

const pool: Pool = {
  id: 'a'.repeat(64), fee_bp: 30,
  reserves: [{ asset: 'native', amount: '1000.0000000' }, { asset: 'USD:GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', amount: '1000.0000000' }],
};
describe('pool quote #570', () => {
  it('calculates both directions using the exact constant-product reference case', () => {
    const quote = calculateQuote(pool, 'testnet', 'native', '100.0000000', 100, '2026-01-01T00:00:00Z');
    expect(quote.estimatedOutput).toBe('90.6610893');
    expect(quote.minimumOutput).toBe('89.7544784');
    expect(quote.spotPriceOutputPerInput).toBe('1.0000000');
    expect(quote.feeBasisPoints).toBe(30);
    const reverse = calculateQuote(pool, 'testnet', pool.reserves[1].asset, '100.0000000');
    expect(reverse.outputAsset).toBe('native');
    expect(reverse.estimatedOutput).toBe(quote.estimatedOutput);
  });
  it('rejects bad inputs and missing reserves', () => {
    expect(() => canonicalAsset('USD:bad')).toThrow();
    expect(() => calculateQuote(pool, 'testnet', 'native', '0')).toThrow();
    expect(() => calculateQuote(pool, 'testnet', 'native', '0.00000001')).toThrow();
    expect(() => calculateQuote(pool, 'testnet', 'native', '1', -1)).toThrow();
    expect(() => calculateQuote({ ...pool, reserves: [{ ...pool.reserves[0], amount: '0' }, pool.reserves[1]] }, 'testnet', 'native', '1')).toThrow();
  });
  it('queries Horizon by the asset pair and reports a missing pool', async () => {
    const get = jest.fn(async (_url: string) => ({ _embedded: { records: [pool] } }));
    const found = await retrievePool('testnet', 'native', pool.reserves[1].asset, { get } as HttpClient);
    expect(found.id).toBe(pool.id);
    expect(get.mock.calls[0][0]).toContain('/liquidity_pools?');
    await expect(retrievePool('testnet', 'native', pool.reserves[1].asset,
      { get: async <T>() => ({ _embedded: { records: [] } } as T) })).rejects.toThrow('No matching');
  });
  it('models multiple slippage limits without floating point', () => {
    expect(slippageScenarios('1.0000000', [0, 50, 100])).toEqual([
      { toleranceBps: 0, minimumOutput: '1.0000000', reductionPercent: '0.00' },
      { toleranceBps: 50, minimumOutput: '0.9950000', reductionPercent: '0.50' },
      { toleranceBps: 100, minimumOutput: '0.9900000', reductionPercent: '1.00' },
    ]);
  });
});
