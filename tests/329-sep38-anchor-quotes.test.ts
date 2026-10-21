import { checkAsset, parsePrice, parseQuote, PriceRequest, Sep38Client, validatePriceRequest, validateSep38Url } from '../src/examples/329-sep38-anchor-quotes';

const request: PriceRequest = { sell_asset: 'iso4217:USD', buy_asset: 'stellar:native', sell_amount: '10', context: 'sep24' };
const price = { ...request, sell_amount: '10', buy_amount: '20', price: '0.5' };
const quote = { ...price, id: 'q123', expires_at: '2030-01-01T00:00:00Z' };
const mock = (handler: (url: string, init?: RequestInit) => unknown): typeof fetch => jest.fn(async (url: string, init?: RequestInit) => ({ ok: true, json: async () => handler(url, init) })) as unknown as typeof fetch;

test('validates strict decimal amounts, assets and context', () => {
  expect(validatePriceRequest(request)).toEqual(request);
  expect(() => checkAsset('wrong')).toThrow();
  expect(() => validatePriceRequest({ ...request, sell_amount: '1e8' })).toThrow('decimal');
  expect(() => validatePriceRequest({ ...request, buy_amount: '5' })).toThrow('exactly one');
  expect(() => validatePriceRequest({ ...request, sell_amount: '-1' })).toThrow('decimal');
  expect(() => validateSep38Url('https://secret:secret@example.org/quote')).toThrow('credentials');
});
test('validates prices and expiration without floating-point calculations', () => {
  expect(parsePrice(price, request).price).toBe('0.5');
  expect(parseQuote(quote, request, Date.parse('2029-01-01')).id).toBe('q123');
  expect(() => parseQuote(quote, request, Date.parse('2031-01-01'))).toThrow('expired');
  expect(() => parsePrice({ ...price, price: 'not-a-number' }, request)).toThrow('price');
  expect(() => parsePrice({ ...price, buy_asset: 'iso4217:EUR' }, request)).toThrow('mismatch');
});
test('discovers assets and constructs indicative and firm requests', async () => {
  const calls = mock((url, init) => url.endsWith('/info') ? { assets: [{asset: 'iso4217:USD'}] } : init?.method === 'POST' ? quote : price);
  const api = new Sep38Client({ baseUrl: 'https://test.example.org/sep38/' }, calls);
  await expect(api.info()).resolves.toEqual({assets: [{asset: 'iso4217:USD'}]});
  await expect(api.indicative(request)).resolves.toMatchObject({price: '0.5'});
  await expect(api.firm(request, Date.parse('2029-01-01'))).resolves.toMatchObject({id: 'q123'});
  expect(calls).toHaveBeenCalledTimes(3);
  const urls = (calls as jest.Mock).mock.calls.map(([url]) => String(url));
  expect(urls[1]).toContain('sell_amount=10');
  expect(urls[2]).toContain('/quote');
});
test('redacts failed HTTP requests and handles malformed JSON', async () => {
  const bad = jest.fn(async () => ({ok: false, status: 429})) as unknown as typeof fetch;
  await expect(new Sep38Client({ baseUrl:'https://api.example.org/', token:'private' }, bad).info()).rejects.toThrow('HTTP 429');
  const corrupt = jest.fn(async () => ({ok: true, json: async () => {throw new Error('token=private');}})) as unknown as typeof fetch;
  await expect(new Sep38Client({ baseUrl:'https://api.example.org/' }, corrupt).info()).rejects.toThrow('invalid JSON');
});
