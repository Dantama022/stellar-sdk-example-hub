import { analyzePortfolio } from '../examples/portfolio-analysis/account-asset-exposure';
import { HorizonAccount } from '../examples/_shared/horizon';

const issuerA = 'GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H';
const issuerB = 'GABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEJXA';
const a: HorizonAccount = { account_id: 'A', sequence: '0', balances: [
  { asset_type: 'native', balance: '10', selling_liabilities: '1' },
  { asset_type: 'credit_alphanum4', asset_code: 'USD', asset_issuer: issuerA,
    balance: '20', selling_liabilities: '5', is_authorized: true },
  { asset_type: 'credit_alphanum4', asset_code: 'USD', asset_issuer: issuerB,
    balance: '5', selling_liabilities: '0', is_authorized: false },
] };

describe('portfolio exposure (#579)', () => {
  it('separates equal codes by issuer, calculates prices and allocations', () => {
    const result = analyzePortfolio(a, { prices: {
      XLM: '1', [`USD:${issuerA}`]: '2', [`USD:${issuerB}`]: '2',
    }, warningThresholdPercent: 60 });
    expect(result.pricedSubtotal).toBe('60');
    expect(result.distinctIssuedAssets).toBe(2);
    expect(result.largestPricedAsset).toBe(`USD:${issuerA}`);
    expect(result.holdings.find((h) => h.id === `USD:${issuerA}`)?.estimatedValue).toBe('40');
    expect(result.issuerConcentration.find((i) => i.issuer === issuerA)?.percentOfPricedSubtotal)
      .toBeCloseTo(66.6666, 3);
    expect(result.warnings.some((w) => w.includes('unauthorized'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('Concentration'))).toBe(true);
  });
  it('preserves unknown prices instead of assigning zero value', () => {
    const result = analyzePortfolio(a, { prices: { XLM: '1' } });
    expect(result.pricedSubtotal).toBe('10');
    expect(result.missingPrices).toEqual([`USD:${issuerA}`, `USD:${issuerB}`]);
    expect(result.unpricedValuePercent).toBeNull();
    expect(result.holdings[1].estimatedValue).toBeNull();
  });
  it('works with XLM-only, zero-balance trustlines and liquidity pool shares', () => {
    const base = analyzePortfolio({ ...a, balances: [a.balances[0]] });
    expect(base.issuedTrustlineCount).toBe(0);
    const pool = analyzePortfolio({ ...a, balances: [
      { asset_type: 'credit_alphanum4', asset_code: 'USD', asset_issuer: issuerA, balance: '0' },
      { asset_type: 'liquidity_pool_shares', liquidity_pool_id: 'a'.repeat(64), balance: '2' },
    ] });
    expect(pool.liquidityPoolShareCount).toBe(1);
    expect(pool.warnings.join(' ')).toContain('Zero-balance');
  });
  it('rejects negative prices and duplicate identities', () => {
    expect(() => analyzePortfolio(a, { prices: { XLM: '-1' } })).toThrow();
    expect(() => analyzePortfolio({ ...a, balances: [a.balances[0], a.balances[0]] })).toThrow(/Duplicate/);
  });
});
