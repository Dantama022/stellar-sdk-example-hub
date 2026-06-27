import * as ex1 from '../src/examples/01-create-account';
import * as ex2 from '../src/examples/02-payment';
import * as ex3 from '../src/examples/03-create-trustline';
import * as ex4 from '../src/examples/04-multisig';
import * as ex5 from '../src/examples/05-soroban-invoke';
import * as ex7 from '../src/examples/07-claimable-balances';
import * as ex9 from '../src/examples/09-fee-bump';
import * as ex8 from '../src/examples/08-liquidity-pools';
import * as ex11 from '../src/examples/11-sponsored-reserves';
import * as ex12 from '../src/examples/12-asset-issuance';
import * as ex14 from '../src/examples/14-time-locked-escrow';
import * as ex16 from '../src/examples/16-batched-operations';
import * as ex17 from '../src/examples/17-offline-signing';
import * as ex18 from '../src/examples/18-soroban-errors';
import * as ex20 from '../src/examples/20-sep10-authentication';
import * as ex21 from '../src/examples/21-sep24-deposit-withdrawal';
import { examples } from '../src/runner/catalog';
import * as ex19 from '../src/examples/19-horizon-streaming';

describe('Examples Exports', () => {
  it('should export a run function', () => {
    expect(typeof ex1.run).toBe('function');
    expect(typeof ex2.run).toBe('function');
    expect(typeof ex3.run).toBe('function');
    expect(typeof ex4.run).toBe('function');
    expect(typeof ex5.run).toBe('function');
    expect(typeof ex7.run).toBe('function');
    expect(typeof ex9.run).toBe('function');
    expect(typeof ex8.run).toBe('function');
    expect(typeof ex11.run).toBe('function');
    expect(typeof ex12.run).toBe('function');
    expect(typeof ex14.run).toBe('function');
    expect(typeof ex16.run).toBe('function');
    expect(typeof ex17.run).toBe('function');
    expect(typeof ex18.run).toBe('function');
    expect(typeof ex20.run).toBe('function');
    expect(typeof ex21.run).toBe('function');
    expect(typeof ex19.run).toBe('function');
  });

  it('should register the new examples in the catalog', () => {
    expect(examples['07-claimable-balances']).toBeDefined();
    expect(examples['09-fee-bump']).toBeDefined();
    expect(examples['14-time-locked-escrow']).toBeDefined();
    expect(examples['16-batched-operations']).toBeDefined();
    expect(examples['20-sep10-authentication']).toBeDefined();
  });
});
