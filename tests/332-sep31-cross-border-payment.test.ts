import { AnchorHttp, mockFetch } from '../src/examples/anchor-workflow-helpers';
import { CrossBorderDemo, demoClient, PaymentRequest } from '../src/examples/332-sep31-cross-border-payment';
const request: PaymentRequest = { asset_code: 'USDC', amount: 10, funding_method: 'SWIFT' };

describe('SEP-31 mocked receiving anchor', () => {
  test('discovers, creates exactly one record and interprets pending', async () => {
    const demo = new CrossBorderDemo(demoClient());
    const info = await demo.info();
    const id = await demo.create(info, request, 'local-1');
    expect(id).toBe('mock-payment-001');
    expect((await demo.getStatus(id)).category).toBe('pending');
    await expect(demo.create(info, request, 'local-1')).rejects.toThrow('Duplicate');
  });
  test('rejects unsupported assets, methods, amount and SEP-12 requirements', async () => {
    const demo = new CrossBorderDemo(demoClient());
    const info = await demo.info();
    await expect(demo.create(info, { ...request, asset_code: 'EUR' }, 'a')).rejects.toThrow('unsupported');
    await expect(demo.create(info, { ...request, funding_method: 'CASH' }, 'b')).rejects.toThrow('funding_method');
    await expect(demo.create(info, { ...request, amount: -1 }, 'c')).rejects.toThrow('amount');
    await expect(demo.create({ receive: { USDC: { funding_methods: ['SWIFT'],
      sep12: { sender: { types: { individual: {} } } } } } }, request, 'd')).rejects.toThrow('sender_id');
  });
  test('treats malformed, service error and unknown statuses safely', async () => {
    const error = new CrossBorderDemo(new AnchorHttp('https://mock.anchor.test', mockFetch({
      'GET /info': { statusCode: 503, payload: { token: 'must-not-print' } },
    })));
    await expect(error.info()).rejects.toThrow('HTTP 503');
    const unknown = new CrossBorderDemo(new AnchorHttp('https://mock.anchor.test', mockFetch({
      'GET /transactions/x': { transaction: { id: 'x', status: 'new_from_anchor' } },
    })));
    expect((await unknown.getStatus('x')).category).toBe('unknown');
  });
});
