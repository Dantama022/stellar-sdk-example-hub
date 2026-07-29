import { Horizon } from '@stellar/stellar-sdk';

/**
 * Example 59: Account Offer Inspection
 *
 * Stellar accounts can place buy and sell offers on the decentralized exchange
 * (SDEX). Each resting offer is a ledger entry owned by an account and appears
 * in Horizon's `/accounts/{id}/offers` collection.
 *
 * Account offers vs. the orderbook
 * --------------------------------
 * These two views answer different questions:
 *
 *   Account offers (`server.offers().forAccount(id)`) — this example
 *     - The open positions owned by one account.
 *     - Answers "what is this account currently bidding/asking?".
 *     - Useful for wallets, portfolio tools, and account auditors.
 *
 *   Orderbook (`server.orderbook(selling, buying)`)
 *     - The aggregated resting bids and asks for one asset pair across all
 *       accounts (and liquidity pools where applicable).
 *     - Answers "at what price can I trade right now, and for how much?".
 *
 * An account offer is one row in some orderbook. Inspecting an account never
 * shows the full market depth; inspecting an orderbook never attributes levels
 * to a specific account without additional lookups.
 *
 * This example is strictly read-only: it never creates, modifies, or deletes
 * offers. See examples 22, 24, and 27 for offer management workflows.
 */

const DEFAULT_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

export interface AccountOfferInspectionParams {
  accountId?: string;
  limit?: number | string;
  horizonUrl?: string;
}

export interface RawOfferRecord {
  id?: string;
  paging_token?: string;
  seller?: string;
  selling?: {
    asset_type?: string;
    asset_code?: string;
    asset_issuer?: string;
  };
  buying?: {
    asset_type?: string;
    asset_code?: string;
    asset_issuer?: string;
  };
  amount?: string;
  price_r?: { n: number | string; d: number | string };
  price?: string;
  last_modified_ledger?: number;
  last_modified_time?: string;
}

export interface ParsedOffer {
  id: string;
  seller: string;
  /** Always "sell" from the account's perspective: offers sell `selling` for `buying`. */
  offerType: 'sell';
  sellingAsset: string;
  buyingAsset: string;
  amount: number;
  /** Buying units per 1 selling unit (Horizon `price`). */
  price: number;
  priceNumerator: number;
  priceDenominator: number;
  /** Approximate buying-asset volume if the offer fills completely: amount * price. */
  approximateBuyingVolume: number;
  lastModifiedLedger?: number;
  lastModifiedTime?: string;
}

export interface OfferInspectionSummary {
  offerCount: number;
  totalSellingByAsset: Record<string, number>;
  totalBuyingVolumeByAsset: Record<string, number>;
}

/**
 * Clamps a requested result limit into Horizon's accepted range.
 */
export function normalizeLimit(value?: number | string): number {
  const parsed = typeof value === 'string' ? parseInt(value.trim(), 10) : value;

  if (parsed === undefined || parsed === null || Number.isNaN(parsed)) {
    return DEFAULT_LIMIT;
  }

  return Math.min(Math.max(Math.trunc(parsed), 1), MAX_LIMIT);
}

/**
 * Renders a Horizon asset object as `XLM` or `CODE:ISSUER`.
 */
export function describeOfferAsset(asset?: {
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
}): string {
  if (!asset?.asset_type || asset.asset_type === 'native') {
    return 'XLM';
  }
  return asset.asset_issuer
    ? `${asset.asset_code}:${asset.asset_issuer}`
    : String(asset.asset_code);
}

/**
 * Converts a Horizon offer record into a structured summary.
 *
 * Horizon offers are always expressed as "sell `amount` of `selling` for
 * `buying` at `price` buying-units per selling-unit". There is no separate
 * buy-offer type on the ledger — manageBuyOffer is converted into an equivalent
 * sell offer under the hood.
 */
export function parseOfferRecord(record: RawOfferRecord): ParsedOffer {
  const amount = parseFloat(record.amount ?? '0') || 0;
  const numerator = Number(record.price_r?.n ?? NaN);
  const denominator = Number(record.price_r?.d ?? NaN);
  const hasRational =
    Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0;

  const price = hasRational ? numerator / denominator : parseFloat(record.price ?? '0') || 0;

  return {
    id: record.id ?? record.paging_token ?? '',
    seller: record.seller ?? '',
    offerType: 'sell',
    sellingAsset: describeOfferAsset(record.selling),
    buyingAsset: describeOfferAsset(record.buying),
    amount,
    price,
    priceNumerator: hasRational ? numerator : 0,
    priceDenominator: hasRational ? denominator : 1,
    approximateBuyingVolume: Number((amount * price).toFixed(7)),
    lastModifiedLedger: record.last_modified_ledger,
    lastModifiedTime: record.last_modified_time,
  };
}

/**
 * Aggregates active offers into per-asset selling and buying volume totals.
 */
export function summarizeOffers(offers: ParsedOffer[]): OfferInspectionSummary {
  const totalSellingByAsset: Record<string, number> = {};
  const totalBuyingVolumeByAsset: Record<string, number> = {};

  for (const offer of offers) {
    totalSellingByAsset[offer.sellingAsset] =
      (totalSellingByAsset[offer.sellingAsset] ?? 0) + offer.amount;
    totalBuyingVolumeByAsset[offer.buyingAsset] =
      (totalBuyingVolumeByAsset[offer.buyingAsset] ?? 0) + offer.approximateBuyingVolume;
  }

  return {
    offerCount: offers.length,
    totalSellingByAsset,
    totalBuyingVolumeByAsset,
  };
}

/**
 * Formats the offer inspection report for console output.
 */
export function formatOfferInspectionReport(
  accountId: string,
  offers: ParsedOffer[],
  summary: OfferInspectionSummary,
): string {
  const lines: string[] = [];

  lines.push('=== Stellar Account Offer Inspection ===');
  lines.push(`Account ID:       ${accountId}`);
  lines.push(`Active Offers:    ${summary.offerCount}`);
  lines.push('');
  lines.push('Account offers vs. orderbook:');
  lines.push('  - Account offers list the open DEX positions owned by this account.');
  lines.push('  - The orderbook aggregates resting liquidity for a pair across all accounts.');
  lines.push('  - Each offer below is one resting order that also appears in some orderbook.');

  if (offers.length === 0) {
    lines.push('');
    lines.push('No active offers found for this account.');
    lines.push('This is a normal empty state — the account has no resting SDEX positions.');
    lines.push('Create offers with manageBuyOffer / manageSellOffer (examples 22, 24, 27).');
    return lines.join('\n');
  }

  lines.push('');
  lines.push('Active Offers:');

  offers.forEach((offer, index) => {
    lines.push('');
    lines.push(`  [${index + 1}] Offer ID: ${offer.id}`);
    lines.push(`      Type:              ${offer.offerType} (sell selling-asset for buying-asset)`);
    lines.push(`      Selling:           ${offer.amount.toFixed(7)} ${offer.sellingAsset}`);
    lines.push(`      Buying:            ${offer.buyingAsset}`);
    lines.push(
      `      Price:             ${offer.price.toFixed(7)} ${offer.buyingAsset} per 1 ${offer.sellingAsset}`,
    );
    if (offer.priceNumerator && offer.priceDenominator) {
      lines.push(`      Price (rational):  ${offer.priceNumerator} / ${offer.priceDenominator}`);
    }
    lines.push(
      `      Approx. Volume:    ${offer.approximateBuyingVolume.toFixed(7)} ${offer.buyingAsset} if fully filled`,
    );
    if (offer.lastModifiedLedger !== undefined) {
      lines.push(`      Last Modified:     ledger ${offer.lastModifiedLedger}`);
    }
    if (offer.lastModifiedTime) {
      lines.push(`      Last Modified At:  ${offer.lastModifiedTime}`);
    }
  });

  lines.push('');
  lines.push('Summary:');
  lines.push(`  Total active offers: ${summary.offerCount}`);
  lines.push('  Selling totals by asset:');
  for (const [asset, total] of Object.entries(summary.totalSellingByAsset)) {
    lines.push(`    - ${total.toFixed(7)} ${asset}`);
  }
  lines.push('  Approximate buying volume by asset (if all offers fill):');
  for (const [asset, total] of Object.entries(summary.totalBuyingVolumeByAsset)) {
    lines.push(`    - ${total.toFixed(7)} ${asset}`);
  }

  return lines.join('\n');
}

/**
 * Runs the account offer inspection example.
 */
export async function run(params: AccountOfferInspectionParams = {}): Promise<void> {
  const horizonUrl = params.horizonUrl || process.env.HORIZON_URL || DEFAULT_HORIZON_URL;
  const server = new Horizon.Server(horizonUrl);
  const limit = normalizeLimit(params.limit ?? process.env.OFFER_LIMIT ?? process.argv[4]);

  let accountId =
    params.accountId?.trim() || process.env.ACCOUNT_ID?.trim() || process.argv[3]?.trim();

  console.log('Starting Account Offer Inspection Example...');
  console.log(`Using Horizon: ${horizonUrl}`);
  console.log('This example is read-only and does not create or cancel offers.');

  if (!accountId) {
    console.log('No account ID supplied. Looking for an account with active offers...');
    try {
      // Prefer an account that actually has offers so the example is informative.
      const offerPage = await server.offers().order('desc').limit(1).call();
      const first = offerPage.records[0] as RawOfferRecord | undefined;
      if (first?.seller) {
        accountId = first.seller;
      }
    } catch {
      // Fall through to recent operations.
    }

    if (!accountId) {
      try {
        const recentOps = await server.operations().order('desc').limit(1).call();
        if (recentOps.records.length > 0) {
          accountId = recentOps.records[0].source_account;
        }
      } catch {
        // Falls through.
      }
    }
  }

  if (!accountId) {
    accountId = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
  }

  console.log(`Inspecting offers for: ${accountId}`);
  console.log(`Result limit: ${limit}`);

  try {
    await server.loadAccount(accountId);
  } catch (error: any) {
    const status = error?.response?.status;
    if (status === 404) {
      console.log(`Account ${accountId} does not exist on this network.`);
      console.log(
        '\n' +
          formatOfferInspectionReport(accountId, [], {
            offerCount: 0,
            totalSellingByAsset: {},
            totalBuyingVolumeByAsset: {},
          }),
      );
      console.log('\nAccount offer inspection completed (missing account handled).');
      return;
    }
    console.log(`Could not load account ${accountId}: ${error?.message || error}`);
    return;
  }

  let records: RawOfferRecord[] = [];
  try {
    const page = await server.offers().forAccount(accountId).limit(limit).call();
    records = page.records as unknown as RawOfferRecord[];
  } catch (error: any) {
    console.log(`Could not retrieve offers: ${error?.message || error}`);
    return;
  }

  const offers = records.map(parseOfferRecord);
  const summary = summarizeOffers(offers);

  console.log('\n' + formatOfferInspectionReport(accountId, offers, summary));
  console.log('\nReminder: for market-wide depth, query server.orderbook(selling, buying).');
  console.log('Account offer inspection completed successfully.');
}
