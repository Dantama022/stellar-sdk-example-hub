import { Asset, Horizon } from '@stellar/stellar-sdk';

/**
 * Example 65: Horizon Offer Book Inspection
 *
 * Horizon's `/offers` endpoint returns currently active Stellar decentralized
 * exchange offers. Each offer is an individual ledger entry owned by a seller
 * account and expresses an intention to sell one asset for another.
 *
 * Offers, order books, trades, and liquidity pools are related but different:
 *
 *   Active offers
 *     - Individual open ledger entries owned by seller accounts.
 *     - Can be changed, partially filled, fully filled, or cancelled.
 *     - Show who is selling, which asset is being sold, the requested buying
 *       asset, remaining amount, and price.
 *
 *   Order books
 *     - Aggregate current bids and asks for one asset pair.
 *     - Show market depth rather than presenting every offer as an independent
 *       seller-owned record.
 *
 *   Completed trades
 *     - Historical executions where assets already changed hands.
 *     - An offer is intent; a trade is a completed outcome.
 *
 *   Liquidity pools
 *     - Automated market maker reserves governed by a pool formula.
 *     - They provide liquidity without representing individual seller offers.
 *
 * Asset filters use Stellar asset identity:
 *
 *   native
 *   XLM
 *   CODE:ISSUER
 *
 * An issued asset must include both code and issuer. An asset code alone does
 * not uniquely identify an asset on Stellar.
 *
 * This example is read-only. It does not create, update, or cancel offers.
 */

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 200;

export interface OfferBookInspectionParams {
  /**
   * Optional selling-asset filter as `native`, `XLM`, or `CODE:ISSUER`.
   */
  sellingAsset?: string;

  /**
   * Optional buying-asset filter as `native`, `XLM`, or `CODE:ISSUER`.
   */
  buyingAsset?: string;

  /**
   * Number of active offers to return, from 1 through 200.
   */
  limit?: number | string;

  /**
   * Horizon URL override.
   */
  horizonUrl?: string;
}

export interface RawOfferAsset {
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
}

export interface RawOfferPriceRatio {
  n?: number | string;
  d?: number | string;
}

export interface RawOfferBookRecord {
  id?: string;
  paging_token?: string;
  seller?: string;
  selling?: RawOfferAsset;
  buying?: RawOfferAsset;
  amount?: string;
  price?: string;
  price_r?: RawOfferPriceRatio;
  last_modified_ledger?: number;
  last_modified_time?: string;

  _links?: {
    self?: {
      href?: string;
    };
    offer_maker?: {
      href?: string;
    };
  };
}

export interface ParsedOfferBookRecord {
  id: string;
  seller: string;
  sellingAsset: string;
  buyingAsset: string;
  assetPair: string;
  amount: number;
  price: number;
  priceNumerator?: number;
  priceDenominator?: number;
  approximateBuyingAmount: number;
  lastModifiedLedger?: number;
  lastModifiedTime?: string;
  selfUrl?: string;
}

export interface OfferBookSummary {
  totalOffers: number;
  uniqueSellers: number;
  uniqueAssetPairs: number;
  totalSellingAmounts: Record<string, number>;
  approximateBuyingAmounts: Record<string, number>;
}

/**
 * Normalizes a result limit to Horizon's supported 1–200 range.
 */
export function normalizeOfferBookLimit(value?: number | string): number {
  const parsed = typeof value === 'string' ? Number.parseInt(value.trim(), 10) : value;

  if (parsed === undefined || parsed === null || Number.isNaN(parsed)) {
    return DEFAULT_LIMIT;
  }

  return Math.min(Math.max(Math.trunc(parsed), 1), MAX_LIMIT);
}

/**
 * Parses a user-supplied asset filter.
 *
 * Accepted formats:
 *
 *   native
 *   XLM
 *   CODE:ISSUER
 *
 * The SDK validates issued-asset codes and issuer public keys before Horizon is
 * queried, giving users a readable local error instead of an opaque HTTP error.
 */
export function parseOfferBookAsset(value: string, label = 'asset'): Asset {
  const normalized = value.trim();

  if (!normalized) {
    throw new Error(`Missing ${label}. Use "native", "XLM", or "CODE:ISSUER".`);
  }

  if (normalized.toLowerCase() === 'native' || normalized.toUpperCase() === 'XLM') {
    return Asset.native();
  }

  const separatorIndex = normalized.indexOf(':');

  if (separatorIndex === -1) {
    throw new Error(`Invalid ${label} "${normalized}". Issued assets require CODE:ISSUER.`);
  }

  const code = normalized.slice(0, separatorIndex).trim();
  const issuer = normalized.slice(separatorIndex + 1).trim();

  if (!code || !issuer) {
    throw new Error(`Invalid ${label} "${normalized}". Issued assets require CODE:ISSUER.`);
  }

  try {
    return new Asset(code, issuer);
  } catch (error: unknown) {
    throw new Error(`Invalid ${label} "${normalized}": ${getOfferBookErrorMessage(error)}`);
  }
}

/**
 * Converts an SDK Asset into a readable label.
 */
export function describeOfferBookAsset(asset: Asset): string {
  if (asset.isNative()) {
    return 'XLM (native)';
  }

  return `${asset.getCode()}:${asset.getIssuer()}`;
}

/**
 * Converts a Horizon offer asset object into a readable label.
 */
export function describeRawOfferAsset(asset?: RawOfferAsset): string {
  if (!asset?.asset_type || asset.asset_type === 'native') {
    return 'XLM (native)';
  }

  if (asset.asset_code && asset.asset_issuer) {
    return `${asset.asset_code}:${asset.asset_issuer}`;
  }

  if (asset.asset_code) {
    return `${asset.asset_code} (${asset.asset_type})`;
  }

  return asset.asset_type;
}

/**
 * Parses a numeric Horizon string safely.
 */
export function parseOfferBookNumber(value?: string): number {
  const parsed = Number.parseFloat(value ?? '0');

  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Resolves an offer's price.
 *
 * Horizon provides both a decimal string and an exact rational representation.
 * The rational representation is preferred when its denominator is valid.
 *
 * Price means:
 *
 *   buying-asset units per 1 selling-asset unit
 */
export function parseOfferBookPrice(record: RawOfferBookRecord): {
  price: number;
  numerator?: number;
  denominator?: number;
} {
  const numerator = Number(record.price_r?.n);
  const denominator = Number(record.price_r?.d);

  if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0) {
    return {
      price: numerator / denominator,
      numerator,
      denominator,
    };
  }

  return {
    price: parseOfferBookNumber(record.price),
  };
}

/**
 * Converts one Horizon offer record into the consistent structure displayed by
 * this example.
 */
export function parseOfferBookRecord(record: RawOfferBookRecord): ParsedOfferBookRecord {
  const amount = parseOfferBookNumber(record.amount);
  const parsedPrice = parseOfferBookPrice(record);
  const sellingAsset = describeRawOfferAsset(record.selling);
  const buyingAsset = describeRawOfferAsset(record.buying);

  return {
    id: record.id ?? record.paging_token ?? '',
    seller: record.seller ?? 'Unknown',
    sellingAsset,
    buyingAsset,
    assetPair: `${sellingAsset} → ${buyingAsset}`,
    amount,
    price: parsedPrice.price,
    priceNumerator: parsedPrice.numerator,
    priceDenominator: parsedPrice.denominator,
    approximateBuyingAmount: Number((amount * parsedPrice.price).toFixed(7)),
    lastModifiedLedger: record.last_modified_ledger,
    lastModifiedTime: record.last_modified_time,
    selfUrl: record._links?.self?.href,
  };
}

/**
 * Summarizes the currently retrieved active offers.
 */
export function summarizeOfferBook(offers: ParsedOfferBookRecord[]): OfferBookSummary {
  const totalSellingAmounts: Record<string, number> = {};
  const approximateBuyingAmounts: Record<string, number> = {};

  for (const offer of offers) {
    totalSellingAmounts[offer.sellingAsset] =
      (totalSellingAmounts[offer.sellingAsset] ?? 0) + offer.amount;

    approximateBuyingAmounts[offer.buyingAsset] =
      (approximateBuyingAmounts[offer.buyingAsset] ?? 0) + offer.approximateBuyingAmount;
  }

  return {
    totalOffers: offers.length,
    uniqueSellers: new Set(offers.map((offer) => offer.seller)).size,
    uniqueAssetPairs: new Set(offers.map((offer) => offer.assetPair)).size,
    totalSellingAmounts,
    approximateBuyingAmounts,
  };
}

/**
 * Retrieves active Horizon offers with optional selling and buying asset
 * filters.
 */
export async function fetchActiveOffers(
  server: Horizon.Server,
  sellingAsset: Asset | undefined,
  buyingAsset: Asset | undefined,
  limit: number,
): Promise<RawOfferBookRecord[]> {
  let query = server.offers();

  if (sellingAsset) {
    query = query.selling(sellingAsset);
  }

  if (buyingAsset) {
    query = query.buying(buyingAsset);
  }

  const page = await query.order('desc').limit(limit).call();

  return page.records as unknown as RawOfferBookRecord[];
}

/**
 * Extracts a readable error message.
 */
export function getOfferBookErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

/**
 * Extracts an HTTP status from an unknown Horizon error.
 */
export function getOfferBookErrorStatus(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'response' in error) {
    const response = (error as { response?: { status?: unknown } }).response;

    if (typeof response?.status === 'number') {
      return response.status;
    }
  }

  return undefined;
}

/**
 * Detects a rejected selling or buying asset filter.
 */
export function isInvalidOfferBookQueryError(error: unknown): boolean {
  const status = getOfferBookErrorStatus(error);

  return status === 400 || status === 422;
}

/**
 * Formats one active offer as a readable console section.
 */
export function formatOfferBookRecord(offer: ParsedOfferBookRecord, index: number): string {
  const lines: string[] = [];

  lines.push(`[${index + 1}] Active Offer`);
  lines.push(`    Offer ID:                 ${offer.id || 'Unavailable'}`);
  lines.push(`    Seller:                   ${offer.seller}`);
  lines.push(`    Selling Asset:            ${offer.sellingAsset}`);
  lines.push(`    Buying Asset:             ${offer.buyingAsset}`);
  lines.push(`    Asset Pair:               ${offer.assetPair}`);
  lines.push(`    Selling Amount:           ${offer.amount.toFixed(7)} ${offer.sellingAsset}`);
  lines.push(
    `    Price:                    ${offer.price.toFixed(7)} ${offer.buyingAsset} per 1 ${offer.sellingAsset}`,
  );

  if (offer.priceNumerator !== undefined && offer.priceDenominator !== undefined) {
    lines.push(`    Exact Price Ratio:        ${offer.priceNumerator} / ${offer.priceDenominator}`);
  }

  lines.push(
    `    Approximate Buying Total: ${offer.approximateBuyingAmount.toFixed(7)} ${offer.buyingAsset}`,
  );

  if (offer.lastModifiedLedger !== undefined) {
    lines.push(`    Last Modified Ledger:     ${offer.lastModifiedLedger}`);
  }

  if (offer.lastModifiedTime) {
    lines.push(`    Last Modified Time:       ${offer.lastModifiedTime}`);
  }

  if (offer.selfUrl) {
    lines.push(`    Horizon Resource:         ${offer.selfUrl}`);
  }

  return lines.join('\n');
}

/**
 * Produces the complete active-offer report.
 */
export function formatOfferBookReport(
  sellingAsset: string | undefined,
  buyingAsset: string | undefined,
  limit: number,
  offers: ParsedOfferBookRecord[],
  summary: OfferBookSummary = summarizeOfferBook(offers),
): string {
  const lines: string[] = [];

  lines.push('=== Stellar Horizon Offer Book Inspection ===');
  lines.push(`Selling Filter: ${sellingAsset ?? 'None — any selling asset'}`);
  lines.push(`Buying Filter:  ${buyingAsset ?? 'None — any buying asset'}`);
  lines.push(`Result Limit:   ${limit}`);
  lines.push(`Offers Found:   ${offers.length}`);

  if (offers.length === 0) {
    lines.push('');
    lines.push('No active offers matched the selected filters.');
    lines.push('');
    lines.push('This is a valid empty result. It may mean that:');
    lines.push('  - no seller currently has a matching open offer,');
    lines.push('  - matching offers were filled or cancelled,');
    lines.push('  - the selected network has no market for this asset pair, or');
    lines.push('  - an issued asset uses a different issuer account.');
    lines.push('');
    lines.push('Remember:');
    lines.push('  - Offers are open seller-owned trading intentions.');
    lines.push('  - Order books aggregate current liquidity for an asset pair.');
    lines.push('  - Trades are completed historical executions.');
    lines.push('  - Liquidity pools are AMM reserves, not seller-owned offers.');

    return lines.join('\n');
  }

  lines.push('');
  lines.push('Active Offers:');

  offers.forEach((offer, index) => {
    lines.push('');
    lines.push(formatOfferBookRecord(offer, index));
  });

  lines.push('');
  lines.push('Result Summary:');
  lines.push(`  Total active offers: ${summary.totalOffers}`);
  lines.push(`  Unique sellers:      ${summary.uniqueSellers}`);
  lines.push(`  Unique asset pairs:  ${summary.uniqueAssetPairs}`);

  lines.push('');
  lines.push('  Selling totals by asset:');

  for (const [asset, total] of Object.entries(summary.totalSellingAmounts)) {
    lines.push(`    - ${total.toFixed(7)} ${asset}`);
  }

  lines.push('');
  lines.push('  Approximate buying totals if all returned offers fill:');

  for (const [asset, total] of Object.entries(summary.approximateBuyingAmounts)) {
    lines.push(`    - ${total.toFixed(7)} ${asset}`);
  }

  lines.push('');
  lines.push('Offers compared with other market resources:');
  lines.push('  - Offer: one seller’s remaining open intention to exchange assets.');
  lines.push('  - Order book: aggregated current bids and asks for an asset pair.');
  lines.push('  - Trade: a completed exchange already recorded in ledger history.');
  lines.push('  - Liquidity pool: AMM reserves that price trades using a pool formula.');

  lines.push('');
  lines.push('Price interpretation:');
  lines.push('  Price is buying-asset units requested per 1 selling-asset unit.');

  lines.push('');
  lines.push('This summary covers only the current Horizon result page.');

  return lines.join('\n');
}

/**
 * Runs the active offer inspection example.
 *
 * Configuration:
 *
 *   Interactive runner:
 *     npm run run-example 65-offer-book-inspection
 *
 *   Browse all active offers:
 *     npm run run-example -- 65-offer-book-inspection
 *
 *   Filter by selling asset:
 *     npm run run-example -- 65-offer-book-inspection native
 *
 *   Filter by selling and buying assets:
 *     npm run run-example -- 65-offer-book-inspection \
 *       native \
 *       USDC:GISSUER \
 *       20
 *
 *   Environment:
 *     SELLING_ASSET=native
 *     BUYING_ASSET=USDC:GISSUER
 *     OFFER_BOOK_LIMIT=20
 *     HORIZON_URL=https://horizon-testnet.stellar.org
 */
export async function run(params: OfferBookInspectionParams = {}): Promise<void> {
  const horizonUrl = params.horizonUrl || process.env.HORIZON_URL || DEFAULT_HORIZON_URL;

  const server = new Horizon.Server(horizonUrl);

  const sellingAssetInput =
    params.sellingAsset?.trim() ||
    process.env.SELLING_ASSET?.trim() ||
    process.argv[3]?.trim() ||
    undefined;

  const buyingAssetInput =
    params.buyingAsset?.trim() ||
    process.env.BUYING_ASSET?.trim() ||
    process.argv[4]?.trim() ||
    undefined;

  const limit = normalizeOfferBookLimit(
    params.limit ?? process.env.OFFER_BOOK_LIMIT ?? process.argv[5],
  );

  let sellingAsset: Asset | undefined;
  let buyingAsset: Asset | undefined;

  try {
    sellingAsset = sellingAssetInput
      ? parseOfferBookAsset(sellingAssetInput, 'selling asset')
      : undefined;

    buyingAsset = buyingAssetInput
      ? parseOfferBookAsset(buyingAssetInput, 'buying asset')
      : undefined;
  } catch (error: unknown) {
    console.log(`Invalid offer asset filter: ${getOfferBookErrorMessage(error)}`);
    console.log('Offer book inspection stopped safely without querying Horizon.');
    return;
  }

  console.log('Starting Horizon Offer Book Inspection Example...');
  console.log(`Using Horizon: ${horizonUrl}`);
  console.log(`Result limit: ${limit}`);
  console.log(`Selling filter: ${sellingAsset ? describeOfferBookAsset(sellingAsset) : 'None'}`);
  console.log(`Buying filter:  ${buyingAsset ? describeOfferBookAsset(buyingAsset) : 'None'}`);
  console.log('Offers are open trading intentions; completed executions appear in trade history.');

  let records: RawOfferBookRecord[];

  try {
    records = await fetchActiveOffers(server, sellingAsset, buyingAsset, limit);
  } catch (error: unknown) {
    if (isInvalidOfferBookQueryError(error)) {
      console.log('\nHorizon rejected the selling or buying asset filter.');
      console.log('Check that every issued asset uses the complete CODE:ISSUER format.');
      console.log('Offer book inspection completed (invalid query handled safely).');
      return;
    }

    console.log(`\nCould not retrieve active offers: ${getOfferBookErrorMessage(error)}`);
    return;
  }

  const offers = records.map(parseOfferBookRecord);
  const summary = summarizeOfferBook(offers);

  console.log(
    '\n' +
      formatOfferBookReport(
        sellingAsset ? describeOfferBookAsset(sellingAsset) : undefined,
        buyingAsset ? describeOfferBookAsset(buyingAsset) : undefined,
        limit,
        offers,
        summary,
      ),
  );

  if (offers.length === 0) {
    console.log('\nOffer book inspection completed (empty result handled gracefully).');
    return;
  }

  console.log('\nOffer book inspection completed successfully.');
}
