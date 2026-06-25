import { derivePriceBounds, readPoolShareBalance } from '../src/examples/08-liquidity-pools';

describe('Liquidity pool example helpers', () => {
  it('calculates slippage-based price boundaries', () => {
    const bounds = derivePriceBounds(1.5, 200);

    expect(bounds.minPrice).toBe('1.4700000');
    expect(bounds.maxPrice).toBe('1.5300000');
  });

  it('returns 0 share balance when pool shares are not found', () => {
    const balance = readPoolShareBalance(
      [
        {
          asset_type: 'native',
          balance: '100.0000000',
        },
      ],
      'pool-id-1',
    );

    expect(balance).toBe('0');
  });

  it('reads liquidity pool share balances correctly', () => {
    const balance = readPoolShareBalance(
      [
        {
          asset_type: 'liquidity_pool_shares',
          liquidity_pool_id: 'pool-id-1',
          balance: '42.1234567',
        },
      ],
      'pool-id-1',
    );

    expect(balance).toBe('42.1234567');
  });
});
