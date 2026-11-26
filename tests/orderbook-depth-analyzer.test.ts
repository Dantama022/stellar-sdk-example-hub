import { analyzeOrderbook, analyzeOrderbookData, calculateSide, parseAsset } from '../examples/orderbook-depth-analyzer/analyzer';
import type { Orderbook } from '../examples/orderbook-depth-analyzer/types';
const ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const opt = { network: 'testnet' as const, selling: 'native', buying: `USD:${ISSUER}` };
const book: Orderbook = { bids: [
  { price: '2.0000000', price_r: { n: 2, d: 1 }, amount: '3.0000000' },
  { price: '2.0000000', price_r: { n: 4, d: 2 }, amount: '2.0000000' },
  { price: '1.5000000', price_r: { n: 3, d: 2 }, amount: '1.0000000' },
], asks: [
  { price: '2.5000000', price_r: { n: 5, d: 2 }, amount: '4.0000000' },
  { price: '3.0000000', price_r: { n: 3, d: 1 }, amount: '2.0000000' },
] };

test('validates native and issued assets and keeps asset identity distinct', () => {
  expect(parseAsset('native').id).toBe('XLM');
  expect(parseAsset(`USDC:${ISSUER}`).type).toBe('credit_alphanum4');
  expect(() => parseAsset('USD:bad')).toThrow();
  expect(() => parseAsset('WAYTOOLONGASSETCODE:bad')).toThrow();
  expect(() => analyzeOrderbookData({ ...opt, buying: 'XLM' }, book)).toThrow(/different/);
});

test('calculates best prices, midpoint and exact absolute/percentage spread', () => {
  const report = analyzeOrderbookData(opt, book, '2026-11-23T10:00:00Z');
  expect(report.bestBid).toBe('2.0000000');
  expect(report.bestAsk).toBe('2.5000000');
  expect(report.spreadAbsolute).toBe('0.5000000');
  expect(report.midpoint).toBe('2.2500000');
  expect(report.spreadPercent).toBe('22.2222');
  expect(report.observedAt).toBe('2026-11-23T10:00:00Z');
});

test('aggregates duplicate prices, cumulative counter-side depth and gaps', () => {
  const report = analyzeOrderbookData({ ...opt, priceLimits: ['2.0000000', '2.5000000'] }, book);
  expect(report.bids.levels).toHaveLength(2);
  expect(report.bids.levels[0]).toMatchObject({ offerCount: 2, counterAmount: '5.0000000', cumulativeCounterAmount: '5.0000000' });
  expect(report.bids.totalCounterAmount).toBe('6.0000000');
  expect(report.bids.depthAtPrices[0].cumulativeCounterAmount).toBe('5.0000000');
  expect(report.asks.depthAtPrices[1].cumulativeCounterAmount).toBe('4.0000000');
  expect(report.bids.levels[1].gapFromPriorPercent).toBe('25.0000');
});

test('empty and one-sided books produce null spread without invented price', () => {
  expect(analyzeOrderbookData(opt, { bids: [], asks: [] }).spreadAbsolute).toBeNull();
  const oneSided = analyzeOrderbookData(opt, { bids: [], asks: book.asks });
  expect(oneSided.bestBid).toBeNull();
  expect(oneSided.warnings.join(' ')).toMatch(/empty/);
});

test('rejects malformed offers and keeps 7-decimal quantities exact', () => {
  expect(() => calculateSide([{ price: '0', price_r: { n: 0, d: 1 }, amount: '1' }], 'bids')).toThrow(/price_r/);
  expect(() => calculateSide([{ price: '1', price_r: { n: 1, d: 1 }, amount: '0.00000001' }], 'asks')).toThrow(/7-decimal/);
  const side = calculateSide([{ price: '1', price_r: { n: 1, d: 1 }, amount: '10000000000.1234567' }], 'asks');
  expect(side.totalCounterAmount).toBe('10000000000.1234567');
});

test('fetches supported Horizon orderbook parameters and serializes output', async () => {
  const fetcher = jest.fn(async (url: string) => {
    const params = new URL(url).searchParams;
    expect(params.get('selling_asset_type')).toBe('native');
    expect(params.get('buying_asset_type')).toBe('credit_alphanum4');
    expect(params.get('buying_asset_code')).toBe('USD');
    return { ok: true, json: async () => book } as Response;
  }) as unknown as typeof fetch;
  const report = await analyzeOrderbook({ ...opt, fetcher, limit: 10 });
  expect(JSON.parse(JSON.stringify(report)).bids.levels).toHaveLength(2);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test('Horizon network errors remain visible', async () => {
  const fetcher = jest.fn(async () => { throw new Error('timeout'); }) as unknown as typeof fetch;
  await expect(analyzeOrderbook({ ...opt, fetcher })).rejects.toThrow(/network failure/);
});
