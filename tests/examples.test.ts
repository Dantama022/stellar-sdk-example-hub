import * as ex1 from '../src/examples/01-create-account';
import * as ex2 from '../src/examples/02-payment';
import * as ex3 from '../src/examples/03-create-trustline';
import * as ex4 from '../src/examples/04-multisig';
import * as ex5 from '../src/examples/05-soroban-invoke';
import * as ex7 from '../src/examples/07-claimable-balances';
import * as ex8 from '../src/examples/08-liquidity-pools';
import * as ex9 from '../src/examples/09-fee-bump';
import * as ex11 from '../src/examples/11-sponsored-reserves';
import * as ex12 from '../src/examples/12-asset-issuance';
import * as ex14 from '../src/examples/14-time-locked-escrow';
import * as ex16 from '../src/examples/16-batched-operations';
import * as ex17 from '../src/examples/17-offline-signing';
import * as ex18 from '../src/examples/18-soroban-errors';
import * as ex19 from '../src/examples/19-horizon-streaming';
import * as ex20 from '../src/examples/20-sep10-authentication';
import * as ex21 from '../src/examples/21-sep24-deposit-withdrawal';
import * as ex22 from '../src/examples/22-manage-buy-offer';
import * as ex23 from '../src/examples/23-manage-data-entries';
import * as ex24 from '../src/examples/24-create-passive-sell-offer';
import * as ex25 from '../src/examples/25-account-flags';
import * as ex26 from '../src/examples/26-sponsored-claimable-balance';
import { examples } from '../src/runner/catalog';

describe('Examples Exports', () => {
  it('should export a run function', () => {
    for (const mod of [
      ex1,
      ex2,
      ex3,
      ex4,
      ex5,
      ex7,
      ex8,
      ex9,
      ex11,
      ex12,
      ex14,
      ex16,
      ex17,
      ex18,
      ex19,
      ex20,
      ex21,
      ex22,
      ex23,
      ex24,
      ex25,
      ex26,
    ]) {
      expect(typeof mod.run).toBe('function');
    }
  });

  it('should register the examples in the catalog', () => {
    for (const key of [
      '07-claimable-balances',
      '08-liquidity-pools',
      '09-fee-bump',
      '11-sponsored-reserves',
      '14-time-locked-escrow',
      '16-batched-operations',
      '19-horizon-streaming',
      '20-sep10-authentication',
      '21-sep24-deposit-withdrawal',
      '22-manage-buy-offer',
      '23-manage-data-entries',
      '24-create-passive-sell-offer',
      '25-account-flags',
      '26-sponsored-claimable-balance',
    ]) {
      expect(examples[key]).toBeDefined();
    }
  });
});
