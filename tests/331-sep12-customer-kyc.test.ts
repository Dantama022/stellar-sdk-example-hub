import { AnchorHttp, mockFetch } from '../src/examples/anchor-workflow-helpers';
import { demoClient, getCustomer, parseCustomer, putCustomer, SYNTHETIC_CUSTOMER } from '../src/examples/331-sep12-customer-kyc';

describe('SEP-12 mock KYC', () => {
  test('discovers requirements and submits only synthetic fields', async () => {
    const client = demoClient();
    const need = await getCustomer(client, { type: 'individual' });
    expect(need.status).toBe('NEEDS_INFO');
    expect(await putCustomer(client, need, SYNTHETIC_CUSTOMER, 'individual')).toBe('synthetic-customer-001');
  });
  test('rejects missing fields and malformed statuses', async () => {
    const need = await getCustomer(demoClient(), { type: 'individual' });
    await expect(putCustomer(demoClient(), need, { first_name: 'Demo' }, 'individual')).rejects.toThrow('last_name');
    expect(() => parseCustomer({ status: 'COMPLETE' })).toThrow('unsupported');
    expect(() => parseCustomer({ status: 'NEEDS_INFO' })).toThrow('without fields');
    expect(parseCustomer({ status: 'ACCEPTED', id: 'mock' }).status).toBe('ACCEPTED');
    expect(parseCustomer({ status: 'REJECTED' }).status).toBe('REJECTED');
    expect(parseCustomer({ status: 'PROCESSING' }).status).toBe('PROCESSING');
  });
  test('parses authentication failures without revealing customer data', async () => {
    const client = new AnchorHttp('https://mock.anchor.test', mockFetch({
      'GET /customer': { statusCode: 401, payload: { error: 'customer-secret' } },
    }));
    await expect(getCustomer(client, { type: 'individual' })).rejects.toThrow('HTTP 401');
    await expect(getCustomer(client, { type: 'individual' })).rejects.not.toThrow('customer-secret');
  });
});
