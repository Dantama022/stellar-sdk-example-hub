import { Asset, Horizon } from '@stellar/stellar-sdk';
import {
  describeAsset,
  parseAssetInput,
  parseTradeRecord,
  summarizeTrades,
} from './55-trade-history';
import type { ParsedTrade, RawTradeRecord } from './55-trade-history';

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

export interface TradeHistoryAnalysisParams {
  sellingAsset?: string;
  buyingAsset?: string;
  limit?: string | number;
  fromTime?: string;
  toTime?: string;
  horizonUrl?: string;
  json?: boolean | string;
}

export interface TradeStatistics {
  highestTradePrice: number;
  lowestTradePrice: number;
  averageTradePrice: number;
  totalTradedVolume: number;
  totalCounterVolume: number;
  numberOfTrades: number;
}

function wantsJson(params: TradeHistoryAnalysisParams): boolean {
  return (
    params.json === true ||
    params.json === 'true' ||
    process.env.JSON_OUTPUT === 'true' ||
    process.argv.includes('--json')
  );
}

export function normalizeTradeLimit(value?: string | number): number {
  const parsed = typeof value === 'string' ? Number.parseInt(value.trim(), 10) : value;
  if (parsed === undefined || parsed === null || !Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_LIMIT;
  }
  return Math.min(Math.trunc(parsed), MAX_LIMIT);
}

export function parseTimeFilter(value: string | undefined, label: string): number | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  const normalized = value.trim();
  const numeric = Number(normalized);
  const timestampMs = Number.isFinite(numeric) ? numeric * 1000 : Date.parse(normalized);
  if (!Number.isFinite(timestampMs)) {
    throw new Error(`${label} must be a Unix timestamp in seconds or a valid ISO-8601 date.`);
  }
  return timestampMs;
}

export function filterTradesByTime(
  trades: ParsedTrade[],
  fromMs?: number,
  toMs?: number,
): ParsedTrade[] {
  if (fromMs !== undefined && toMs !== undefined && fromMs > toMs) {
    throw new Error('fromTime must be earlier than or equal to toTime.');
  }
  return trades.filter((trade) => {
    const time = Date.parse(trade.ledgerCloseTime);
    if (Number.isNaN(time)) {
      return false;
    }
    return (fromMs === undefined || time >= fromMs) && (toMs === undefined || time <= toMs);
  });
}

export function calculateTradeStatistics(trades: ParsedTrade[]): TradeStatistics {
  const summary = summarizeTrades(trades);
  return {
    highestTradePrice: summary.highestPrice,
    lowestTradePrice: summary.lowestPrice,
    averageTradePrice: summary.averagePrice,
    totalTradedVolume: summary.totalBaseVolume,
    totalCounterVolume: summary.totalCounterVolume,
    numberOfTrades: summary.tradeCount,
  };
}

export function parseHistoricalTrade(record: RawTradeRecord): ParsedTrade {
  return parseTradeRecord(record);
}

export async function fetchHistoricalTrades(
  server: Horizon.Server,
  selling: Asset,
  buying: Asset,
  limit: number,
): Promise<RawTradeRecord[]> {
  const page = await server
    .trades()
    .forAssetPair(selling, buying)
    .order('desc')
    .limit(limit)
    .call();
  return page.records as unknown as RawTradeRecord[];
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

export async function run(params: TradeHistoryAnalysisParams = {}): Promise<void> {
  const horizonUrl = params.horizonUrl || process.env.HORIZON_URL || DEFAULT_HORIZON_URL;
  const limit = normalizeTradeLimit(params.limit ?? process.env.TRADE_HISTORY_LIMIT);
  const fromMs = parseTimeFilter(params.fromTime ?? process.env.TRADE_FROM_TIME, 'fromTime');
  const toMs = parseTimeFilter(params.toTime ?? process.env.TRADE_TO_TIME, 'toTime');
  const json = wantsJson(params);
  const server = new Horizon.Server(horizonUrl);
  const sellingInput = params.sellingAsset?.trim() || process.env.SELLING_ASSET?.trim();
  const buyingInput = params.buyingAsset?.trim() || process.env.BUYING_ASSET?.trim();

  let selling: Asset;
  let buying: Asset;

  if (sellingInput && buyingInput) {
    selling = parseAssetInput(sellingInput, 'selling asset');
    buying = parseAssetInput(buyingInput, 'buying asset');
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

  let rawTrades: RawTradeRecord[] = [];
  try {
    const retrievalLimit = fromMs !== undefined || toMs !== undefined ? MAX_LIMIT : limit;
    rawTrades = await fetchHistoricalTrades(server, selling, buying, retrievalLimit);
  } catch (error) {
    const status =
      typeof error === 'object' && error !== null && 'response' in error
        ? (error as { response?: { status?: number } }).response?.status
        : undefined;
    if (status === 404) {
      rawTrades = [];
    } else if (status === 400 || status === 422) {
      throw new Error('Horizon rejected the asset pair. Check the asset code and issuer.');
    } else {
      throw error;
    }
  }

  const parsed = rawTrades.map(parseHistoricalTrade);
  const filtered = filterTradesByTime(parsed, fromMs, toMs).slice(0, limit);
  const statistics = calculateTradeStatistics(filtered);
  const report = {
    tradingPair: `${describeAsset(selling)} / ${describeAsset(buying)}`,
    filters: {
      fromTime: fromMs === undefined ? null : new Date(fromMs).toISOString(),
      toTime: toMs === undefined ? null : new Date(toMs).toISOString(),
      limit,
    },
    trades: filtered.map((trade) => ({
      timestamp: trade.ledgerCloseTime,
      price: trade.price,
      baseAssetAmount: trade.baseAmount,
      counterAssetAmount: trade.counterAmount,
      tradeType: trade.tradeType,
      id: trade.id,
    })),
    statistics,
  };

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log('\n=== Stellar Trade History Analysis ===');
  console.log(`Trading pair: ${report.tradingPair}`);
  console.log(`Trades:       ${statistics.numberOfTrades}`);

  if (filtered.length === 0) {
    console.log('No trade history matched this asset pair and time window.');
    return;
  }

  filtered.forEach((trade, index) => {
    console.log(`\n[${index + 1}] ${trade.ledgerCloseTime}`);
    console.log(`Trade price:    ${trade.price}`);
    console.log(`Base amount:    ${trade.baseAmount}`);
    console.log(`Counter amount: ${trade.counterAmount}`);
    console.log(`Trade type:     ${trade.tradeType || 'Unavailable'}`);
  });

  console.log('\nMarket statistics:');
  console.log(`Highest price:       ${statistics.highestTradePrice}`);
  console.log(`Lowest price:        ${statistics.lowestTradePrice}`);
  console.log(`Average price:       ${statistics.averageTradePrice}`);
  console.log(`Total traded volume: ${statistics.totalTradedVolume}`);
  console.log(`Number of trades:    ${statistics.numberOfTrades}`);
}
