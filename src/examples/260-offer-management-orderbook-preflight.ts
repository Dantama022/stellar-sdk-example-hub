import { Asset, Horizon, Operation, TransactionBuilder } from '@stellar/stellar-sdk';

/**
 * Example 260: Stellar Offer Management and Orderbook Inspection
 *
 * Demonstrates how to inspect a trading orderbook, retrieve an account's
 * existing offers, and prepare limit-buy or limit-sell offers safely.
 *
 * This example never signs with a real secret key and never submits
 * transactions. Limit orders are built as UNSIGNED XDR for review only.
 * Review price, amount, and trustline/liability preconditions before any
 * manual signing in a separate, explicit step.
 */

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 200;

export interface OfferManagementParams {
  /** Selling asset as `native`, `XLM`, or `CODE:ISSUER`. */
  sellingAsset?: string;
  /** Buying asset as `native`, `XLM`, or `CODE:ISSUER`. */
  buyingAsset?: string;
  /** Account whose offers are inspected (never signed). */
  accountId?: string;
  /** Limit order side to prepare. */
  side?: 'buy' | 'sell';
  /** Offer amount as decimal string. */
  amount?: string;
  /** Limit price as decimal string (e.g. "0.5"). */
  price?: string;
  horizonUrl?: string;
}

export interface OrderbookLevel {
  price: string;
  amount: string;
}

export interface OrderbookSummary {
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  spread?: string;
}

export function parseStellarAsset(input?: string): Asset {
  const normalized = (input ?? 'native').trim();
  if (['native', 'XLM'].includes(normalized)) return Asset.native();
  const separator = normalized.indexOf(':');
  if (separator === -1) throw new Error('Issued assets must use CODE:ISSUER.');
  const code = normalized.slice(0, separator);
  const issuer = normalized.slice(separator + 1);
  if (!code || !issuer) throw new Error('Issued assets must use CODE:ISSUER.');
  return new Asset(code, issuer);
}

export function normalizeLimit(value?: number | string): number {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : value;
  if (parsed === undefined || parsed === null || Number.isNaN(parsed)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(parsed), 1), MAX_LIMIT);
}

/**
 * Inspects aggregated orderbook depth for one asset pair (read-only).
 */
export async function fetchOrderbook(
  server: Horizon.Server,
  selling: Asset,
  buying: Asset,
  limit = DEFAULT_LIMIT,
): Promise<OrderbookSummary> {
  const book = await server.orderbook(selling, buying).limit(limit).call();
  const bids = ((book as unknown as { bids?: OrderbookLevel[] }).bids ?? []).map((b) => ({
    price: b.price,
    amount: b.amount,
  }));
  const asks = ((book as unknown as { asks?: OrderbookLevel[] }).asks ?? []).map((a) => ({
    price: a.price,
    amount: a.amount,
  }));
  const bestBid = bids.length > 0 ? Number(bids[0].price) : undefined;
  const bestAsk = asks.length > 0 ? Number(asks[0].price) : undefined;
  const spread =
    bestBid !== undefined && bestAsk !== undefined && Number.isFinite(bestBid) && Number.isFinite(bestAsk)
      ? String(bestAsk - bestBid)
      : undefined;
  return { bids, asks, spread };
}

/**
 * Retrieves an account's existing offers (read-only).
 */
export async function fetchAccountOffers(
  server: Horizon.Server,
  accountId: string,
  limit = DEFAULT_LIMIT,
): Promise<any[]> {
  const page = await server.offers().forAccount(accountId).limit(limit).call();
  return (page.records ?? []) as any[];
}

/**
 * Builds an UNSIGNED limit-order transaction for review (no signing, no submission).
 */
export async function buildUnsignedLimitOrder(
  server: Horizon.Server,
  sourceAccountId: string,
  selling: Asset,
  buying: Asset,
  side: 'buy' | 'sell',
  amount: string,
  price: string,
): Promise<string> {
  const source = await server.loadAccount(sourceAccountId);
  const builder = new TransactionBuilder(source, {
    fee: '100',
    networkPassphrase: 'Test SDF Network ; September 2015',
  }).setTimeout(60);

  if (side === 'sell') {
    builder.addOperation(
      Operation.manageSellOffer({
        selling,
        buying,
        amount,
        price,
        offerId: '0',
      }),
    );
  } else {
    builder.addOperation(
      Operation.manageBuyOffer({
        selling,
        buying,
        buyAmount: amount,
        price,
        offerId: '0',
      }),
    );
  }

  return builder.build().toXDR();
}

/**
 * Runs the orderbook inspection and limit-offer preparation example.
 *
 *   npm run run-example 260-offer-management-orderbook-preflight
 *
 * Environment:
 *   HORIZON_URL, SELLING_ASSET, BUYING_ASSET, ACCOUNT_ID,
 *   ORDER_SIDE (buy|sell), ORDER_AMOUNT, ORDER_PRICE
 */
export async function run(params: OfferManagementParams = {}): Promise<void> {
  const horizonUrl = params.horizonUrl || process.env.HORIZON_URL || DEFAULT_HORIZON_URL;
  const server = new Horizon.Server(horizonUrl);

  const selling = parseStellarAsset(params.sellingAsset ?? process.env.SELLING_ASSET ?? 'native');
  const buying = parseStellarAsset(params.buyingAsset ?? process.env.BUYING_ASSET ?? 'native');

  console.log('=== Stellar Offer Management and Orderbook Inspection ===');
  console.log(`Horizon: ${horizonUrl}`);

  const book = await fetchOrderbook(server, selling, buying, DEFAULT_LIMIT);
  console.log(`\nBids: ${book.bids.length}, Asks: ${book.asks.length}`);
  if (book.spread !== undefined) console.log(`Spread (best ask - best bid): ${book.spread}`);
  for (const bid of book.bids.slice(0, 5)) {
    console.log(`  bid price=${bid.price} amount=${bid.amount}`);
  }
  for (const ask of book.asks.slice(0, 5)) {
    console.log(`  ask price=${ask.price} amount=${ask.amount}`);
  }

  const accountId = params.accountId ?? process.env.ACCOUNT_ID;
  if (accountId) {
    const offers = await fetchAccountOffers(server, accountId, DEFAULT_LIMIT);
    console.log(`\nAccount ${accountId} has ${offers.length} open offer(s).`);
    for (const offer of offers.slice(0, 5)) {
      console.log(`  - offer ${offer.id}: selling ${offer.selling?.asset_code ?? 'XLM'} -> buying ${offer.buying?.asset_code ?? 'XLM'} amount=${offer.amount} price=${offer.price}`);
    }
  } else {
    console.log('\nNo ACCOUNT_ID supplied; skipping account-offer listing.');
  }

  const side = params.side ?? (process.env.ORDER_SIDE as 'buy' | 'sell' | undefined);
  const amount = params.amount ?? process.env.ORDER_AMOUNT;
  const price = params.price ?? process.env.ORDER_PRICE;

  if (side && amount && price && accountId) {
    if (!['buy', 'sell'].includes(side)) throw new Error('ORDER_SIDE must be buy or sell.');
    const xdr = await buildUnsignedLimitOrder(server, accountId, selling, buying, side, amount, price);
    console.log(`\nUnsigned limit-${side} XDR (review only; not signed, not submitted):`);
    console.log(xdr);
    console.log('\nConfirm price/amount, trustlines, and liabilities before any manual signing step.');
  } else {
    console.log('\nSupply ACCOUNT_ID + ORDER_SIDE + ORDER_AMOUNT + ORDER_PRICE to prepare unsigned limit-order XDR.');
  }

  console.log('\nDone. No automated trade execution was performed.');
}
