/** #579: trustline holdings and user-priced exposure (not market liquidity). */
import { StrKey } from '@stellar/stellar-sdk';
import {
  HorizonAccount, HorizonBalance, JsonFetcher, Network,
  loadAccount, parseUnits, percent, SCALE, units,
} from '../_shared/horizon';

export interface PortfolioOptions {
  /** Decimal quote-currency price per whole unit; keys XLM, CODE:ISSUER or POOL:ID. */
  prices?: Record<string, string>;
  priceSource?: string;
  warningThresholdPercent?: number;
}

export interface Holding {
  id: string;
  type: 'native' | 'issued' | 'liquidity_pool';
  issuer: string | null;
  assetCode: string | null;
  balance: string;
  sellingLiabilities: string | null;
  estimatedAvailable: string | null;
  authorization: string;
  limit: string | null;
  warnings: string[];
}

function normalizeBalance(balance: HorizonBalance): Holding {
  let id: string;
  let type: Holding['type'];
  const issuer = balance.asset_issuer ?? null;
  const code = balance.asset_code ?? null;
  if (balance.asset_type === 'native') {
    type = 'native'; id = 'XLM';
  } else if (balance.asset_type === 'credit_alphanum4' || balance.asset_type === 'credit_alphanum12') {
    if (!code || !new RegExp(`^[a-zA-Z0-9]{1,${balance.asset_type === 'credit_alphanum4' ? 4 : 12}}$`).test(code) ||
        !issuer || !StrKey.isValidEd25519PublicKey(issuer)) {
      throw new Error('Malformed issued asset identity');
    }
    type = 'issued'; id = `${code}:${issuer}`;
  } else if (balance.asset_type === 'liquidity_pool_shares') {
    if (!balance.liquidity_pool_id || !/^[a-f0-9]{64}$/i.test(balance.liquidity_pool_id)) {
      throw new Error('Missing or invalid liquidity pool ID');
    }
    type = 'liquidity_pool'; id = `POOL:${balance.liquidity_pool_id}`;
  } else {
    throw new Error(`Unsupported Horizon balance type: ${balance.asset_type}`);
  }
  const quantity = parseUnits(balance.balance, `${id} balance`);
  const selling = balance.selling_liabilities === undefined
    ? null : parseUnits(balance.selling_liabilities, `${id} selling liabilities`);
  const warnings: string[] = [];
  if (quantity === 0n && type !== 'native') warnings.push('Zero-balance trustline');
  if (balance.is_authorized === false) warnings.push('Trustline is unauthorized');
  if (balance.is_authorized_to_maintain_liabilities === true && balance.is_authorized !== true) {
    warnings.push('Authorization only to maintain liabilities');
  }
  if (type !== 'native' && balance.is_authorized === undefined) {
    warnings.push('Authorization flag not returned; status unknown');
  }
  if (selling === null) warnings.push('Selling liabilities unavailable; spendable amount cannot be estimated');
  if (selling !== null && selling > quantity) warnings.push('Selling liabilities exceed recorded balance');
  return {
    id, type, issuer, assetCode: code, balance: balance.balance,
    sellingLiabilities: balance.selling_liabilities ?? null,
    estimatedAvailable: selling === null ? null : units(quantity - selling),
    authorization: balance.is_authorized === true ? 'authorized'
      : balance.is_authorized === false ? 'unauthorized'
        : balance.is_authorized_to_maintain_liabilities === true ? 'maintain_liabilities_only' : 'unknown',
    limit: balance.limit ?? null, warnings,
  };
}

export function normalizeHoldings(account: HorizonAccount): Holding[] {
  if (!Array.isArray(account.balances)) throw new Error('Missing account balances');
  const holdings = account.balances.map(normalizeBalance);
  const identities = new Set<string>();
  for (const holding of holdings) {
    if (identities.has(holding.id)) throw new Error(`Duplicate asset identity: ${holding.id}`);
    identities.add(holding.id);
  }
  return holdings;
}

export function analyzePortfolio(account: HorizonAccount, options: PortfolioOptions = {}) {
  const threshold = options.warningThresholdPercent ?? 50;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
    throw new Error('Warning threshold must be between 0 and 100');
  }
  const prices = options.prices ?? {};
  const parsedPrices = new Map<string, bigint>();
  for (const [id, price] of Object.entries(prices)) {
    parsedPrices.set(id, parseUnits(price, `price for ${id}`));
  }
  const holdings = normalizeHoldings(account);
  const valued = holdings.map((holding) => {
    const price = parsedPrices.get(holding.id);
    const quoteUnits = price === undefined
      ? null : parseUnits(holding.balance, holding.id) * price / SCALE;
    return { ...holding, suppliedPrice: price === undefined ? null : prices[holding.id],
      estimatedValue: quoteUnits === null ? null : units(quoteUnits), quoteUnits };
  });
  const pricedTotal = valued.reduce((total, holding) => total + (holding.quoteUnits ?? 0n), 0n);
  const ranked = valued.filter((h) => h.quoteUnits !== null)
    .sort((a, b) => a.quoteUnits! > b.quoteUnits! ? -1 : a.quoteUnits! < b.quoteUnits! ? 1 : 0);
  const issuerTotals = new Map<string, bigint>();
  for (const holding of valued) {
    if (holding.issuer && holding.quoteUnits !== null) {
      issuerTotals.set(holding.issuer, (issuerTotals.get(holding.issuer) ?? 0n) + holding.quoteUnits);
    }
  }
  const warnings = valued.flatMap((holding) => holding.warnings.map((w) => `${holding.id}: ${w}`));
  const missingPrices = valued.filter((h) => h.quoteUnits === null).map((h) => h.id);
  if (missingPrices.length) warnings.push('Unpriced assets are excluded from the priced subtotal; total portfolio value and unpriced value share are unknown.');
  const rows = valued.map(({ quoteUnits, ...holding }) => ({
    ...holding, allocationOfPricedSubtotalPercent: quoteUnits === null ? null : percent(quoteUnits, pricedTotal),
  }));
  const rankedSum = (count: number): number | null =>
    percent(ranked.slice(0, count).reduce((sum, h) => sum + (h.quoteUnits ?? 0n), 0n), pricedTotal);
  for (const row of rows) {
    if (row.allocationOfPricedSubtotalPercent !== null && row.allocationOfPricedSubtotalPercent >= threshold) {
      warnings.push(`Concentration: ${row.id} accounts for >= ${threshold}% of priced holdings`);
    }
  }
  return {
    accountId: account.account_id,
    totalXlmBalance: holdings.find((h) => h.id === 'XLM')?.balance ?? null,
    issuedTrustlineCount: holdings.filter((h) => h.type === 'issued').length,
    liquidityPoolShareCount: holdings.filter((h) => h.type === 'liquidity_pool').length,
    distinctIssuedAssets: new Set(holdings.filter((h) => h.type === 'issued').map((h) => h.id)).size,
    priceSource: options.priceSource ?? 'caller-supplied prices; not Horizon market data',
    pricedSubtotal: units(pricedTotal),
    unpricedAssetCount: missingPrices.length,
    unpricedValuePercent: null as null, // Cannot infer value share without prices.
    missingPrices,
    holdings: rows,
    largestPricedAsset: ranked[0]?.id ?? null,
    topThreeOfPricedSubtotalPercent: rankedSum(3),
    topFiveOfPricedSubtotalPercent: rankedSum(5),
    issuerConcentration: [...issuerTotals].map(([issuer, value]) => ({
      issuer, estimatedValue: units(value), percentOfPricedSubtotal: percent(value, pricedTotal),
    })).sort((a, b) => (b.percentOfPricedSubtotal ?? 0) - (a.percentOfPricedSubtotal ?? 0)),
    warnings,
    note: 'Holdings are quantities, not guaranteed liquidity/redemption. Values and concentrations use supplied prices only; unpriced assets make full portfolio concentration indeterminate.',
  };
}

export async function analyzeAccountExposure(
  accountId: string, network: Network, options: PortfolioOptions = {},
  fetcher: JsonFetcher = fetch,
) {
  const account = await loadAccount(accountId, network, fetcher);
  return { network, ...analyzePortfolio(account, options) };
}

if (require.main === module) {
  const [accountId, network = 'testnet', pricesJson = '{}'] = process.argv.slice(2);
  try {
    const prices = JSON.parse(pricesJson) as Record<string, string>;
    analyzeAccountExposure(accountId ?? '', network as Network, { prices })
      .then((report) => console.log(JSON.stringify(report, null, 2)))
      .catch((error: unknown) => { console.error(error); process.exitCode = 1; });
  } catch (error) { console.error(error); process.exitCode = 1; }
}
