import {
  findCreatedClaimableBalanceId,
  getNativeBalance,
} from '../src/examples/26-sponsored-claimable-balance';
import { examples } from '../src/runner/catalog';

describe('Sponsored claimable balance helpers', () => {
  it('finds the created claimable balance id from Horizon effects', () => {
    const balanceId = findCreatedClaimableBalanceId([
      {
        type: 'account_credited',
      },
      {
        type: 'claimable_balance_created',
        balance_id: '00000000abc123',
      },
    ]);

    expect(balanceId).toBe('00000000abc123');
  });

  it('throws when no created claimable balance effect is present', () => {
    expect(() =>
      findCreatedClaimableBalanceId([
        {
          type: 'account_debited',
        },
      ]),
    ).toThrow('Unable to determine claimable balance ID');
  });

  it('extracts the native balance from Horizon balance records', () => {
    const nativeBalance = getNativeBalance([
      {
        asset_type: 'credit_alphanum4',
        balance: '25.0000000',
      },
      {
        asset_type: 'native',
        balance: '9999.5000000',
      },
    ]);

    expect(nativeBalance).toBe('9999.5000000');
  });

  it('registers the sponsored claimable balance example in the runner catalog', () => {
    expect(examples['26-sponsored-claimable-balance']).toBeDefined();
    expect(typeof examples['26-sponsored-claimable-balance'].run).toBe('function');
  });
});
