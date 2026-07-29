import { Asset, Horizon } from '@stellar/stellar-sdk';

/**
 * Example 55: Trade History
 *
 * Horizon's `/trades` endpoint returns *completed* trades on the Stellar
 * decentralized exchange (SDEX). Every record is a matched execution that was
 * already written to the ledger: two accounts (or an account and a liquidity
 * pool) exchanged assets at a settled price.
 *
 * Trade history vs. orderbook depth
 * ---------------------------------
 * These two endpoints answer different questions and are easy to confuse:
 *
 *   `/order_book` (`server.orderbook(base, counter)`)
 *     - The *current* set of resting bids and asks for a pair.
 *     - Nothing in it has happened yet; each level is an open offer that may be
 *       cancelled before it ever trades.
 *     - It is a snapshot: it changes with every ledger and has no history.
 *     - Answers "at what price could I trade right now, and for how much?".
 *
 *   `/trades` (`server.trades().forAssetPair(base, counter)`) — this example
 *     - The *past* executions for a pair, newest or oldest first.
 *     - Every record already settled; prices here are realized, not quoted.
 *     - It is an append-only log: records are paginated and never change.
 *     - Answers "what did this market actually trade at, and how much volume?".
 *
 * Put differently: the orderbook is intent, trade history is outcome. A pair can
 * have a deep orderbook and zero trades (nobody crossed the spread), or a long
 * trade history and an empty orderbook (every offer was consumed). Market
 * dashboards typically show both — depth for executable liquidity, history for
 * price discovery and volume.
 *
 * Offer-creation examples (`22-manage-buy-offer`, `27-manage-sell-offer`,
 * `24-create-passive-sell-offer`) produce the offers that populate the
 * orderbook. This example is strictly read-only and inspects what those offers
 * eventually settled into, so it is safe to run against any network.
 *
 * Asset pair parameters
 * ---------------------
 * Horizon takes each side of the pair as three query parameters
 * (`base_asset_type`, `base_asset_code`, `base_asset_issuer`, and the matching
 * `counter_*` set). The SDK's `forAssetPair(base, counter)` builds these from
 * `Asset` objects, so native XLM (`Asset.native()`, type `native`, no code or
 * issuer) and issued assets (`new Asset(code, issuer)`, type `credit_alphanum4`
 * or `credit_alphanum12`) are handled by the same call.
 *
 * Which asset is "base" and which is "counter" only affects orientation, not
 * which trades are returned: prices are quoted as counter units per 1 base unit,
 * so flipping the pair inverts every price.
 */

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 200;

/** Number of trades for which the example resolves a transaction hash. */
const MAX_TRANSACTION_LOOKUPS = 5;

export interface TradeHistoryParams {
  /** Base asset as `native`/`XLM` or `CODE:ISSUER`. */
  baseAsset?: string;
  /** Counter asset as `native`/`XLM` or `CODE:ISSUER`. */
  counterAsset?: string;
  /** Number of trades to retrieve (1-200). */
  limit?: number | string;
  horizonUrl?: string;
}

/** A Horizon trade record reduced to the fields this example reports on. */
export interface ParsedTrade {
  /** Horizon trade ID, formatted as `<operation-id>-<order>`. */
  id: string;
  /** ISO-8601 close time of the ledger that contained the trade. */
  ledgerCloseTime: string;
  /** `orderbook` for offer-vs-offer trades, `liquidity_pool` for AMM trades. */
  tradeType: string;
  baseAsset: string;
  counterAsset: string;
  /** Amount of the base asset that changed hands. */
  baseAmount: number;
  /** Amount of the counter asset that changed hands. */
  counterAmount: number;
  /** Counter units paid per 1 base unit. */
  price: number;
  /** Account or liquidity pool on the base side, when Horizon reports one. */
  baseParty?: string;
  /** Account or liquidity pool on the counter side, when Horizon reports one. */
  counterParty?: string;
  /**
   * True when the base side was the seller, i.e. base was sold for counter.
   * This determines whether the trade reads as a "sell" or a "buy" of the base
   * asset from the perspective of the pair as queried.
   */
  baseIsSeller: boolean;
  /** Operation that produced the trade; the stable on-ledger reference. */
  operationId: string;
  /** Horizon link to that operation, when the response includes `_links`. */
  operationLink?: string;
  /** Hash of the transaction containing the operation, once resolved. */
  transactionHash?: string;
}

export interface TradeSummary {
  tradeCount: number;
  /** Total base asset volume across all trades. */
  totalBaseVolume: number;
  /** Total counter asset volume across all trades. */
  totalCounterVolume: number;
  /** Unweighted mean of the individual trade prices. */
  averagePrice: number;
  /** Volume-weighted average price: total counter volume / total base volume. */
  volumeWeightedPrice: number;
  highestPrice: number;
  lowestPrice: number;
  /** Close time of the oldest trade in the result set. */
  earliestTradeAt: string | null;
  /** Close time of the newest trade in the result set. */
  latestTradeAt: string | null;
  /** Base volume traded through the SDEX orderbook. */
  orderbookTradeCount: number;
  /** Base volume traded against an AMM liquidity pool. */
  liquidityPoolTradeCount: number;
}

/** Shape of the raw Horizon trade payload consumed by `parseTradeRecord`. */
export interface RawTradeRecord {
  id?: string;
  paging_token?: string;
  ledger_close_time?: string;
  trade_type?: string;
  base_account?: string;
  base_liquidity_pool_id?: string;
  base_amount?: string;
  base_asset_type?: string;
  base_asset_code?: string;
  base_asset_issuer?: string;
  counter_account?: string;
  counter_liquidity_pool_id?: string;
  counter_amount?: string;
  counter_asset_type?: string;
  counter_asset_code?: string;
  counter_asset_issuer?: string;
  base_is_seller?: boolean;
  price?: { n: string | number; d: string | number };
  _links?: { operation?: { href?: string } };
}

/**
 * Parses a user-supplied asset string into an SDK `Asset`.
 *
 * Accepts `native` or `XLM` for the native asset, and `CODE:ISSUER` for issued
 * assets. The `Asset` constructor validates the code length and the issuer
 * strkey, so malformed input fails here rather than as an opaque Horizon 400.
 */
export function parseAssetInput(value: string, label = 'asset'): Asset {
  const trimmed = value.trim();

  if (!trimmed) {
    throw new Error(`Missing ${label}. Use "native" or "CODE:ISSUER".`);
  }

  if (trimmed.toLowerCase() === 'native' || trimmed.toUpperCase() === 'XLM') {
    return Asset.native();
  }

  const [code, issuer] = trimmed.split(':');
  if (!code || !issuer) {
    throw new Error(
      `Invalid ${label} "${trimmed}". Use "native" for XLM or "CODE:ISSUER" for an issued asset.`,
    );
  }

  try {
    return new Asset(code.trim(), issuer.trim());
  } catch (error: any) {
    throw new Error(`Invalid ${label} "${trimmed}": ${error?.message || error}`);
  }
}

/** Renders an asset as `XLM` or `CODE:GABC...WXYZ` for console output. */
export function describeAsset(asset: Asset): string {
  return asset.isNative() ? 'XLM (native)' : `${asset.getCode()}:${asset.getIssuer()}`;
}

/**
 * Rebuilds the asset label for one side of a trade record.
 *
 * Horizon omits `asset_code` and `asset_issuer` entirely when the side is
 * native, so the type field is the only reliable discriminator.
 */
export function describeTradeSideAsset(
  assetType?: string,
  assetCode?: string,
  assetIssuer?: string,
): string {
  if (!assetType || assetType === 'native') {
    return 'XLM';
  }
  return assetIssuer ? `${assetCode}:${assetIssuer}` : String(assetCode);
}

/**
 * Extracts the operation ID from a trade ID.
 *
 * Trade IDs are `<operation-id>-<order>`, where order distinguishes the two
 * trades a single operation can produce. Everything before the last dash is the
 * operation ID.
 */
export function extractOperationId(tradeId?: string): string {
  if (!tradeId) {
    return '';
  }
  const separator = tradeId.lastIndexOf('-');
  return separator > 0 ? tradeId.slice(0, separator) : tradeId;
}

/**
 * Converts a Horizon trade record into a `ParsedTrade`.
 *
 * Horizon reports the executed price as a rational `{ n, d }` pair to avoid
 * floating-point drift. When it is absent (older records, some liquidity pool
 * trades) the price is derived from the traded amounts instead.
 */
export function parseTradeRecord(record: RawTradeRecord): ParsedTrade {
  const baseAmount = parseFloat(record.base_amount ?? '0') || 0;
  const counterAmount = parseFloat(record.counter_amount ?? '0') || 0;

  const numerator = Number(record.price?.n ?? NaN);
  const denominator = Number(record.price?.d ?? NaN);
  const hasRationalPrice =
    Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0;

  const price = hasRationalPrice
    ? numerator / denominator
    : baseAmount > 0
      ? counterAmount / baseAmount
      : 0;

  return {
    id: record.id ?? record.paging_token ?? '',
    ledgerCloseTime: record.ledger_close_time ?? '',
    tradeType: record.trade_type ?? 'orderbook',
    baseAsset: describeTradeSideAsset(
      record.base_asset_type,
      record.base_asset_code,
      record.base_asset_issuer,
    ),
    counterAsset: describeTradeSideAsset(
      record.counter_asset_type,
      record.counter_asset_code,
      record.counter_asset_issuer,
    ),
    baseAmount,
    counterAmount,
    price,
    baseParty: record.base_account ?? record.base_liquidity_pool_id,
    counterParty: record.counter_account ?? record.counter_liquidity_pool_id,
    baseIsSeller: Boolean(record.base_is_seller),
    operationId: extractOperationId(record.id ?? record.paging_token),
    operationLink: record._links?.operation?.href,
  };
}

/**
 * Aggregates parsed trades into market activity statistics.
 *
 * Two averages are reported because they answer different questions. The
 * unweighted mean treats a 1 XLM trade and a 100,000 XLM trade equally, which is
 * useful for spotting outliers. The volume-weighted price (VWAP) is the price a
 * trader would have received had they executed the entire window at once, and is
 * the figure market dashboards normally quote.
 */
export function summarizeTrades(trades: ParsedTrade[]): TradeSummary {
  if (trades.length === 0) {
    return {
      tradeCount: 0,
      totalBaseVolume: 0,
      totalCounterVolume: 0,
      averagePrice: 0,
      volumeWeightedPrice: 0,
      highestPrice: 0,
      lowestPrice: 0,
      earliestTradeAt: null,
      latestTradeAt: null,
      orderbookTradeCount: 0,
      liquidityPoolTradeCount: 0,
    };
  }

  let totalBaseVolume = 0;
  let totalCounterVolume = 0;
  let priceSum = 0;
  let highestPrice = -Infinity;
  let lowestPrice = Infinity;
  let earliestTradeAt = trades[0].ledgerCloseTime;
  let latestTradeAt = trades[0].ledgerCloseTime;
  let orderbookTradeCount = 0;

  for (const trade of trades) {
    totalBaseVolume += trade.baseAmount;
    totalCounterVolume += trade.counterAmount;
    priceSum += trade.price;
    highestPrice = Math.max(highestPrice, trade.price);
    lowestPrice = Math.min(lowestPrice, trade.price);

    // Horizon returns trades in the requested order, not necessarily sorted by
    // time once liquidity pool trades are interleaved, so compare explicitly.
    if (trade.ledgerCloseTime && trade.ledgerCloseTime < earliestTradeAt) {
      earliestTradeAt = trade.ledgerCloseTime;
    }
    if (trade.ledgerCloseTime && trade.ledgerCloseTime > latestTradeAt) {
      latestTradeAt = trade.ledgerCloseTime;
    }

    if (trade.tradeType === 'liquidity_pool') {
      continue;
    }
    orderbookTradeCount += 1;
  }

  return {
    tradeCount: trades.length,
    totalBaseVolume,
    totalCounterVolume,
    averagePrice: priceSum / trades.length,
    // VWAP is undefined without base volume; report 0 rather than NaN.
    volumeWeightedPrice: totalBaseVolume > 0 ? totalCounterVolume / totalBaseVolume : 0,
    highestPrice,
    lowestPrice,
    earliestTradeAt: earliestTradeAt || null,
    latestTradeAt: latestTradeAt || null,
    orderbookTradeCount,
    liquidityPoolTradeCount: trades.length - orderbookTradeCount,
  };
}

/**
 * Clamps a requested result limit into Horizon's accepted range.
 *
 * Horizon rejects `limit` values outside 1-200 with a 400, so invalid or
 * out-of-range input is normalized instead of being forwarded.
 */
export function normalizeLimit(value?: number | string): number {
  const parsed = typeof value === 'string' ? parseInt(value.trim(), 10) : value;

  if (parsed === undefined || parsed === null || Number.isNaN(parsed)) {
    return DEFAULT_LIMIT;
  }

  return Math.min(Math.max(Math.trunc(parsed), 1), MAX_LIMIT);
}

/** Formats an amount with the 7 decimal places Stellar uses on-ledger. */
function formatAmount(value: number): string {
  return value.toFixed(7);
}

/** Renders the trade table and statistics as a console-ready string. */
export function formatTradeHistoryReport(
  baseLabel: string,
  counterLabel: string,
  trades: ParsedTrade[],
  summary: TradeSummary,
): string {
  const lines: string[] = [];

  lines.push('=== Stellar SDEX Trade History ===');
  lines.push(`Asset Pair:  ${baseLabel} / ${counterLabel}`);
  lines.push(`Price Quote: counter units (${counterLabel}) per 1 base unit (${baseLabel})`);

  // The full asset identity is printed once here so the per-trade rows can use
  // the short code without losing track of which issuer the pair refers to.
  if (trades.length > 0) {
    lines.push(`Base:        ${trades[0].baseAsset}`);
    lines.push(`Counter:     ${trades[0].counterAsset}`);
  }

  if (trades.length === 0) {
    lines.push('');
    lines.push('No trades found for this asset pair.');
    lines.push('');
    lines.push('This is a normal, valid result rather than an error. It usually means:');
    lines.push('  - the pair has never traded on this network (Testnet markets are sparse), or');
    lines.push('  - both assets exist but no offers have crossed yet, or');
    lines.push('  - the asset code or issuer does not match the traded asset exactly.');
    lines.push('');
    lines.push('An empty trade history says nothing about current liquidity. Query the orderbook');
    lines.push('(server.orderbook(base, counter)) to see whether resting bids and asks exist.');
    return lines.join('\n');
  }

  lines.push('');
  lines.push(`Trades Retrieved: ${trades.length}`);
  lines.push('');
  lines.push('Trade Records (newest first):');

  trades.forEach((trade, index) => {
    // base_is_seller describes which side gave up the base asset, which is what
    // makes a trade read as a buy or a sell of the base asset.
    const direction = trade.baseIsSeller
      ? `SELL ${baseLabel} for ${counterLabel}`
      : `BUY  ${baseLabel} with ${counterLabel}`;

    lines.push('');
    lines.push(`  [${index + 1}] ${trade.ledgerCloseTime}`);
    lines.push(`      Direction:     ${direction}`);
    lines.push(
      `      Price:         ${formatAmount(trade.price)} ${counterLabel} per ${baseLabel}`,
    );
    lines.push(`      Base Amount:   ${formatAmount(trade.baseAmount)} ${baseLabel}`);
    lines.push(`      Counter Amt:   ${formatAmount(trade.counterAmount)} ${counterLabel}`);
    lines.push(
      `      Venue:         ${trade.tradeType === 'liquidity_pool' ? 'AMM liquidity pool' : 'SDEX orderbook'}`,
    );
    if (trade.baseParty) {
      lines.push(`      Base Party:    ${trade.baseParty}`);
    }
    if (trade.counterParty) {
      lines.push(`      Counter Party: ${trade.counterParty}`);
    }
    lines.push(`      Trade ID:      ${trade.id}`);
    lines.push(`      Operation ID:  ${trade.operationId}`);
    if (trade.transactionHash) {
      lines.push(`      Tx Hash:       ${trade.transactionHash}`);
    }
    if (trade.operationLink) {
      lines.push(`      Operation:     ${trade.operationLink}`);
    }
  });

  lines.push('');
  lines.push('Market Activity Summary:');
  lines.push(`  Trades:                ${summary.tradeCount}`);
  lines.push(
    `  Venues:                ${summary.orderbookTradeCount} orderbook, ${summary.liquidityPoolTradeCount} liquidity pool`,
  );
  lines.push(`  Window:                ${summary.earliestTradeAt} -> ${summary.latestTradeAt}`);
  lines.push(`  Total Base Volume:     ${formatAmount(summary.totalBaseVolume)} ${baseLabel}`);
  lines.push(
    `  Total Counter Volume:  ${formatAmount(summary.totalCounterVolume)} ${counterLabel}`,
  );
  lines.push(`  Average Price:         ${formatAmount(summary.averagePrice)} (unweighted mean)`);
  lines.push(`  Volume-Weighted Price: ${formatAmount(summary.volumeWeightedPrice)} (VWAP)`);
  lines.push(`  Highest Price:         ${formatAmount(summary.highestPrice)}`);
  lines.push(`  Lowest Price:          ${formatAmount(summary.lowestPrice)}`);

  lines.push('');
  lines.push('These figures cover only the retrieved page of trades, not the full market history.');
  lines.push('Increase the limit or follow the `next` link to widen the window.');

  return lines.join('\n');
}

/**
 * Detects the "this pair has never traded" response.
 *
 * Horizon does not answer an unknown asset pair with an empty page: it returns
 * 404 Not Found, which the SDK surfaces as a thrown `NotFoundError`. That is a
 * valid empty result rather than a failure, so it has to be told apart from
 * genuine errors before the report is rendered.
 */
export function isEmptyTradeHistoryError(error: any): boolean {
  return error?.response?.status === 404 || error?.name === 'NotFoundError';
}

/**
 * Resolves the transaction hash behind a trade.
 *
 * Trade records reference their operation, not their transaction, so the hash
 * requires one extra Horizon call per trade. That cost is why only the first few
 * trades are resolved, and why failures are swallowed: a missing hash should
 * never take down the report.
 */
export async function resolveTransactionHash(
  server: Horizon.Server,
  operationId: string,
): Promise<string | undefined> {
  if (!operationId) {
    return undefined;
  }

  try {
    const operation = await server.operations().operation(operationId).call();
    return (operation as { transaction_hash?: string }).transaction_hash;
  } catch {
    return undefined;
  }
}

/**
 * Picks a pair that has actually traded on the connected network.
 *
 * Testnet has few active markets, so hardcoding a pair would leave the example
 * printing "no trades" for most users. Reading the most recent trade instead
 * guarantees a populated result whenever the network has any trading activity.
 */
async function discoverActiveAssetPair(
  server: Horizon.Server,
): Promise<{ base: Asset; counter: Asset } | null> {
  try {
    const page = await server.trades().order('desc').limit(1).call();
    const record = page.records[0] as RawTradeRecord | undefined;
    if (!record) {
      return null;
    }

    const toAsset = (type?: string, code?: string, issuer?: string): Asset | null => {
      if (!type || type === 'native') {
        return Asset.native();
      }
      // Liquidity pool shares are not tradeable assets and have no code/issuer.
      return code && issuer ? new Asset(code, issuer) : null;
    };

    const base = toAsset(record.base_asset_type, record.base_asset_code, record.base_asset_issuer);
    const counter = toAsset(
      record.counter_asset_type,
      record.counter_asset_code,
      record.counter_asset_issuer,
    );

    return base && counter ? { base, counter } : null;
  } catch {
    return null;
  }
}

/**
 * Runs the trade history example.
 *
 * The asset pair can be supplied through the runner prompts, the
 * `BASE_ASSET` / `COUNTER_ASSET` / `TRADE_LIMIT` environment variables, or CLI
 * arguments:
 *
 *   npm run run-example -- 55-trade-history native USDC:GA5Z...  25
 *
 * With none of those, the example discovers a recently traded pair so it stays
 * runnable without any setup.
 */
export async function run(params: TradeHistoryParams = {}): Promise<void> {
  const horizonUrl = params.horizonUrl || process.env.HORIZON_URL || DEFAULT_HORIZON_URL;
  const server = new Horizon.Server(horizonUrl);

  const baseInput =
    params.baseAsset?.trim() || process.env.BASE_ASSET?.trim() || process.argv[3]?.trim();
  const counterInput =
    params.counterAsset?.trim() || process.env.COUNTER_ASSET?.trim() || process.argv[4]?.trim();
  const limit = normalizeLimit(params.limit ?? process.env.TRADE_LIMIT ?? process.argv[5]);

  console.log('Starting Trade History Example...');
  console.log(`Using Horizon: ${horizonUrl}`);
  console.log('Trade history reports completed executions, not the current orderbook.');

  let base: Asset;
  let counter: Asset;

  if (baseInput && counterInput) {
    try {
      base = parseAssetInput(baseInput, 'base asset');
      counter = parseAssetInput(counterInput, 'counter asset');
    } catch (error: any) {
      console.log(`\n${error?.message || error}`);
      console.log('\nExpected formats:');
      console.log('  native                 the native XLM asset');
      console.log('  USDC:GA5ZSE...ZY7X     an issued asset as CODE:ISSUER');
      return;
    }

    if (base.equals(counter)) {
      console.log('\nBase and counter assets are identical. An asset cannot trade against itself.');
      return;
    }
  } else {
    if (baseInput || counterInput) {
      console.log('\nOnly one side of the pair was supplied; both are required.');
    }
    console.log('\nNo asset pair supplied. Looking for a recently traded pair on this network...');

    const discovered = await discoverActiveAssetPair(server);
    if (!discovered) {
      console.log('Could not find a recent trade to derive an asset pair from.');
      console.log('Supply a pair explicitly, for example:');
      console.log('  npm run run-example -- 55-trade-history native USDC:<issuer> 20');
      return;
    }

    base = discovered.base;
    counter = discovered.counter;
  }

  const baseLabel = base.isNative() ? 'XLM' : base.getCode();
  const counterLabel = counter.isNative() ? 'XLM' : counter.getCode();

  console.log(`\nBase asset:    ${describeAsset(base)}`);
  console.log(`Counter asset: ${describeAsset(counter)}`);
  console.log(`Result limit:  ${limit}`);

  let records: RawTradeRecord[] = [];
  try {
    const page = await server
      .trades()
      .forAssetPair(base, counter)
      .order('desc')
      .limit(limit)
      .call();
    records = page.records as unknown as RawTradeRecord[];
  } catch (error: any) {
    if (isEmptyTradeHistoryError(error)) {
      // A pair that has never traded, which the report explains below.
      records = [];
    } else if (error?.response?.status === 400) {
      console.log('\nHorizon rejected the asset pair parameters.');
      console.log('Check that each issued asset uses a valid code and issuer account ID.');
      return;
    } else {
      console.log(`\nCould not retrieve trades: ${error?.message || error}`);
      return;
    }
  }

  const trades = records.map(parseTradeRecord);

  // Transaction hashes require a follow-up call per trade, so resolve only the
  // first few and leave the rest referenced by operation ID.
  for (const trade of trades.slice(0, MAX_TRANSACTION_LOOKUPS)) {
    trade.transactionHash = await resolveTransactionHash(server, trade.operationId);
  }

  const summary = summarizeTrades(trades);

  console.log('\n' + formatTradeHistoryReport(baseLabel, counterLabel, trades, summary));

  console.log('\nReminder: these records are settled trades. For executable liquidity right now,');
  console.log('query server.orderbook(base, counter) — see the SDEX offer examples 22, 24 and 27.');
  console.log('\nTrade history example completed successfully.');
}
