import { assertAccount, fromUnits, getJson, horizonEndpoint, multipliedDivided, percent, SCALE, toUnits } from '../_multi-analyzer/common';
import type { AssetSpec, Orderbook, OrderbookOptions, OrderbookReport, PriceLevel, RawOffer, SideReport } from './types';

export function parseAsset(spec: string): AssetSpec {
  if (spec === 'native' || spec === 'XLM') return { type: 'native', id: 'XLM' };
  const index = spec.indexOf(':');
  if (index < 1) throw new Error('Expected native or CODE:G... asset');
  const code = spec.slice(0, index); const issuer = spec.slice(index + 1);
  if (!/^[A-Za-z0-9]{1,12}$/.test(code)) throw new Error('Invalid Stellar asset code');
  assertAccount(issuer);
  return { type: code.length <= 4 ? 'credit_alphanum4' : 'credit_alphanum12', code, issuer, id: `${code}:${issuer}` };
}

function ratio(offer: RawOffer): { n: bigint; d: bigint; price: bigint; amount: bigint } {
  const n = BigInt(offer.price_r?.n ?? 0); const d = BigInt(offer.price_r?.d ?? 0);
  if (n <= 0n || d <= 0n) throw new Error('Invalid price_r ratio');
  const amount = toUnits(offer.amount);
  if (amount === 0n) throw new Error('Zero-size orderbook offer');
  const price = multipliedDivided(SCALE, n, d);
  if (price === 0n) throw new Error('Price is below 7-decimal display precision');
  return { n, d, price, amount };
}

/** Horizon order-book `amount` is denominated in counter asset on BOTH sides. */
export function calculateSide(offers: RawOffer[], side: 'bids' | 'asks', thresholds: string[] = []): SideReport {
  if (!Array.isArray(offers)) throw new Error('Missing order book offers');
  const items = offers.map(offer => ({ ...ratio(offer), offer }));
  items.sort((a, b) => {
    const left = a.n * b.d, right = b.n * a.d;
    return side === 'bids' ? (left > right ? -1 : left < right ? 1 : 0) : (left < right ? -1 : left > right ? 1 : 0);
  });
  const levels: PriceLevel[] = []; let totalCounter = 0n; let totalBase = 0n;
  let last: typeof items[number] | undefined;
  for (const item of items) {
    const base = multipliedDivided(item.amount, item.d, item.n);
    totalCounter += item.amount; totalBase += base;
    const exactSame = !!last && item.n * last.d === last.n * item.d;
    if (exactSame && levels.length) {
      const level = levels[levels.length - 1];
      level.counterAmount = fromUnits(toUnits(level.counterAmount) + item.amount);
      level.estimatedBaseAmount = fromUnits(toUnits(level.estimatedBaseAmount) + base);
      level.cumulativeCounterAmount = fromUnits(totalCounter);
      level.offerCount++;
    } else {
      let gapFromPriorPercent: string | null = null;
      if (last) {
        const a = item.n * last.d; const b = last.n * item.d;
        gapFromPriorPercent = percent(a > b ? a - b : b - a, b);
      }
      levels.push({ price: fromUnits(item.price), originalPrice: item.offer.price, priceRatio: { n: String(item.n), d: String(item.d) }, counterAmount: fromUnits(item.amount),
        cumulativeCounterAmount: fromUnits(totalCounter), estimatedBaseAmount: fromUnits(base),
        offerCount: 1, gapFromPriorPercent });
    }
    last = item;
  }
  const depthAtPrices = thresholds.map(threshold => {
    const t = toUnits(threshold);
    const cumulative = items.reduce((sum, offer) => {
      const eligible = side === 'bids' ? offer.n * SCALE >= t * offer.d : offer.n * SCALE <= t * offer.d;
      return sum + (eligible ? offer.amount : 0n);
    }, 0n);
    return { threshold, cumulativeCounterAmount: fromUnits(cumulative) };
  });
  return { levels, totalCounterAmount: fromUnits(totalCounter), totalEstimatedBaseAmount: fromUnits(totalBase), depthAtPrices };
}

export function analyzeOrderbookData(options: OrderbookOptions, book: Orderbook, observedAt = new Date().toISOString()): OrderbookReport {
  const selling = parseAsset(options.selling); const buying = parseAsset(options.buying);
  if (selling.id === buying.id) throw new Error('Both assets of an orderbook pair must be different');
  const thresholds = options.priceLimits ?? [];
  if (thresholds.length > 20) throw new Error('At most 20 price thresholds');
  thresholds.forEach(toUnits);
  const bids = calculateSide(book.bids, 'bids', thresholds);
  const asks = calculateSide(book.asks, 'asks', thresholds);
  const bestBid = bids.levels[0] ? toUnits(bids.levels[0].price) : null;
  const bestAsk = asks.levels[0] ? toUnits(asks.levels[0].price) : null;
  const warnings: string[] = [];
  if (bestBid === null || bestAsk === null) warnings.push('One or both orderbook sides are empty; spread and midpoint are undefined');
  if (bestBid !== null && bestAsk !== null && bestAsk < bestBid) warnings.push('Crossed order book observed; check data freshness');
  let spreadAbsolute: string | null = null; let spreadPercent: string | null = null; let midpoint: string | null = null;
  if (bestBid !== null && bestAsk !== null) {
    spreadAbsolute = fromUnits(bestAsk - bestBid);
    midpoint = fromUnits((bestAsk + bestBid + 1n) / 2n);
    spreadPercent = percent((bestAsk - bestBid) * 2n, bestAsk + bestBid);
  }
  return { network: options.network, selling: selling.id, buying: buying.id, observedAt,
    units: `Prices: ${buying.id} per ${selling.id}; Horizon bid/ask amounts and cumulative depth: ${buying.id} (counter asset); estimated base equivalents: ${selling.id}`,
    bestBid: bestBid === null ? null : fromUnits(bestBid),
    bestAsk: bestAsk === null ? null : fromUnits(bestAsk),
    spreadAbsolute, spreadPercent, midpoint, bids, asks, warnings,
    interpretation: 'Read-only orderbook snapshot. Advertised offer liquidity, not guaranteed execution volume or executable trade price.',
  };
}

export async function analyzeOrderbook(options: OrderbookOptions): Promise<OrderbookReport> {
  const selling = parseAsset(options.selling), buying = parseAsset(options.buying);
  if (selling.id === buying.id) throw new Error('Invalid identical asset pair');
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('Orderbook limit must be 1..200');
  const params = new URLSearchParams({ selling_asset_type: selling.type, buying_asset_type: buying.type, limit: String(limit) });
  if (selling.code && selling.issuer) { params.set('selling_asset_code', selling.code); params.set('selling_asset_issuer', selling.issuer); }
  if (buying.code && buying.issuer) { params.set('buying_asset_code', buying.code); params.set('buying_asset_issuer', buying.issuer); }
  const horizon = horizonEndpoint(options.network, options.horizonUrl);
  const observedAt = new Date().toISOString();
  const book = await getJson<Orderbook>(horizon, `/order_book?${params}`, options.fetcher);
  return analyzeOrderbookData(options, book, observedAt);
}
