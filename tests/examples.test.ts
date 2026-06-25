import * as ex1 from '../src/examples/01-create-account';
import * as ex2 from '../src/examples/02-payment';
import * as ex3 from '../src/examples/03-create-trustline';
import * as ex4 from '../src/examples/04-multisig';
import * as ex5 from '../src/examples/05-soroban-invoke';
import * as ex8 from '../src/examples/08-liquidity-pools';
import * as ex11 from '../src/examples/11-sponsored-reserves';
import * as ex12 from '../src/examples/12-asset-issuance';
import * as ex17 from '../src/examples/17-offline-signing';
import * as ex18 from '../src/examples/18-soroban-errors';

describe('Examples Exports', () => {
  it('should export a run function', () => {
    expect(typeof ex1.run).toBe('function');
    expect(typeof ex2.run).toBe('function');
    expect(typeof ex3.run).toBe('function');
    expect(typeof ex4.run).toBe('function');
    expect(typeof ex5.run).toBe('function');
    expect(typeof ex8.run).toBe('function');
    expect(typeof ex11.run).toBe('function');
    expect(typeof ex12.run).toBe('function');
    expect(typeof ex17.run).toBe('function');
    expect(typeof ex18.run).toBe('function');
  });
});
