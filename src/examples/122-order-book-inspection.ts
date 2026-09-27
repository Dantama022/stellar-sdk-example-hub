import { Asset, Horizon } from '@stellar/stellar-sdk';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const DEFAULT_DEPTH = 10;
const MAX_DEPTH = 200;

export interface OrderBookParams {
  sellingAsset?: string;
  buyingAsset?: string;
  depth?: string | number;
  horizonUrl?: string;
  json?: boolean | string;
}

export interface RawOrderBookLevel {
  price?: string;
  amount?: string;
  price_r?: { n?: number | string; d?: number | string };
}

export interface OrderBookLevel {
  price: number;
  amount: number;
  counterValue: number;
}

export interface OrderBookAnalysis {
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  midMarketPrice: number | null;
  spreadPercentage: number | null;
  bidQuantity: number;
  askQuantity: number;
  bidPriceLevels: number;
  askPriceLevels: number;
  priceLevels: number;
  totalBidLiquidity: number;
  totalAskLiquidity: number;
  totalBidCounterValue: number;
  totalAskCounterValue: number;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
}

export interface RawOrderBookResponse {
  bids?: RawOrderBookLevel[];
  asks?: RawOrderBookLevel[];
}

function wantsJson(params: OrderBookParams): boolean {
  return (
    params.json === true ||
    params.json === 'true' ||
    process.env.JSON_OUTPUT === 'true' ||
    process.argv.includes('--json')
  );
}

export function normalizeDepth(value?: string | number): number {
  const parsed = typeof value === 'string' ? Number.parseInt(value.trim(), 10) : value;
  if (parsed === undefined || parsed === null || !Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_DEPTH;
  }
  return Math.min(Math.trunc(parsed), MAX_DEPTH);
}

export function parseTradingAsset(value: string, label = 'asset'): Asset {
  const input = value.trim();
  if (!input) {
    throw new Error(`Missing ${label}. Use "native" or "CODE:ISSUER".`);
  }
  if (input.toLowerCase() === 'native' || input.toUpperCase() === 'XLM') {
    return Asset.native();
  }

  const separator = input.indexOf(':');
  if (separator <= 0 || separator === input.length - 1) {
    throw new Error(`Invalid ${label} "${input}". Issued assets require CODE:ISSUER.`);
  }

  try {
    return new Asset(input.slice(0, separator).trim(), input.slice(separator + 1).trim());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${label} "${input}": ${message}`);
  }
}

export function describeTradingAsset(asset: Asset): string {
  return asset.isNative() ? 'XLM' : `${asset.getCode()}:${asset.getIssuer()}`;
}

export function parseOrderBookLevel(level: RawOrderBookLevel): OrderBookLevel {
  const numerator = Number(level.price_r?.n);
  const denominator = Number(level.price_r?.d);
  const rationalPrice =
    Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0
      ? numerator / denominator
      : Number.NaN;
  const decimalPrice = Number.parseFloat(level.price ?? '0');
  const price = Number.isFinite(rationalPrice)
    ? rationalPrice
    : Number.isFinite(decimalPrice)
      ? decimalPrice
      : 0;
  const amountValue = Number.parseFloat(level.amount ?? '0');
  const amount = Number.isFinite(amountValue) ? amountValue : 0;

  return {
    price,
    amount,
    counterValue: amount * price,
  };
}

export function analyzeOrderBook(
  rawBids: RawOrderBookLevel[],
  rawAsks: RawOrderBookLevel[],
  depth: number,
): OrderBookAnalysis {
  const bids = rawBids
    .map(parseOrderBookLevel)
    .sort((a, b) => b.price - a.price)
    .slice(0, depth);
  const asks = rawAsks
    .map(parseOrderBookLevel)
    .sort((a, b) => a.price - b.price)
    .slice(0, depth);
  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;
  const spread = bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;
  const midMarketPrice = bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null;
  const spreadPercentage =
    spread !== null && midMarketPrice !== null && midMarketPrice !== 0
      ? (spread / midMarketPrice) * 100
      : null;

  return {
    bestBid,
    bestAsk,
    spread,
    midMarketPrice,
    spreadPercentage,
    bidQuantity: bids[0]?.amount ?? 0,
    askQuantity: asks[0]?.amount ?? 0,
    bidPriceLevels: bids.length,
    askPriceLevels: asks.length,
    priceLevels: bids.length + asks.length,
    totalBidLiquidity: bids.reduce((sum, level) => sum + level.amount, 0),
    totalAskLiquidity: asks.reduce((sum, level) => sum + level.amount, 0),
    totalBidCounterValue: bids.reduce((sum, level) => sum + level.counterValue, 0),
    totalAskCounterValue: asks.reduce((sum, level) => sum + level.counterValue, 0),
    bids,
    asks,
  };
}

export async function fetchOrderBook(
  server: Horizon.Server,
  selling: Asset,
  buying: Asset,
  depth: number,
): Promise<RawOrderBookResponse> {
  const builder = server.orderbook(selling, buying) as unknown as {
    limit: (limit: number) => { call: () => Promise<RawOrderBookResponse> };
  };
  return builder.limit(depth).call();
}

function assetFromTradeSide(type: unknown, code: unknown, issuer: unknown): Asset | null {
  if (type === 'native') {
    return Asset.native();
  }
  return typeof code === 'string' && typeof issuer === 'string' ? new Asset(code, issuer) : null;
}

async function discoverTradingPair(
  server: Horizon.Server,
): Promise<{ selling: Asset; buying: Asset } | null> {
  const page = await server.trades().order('desc').limit(1).call();
  const record = page.records[0] as unknown as Record<string, unknown> | undefined;
  if (!record) {
    return null;
  }
  const selling = assetFromTradeSide(
    record.base_asset_type,
    record.base_asset_code,
    record.base_asset_issuer,
  );
  const buying = assetFromTradeSide(
    record.counter_asset_type,
    record.counter_asset_code,
    record.counter_asset_issuer,
  );
  return selling && buying ? { selling, buying } : null;
}

export async function run(params: OrderBookParams = {}): Promise<void> {
  const horizonUrl = params.horizonUrl || process.env.HORIZON_URL || DEFAULT_HORIZON_URL;
  const depth = normalizeDepth(params.depth ?? process.env.ORDER_BOOK_DEPTH);
  const server = new Horizon.Server(horizonUrl);
  const json = wantsJson(params);

  const sellingInput = params.sellingAsset?.trim() || process.env.SELLING_ASSET?.trim();
  const buyingInput = params.buyingAsset?.trim() || process.env.BUYING_ASSET?.trim();

  let selling: Asset;
  let buying: Asset;

  if (sellingInput && buyingInput) {
    selling = parseTradingAsset(sellingInput, 'selling asset');
    buying = parseTradingAsset(buyingInput, 'buying asset');
  } else if (!sellingInput && !buyingInput) {
    if (!json) {
      console.log('No asset pair supplied; using a recently traded pair.');
    }
    const discovered = await discoverTradingPair(server);
    if (!discovered) {
      throw new Error('No recent Stellar trading pair could be discovered.');
    }
    selling = discovered.selling;
    buying = discovered.buying;
  } else {
    throw new Error('Both sellingAsset and buyingAsset are required when specifying a pair.');
  }

  if (selling.equals(buying)) {
    throw new Error('Selling and buying assets must be different.');
  }

  let raw: RawOrderBookResponse;
  try {
    raw = await fetchOrderBook(server, selling, buying, depth);
  } catch (error) {
    const status =
      typeof error === 'object' && error !== null && 'response' in error
        ? (error as { response?: { status?: number } }).response?.status
        : undefined;
    if (status === 400 || status === 404 || status === 422) {
      throw new Error('Horizon rejected the asset pair. Check the asset code and issuer.');
    }
    throw error;
  }

  const analysis = analyzeOrderBook(raw.bids ?? [], raw.asks ?? [], depth);
  const report = {
    tradingPair: `${describeTradingAsset(selling)} / ${describeTradingAsset(buying)}`,
    depth,
    ...analysis,
  };

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log('\n=== Stellar Order Book Inspection ===');
  console.log(`Trading pair:      ${report.tradingPair}`);
  console.log(`Displayed depth:   ${depth} levels per side`);
  console.log('Bids represent demand to buy the selling/base asset.');
  console.log('Asks represent offers to sell the selling/base asset.');

  if (analysis.priceLevels === 0) {
    console.log('\nNo active orders were found for this market.');
    return;
  }

  console.log(`Best bid:          ${analysis.bestBid ?? 'Unavailable'}`);
  console.log(`Best ask:          ${analysis.bestAsk ?? 'Unavailable'}`);
  console.log(`Bid/ask spread:    ${analysis.spread ?? 'Unavailable'}`);
  console.log(`Mid-market price:  ${analysis.midMarketPrice ?? 'Unavailable'}`);
  console.log(`Spread percentage: ${analysis.spreadPercentage?.toFixed(4) ?? 'Unavailable'}%`);
  console.log(`Best bid quantity: ${analysis.bidQuantity}`);
  console.log(`Best ask quantity: ${analysis.askQuantity}`);
  console.log(`Price levels:      ${analysis.priceLevels}`);
  console.log(`Bid liquidity:     ${analysis.totalBidLiquidity}`);
  console.log(`Ask liquidity:     ${analysis.totalAskLiquidity}`);

  console.log('\nBids:');
  analysis.bids.forEach((level, index) => {
    console.log(`  ${index + 1}. price=${level.price} amount=${level.amount}`);
  });
  console.log('\nAsks:');
  analysis.asks.forEach((level, index) => {
    console.log(`  ${index + 1}. price=${level.price} amount=${level.amount}`);
  });
}
