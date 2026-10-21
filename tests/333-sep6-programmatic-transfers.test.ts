import { AnchorHttp, mockFetch } from '../src/examples/anchor-workflow-helpers';
import { ProgrammaticTransferDemo, demoClient } from '../src/examples/333-sep6-programmatic-transfers';
const account = 'GACW7NONV43MZIFHCOKCQJAKSJSISSICFVUJ2C6EZIW5773OU3HD64VI';

describe('SEP-6 mock programmatic transfers', () => {
  test('deposit and withdrawal initiation without any real transfer', async () => {
    const demo = new ProgrammaticTransferDemo(demoClient());
    const info = await demo.info();
    expect((await demo.begin(info, 'deposit', 'USD', account, '10', 'SWIFT', 'deposit-one')).id).toBe('mock-sep6-deposit');
    expect((await demo.begin(info, 'withdraw', 'USD', account, '10', 'SWIFT', 'withdraw-one')).id).toBe('mock-sep6-withdraw');
    expect((await demo.status('mock-sep6-deposit')).category).toBe('pending');
    await expect(demo.begin(info, 'withdraw', 'USD', account, '10', 'SWIFT', 'withdraw-one')).rejects.toThrow('Duplicate');
  });
  test('rejects unsupported asset, method, malformed amount and required fields', async () => {
    const demo = new ProgrammaticTransferDemo(demoClient());
    const info = await demo.info();
    await expect(demo.begin(info, 'deposit', 'XXX', account, '10', 'SWIFT', 'a')).rejects.toThrow('unsupported');
    await expect(demo.begin(info, 'deposit', 'USD', account, '0', 'SWIFT', 'b')).rejects.toThrow('amount');
    await expect(demo.begin(info, 'withdraw', 'USD', account, '10', 'CASH', 'c')).rejects.toThrow('funding_method');
    await expect(demo.begin({ deposit: { USD: { funding_methods: ['SWIFT'], fields: { dest: { optional: false } } } } },
      'deposit', 'USD', account, '10', 'SWIFT', 'd')).rejects.toThrow('extra information');
  });
  test('accepts missing transaction ID and reports unknown status explicitly', async () => {
    const demo = new ProgrammaticTransferDemo(new AnchorHttp('https://mock.anchor.test', mockFetch({
      'GET /info': { deposit: { USD: { funding_methods: ['SWIFT'] } }, withdraw: {} },
      'GET /deposit': { how: 'synthetic instructions' },
      'GET /transaction': { id: 'x', status: 'other' },
    })));
    const info = await demo.info();
    expect((await demo.begin(info, 'deposit', 'USD', account, '10', 'SWIFT', 'once')).id).toBeUndefined();
    expect((await demo.status('x')).category).toBe('unknown');
  });
  test('sanitizes API errors and detects malformed JSON', async () => {
    const failing = new ProgrammaticTransferDemo(new AnchorHttp('https://mock.anchor.test', mockFetch({
      'GET /info': { statusCode: 500, payload: { token: 'private' } },
    })));
    await expect(failing.info()).rejects.toThrow('HTTP 500');
  });
});
