import { AnchorHttp, mockFetch, statusCategory } from '../src/examples/anchor-workflow-helpers';
import { demoClient, discover, initiate, parseInteractive, track } from '../src/examples/330-sep24-interactive-transfers';
const account = 'GACW7NONV43MZIFHCOKCQJAKSJSISSICFVUJ2C6EZIW5773OU3HD64VI';

describe('SEP-24 read-only interactive flow', () => {
  test('discover, initiate deposit and track pending state', async () => {
    const client = demoClient();
    const info = await discover(client);
    expect((await initiate(client, info, 'deposit', 'USD', account, '10')).id).toBe('demo-deposit');
    expect((await track(client, 'demo-deposit')).category).toBe('pending');
  });
  test('withdrawal uses separate endpoint and validates asset', async () => {
    const client = demoClient();
    const info = await discover(client);
    expect((await initiate(client, info, 'withdraw', 'USD', account, '10')).id).toBe('demo-withdraw');
    await expect(initiate(client, info, 'deposit', 'NOT_SUPPORTED', account, '10')).rejects.toThrow('unsupported');
  });
  test('reject invalid amount and unsafe or missing interactive URLs', async () => {
    const client = demoClient();
    const info = await discover(client);
    await expect(initiate(client, info, 'deposit', 'USD', account, '0')).rejects.toThrow('amount');
    expect(() => parseInteractive({ type: 'interactive_customer_info_needed', id: 'x', url: 'javascript:alert(1)' })).toThrow();
    expect(() => parseInteractive({ type: 'interactive_customer_info_needed', id: 'x' })).toThrow();
  });
  test('understands completed, failed and unknown states', () => {
    expect(statusCategory('completed')).toBe('complete');
    expect(statusCategory('error')).toBe('failed');
    expect(statusCategory('new_anchor_status')).toBe('unknown');
  });
  test('HTTP errors, malformed JSON and transaction ID mismatches', async () => {
    const errorClient = new AnchorHttp('https://mock.anchor.test', mockFetch({ 'GET /transaction': { statusCode: 503, payload: { error: 'secret' } } }));
    await expect(track(errorClient, 'x')).rejects.toThrow('HTTP 503');
    const mismatch = new AnchorHttp('https://mock.anchor.test', mockFetch({
      'GET /transaction': { id: 'different-id', status: 'completed' },
    }));
    await expect(track(mismatch, 'another-id')).rejects.toThrow('mismatch');
    const malformed = new AnchorHttp('https://mock.anchor.test', (async () => new Response('not-json')) as typeof fetch);
    await expect(discover(malformed)).rejects.toThrow('malformed JSON');
  });
  test('times out without printing service credentials', async () => {
    const hanging: typeof fetch = ((_: string | URL | Request, opts?: RequestInit) =>
      new Promise<Response>((_, reject) => opts?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
    ) as typeof fetch;
    const client = new AnchorHttp('https://mock.anchor.test', hanging, 'private-jwt', 2);
    await expect(discover(client)).rejects.toThrow('timed out');
  });
});
