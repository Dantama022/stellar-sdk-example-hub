import {
  buildWithdrawalRiskReport,
  calculateProviderExposure,
  calculateReserveComposition,
  comparePoolSnapshots,
  detectReserveImbalance,
  estimateWithdrawal,
  extractProviderPoolShare,
  formatAmountUnits,
  normalizeLiquidityPoolId,
  parseAmountUnits,
  parseLiquidityPoolRecord,
  type ParsedLiquidityPool,
  type RawLiquidityPoolRecord,
} from '../src/examples/263-liquidity-pool-withdrawal-risk';
import { examples } from '../src/runner/catalog';

const POOL_ID = 'a'.repeat(64);
const PROVIDER = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

function rawPool(overrides: Partial<RawLiquidityPoolRecord> = {}): RawLiquidityPoolRecord {
  return {
    id: POOL_ID,
    type: 'constant_product',
    fee_bp: 30,
    total_trustlines: 12,
    total_shares: '500.0000000',
    reserves: [
      { asset: 'native', amount: '1000.0000000' },
      {
        asset: 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        amount: '250.0000000',
      },
    ],
    last_modified_ledger: 123456,
    last_modified_time: '2026-01-02T03:04:05Z',
    ...overrides,
  };
}

function parsedPool(overrides: Partial<RawLiquidityPoolRecord> = {}): ParsedLiquidityPool {
  return parseLiquidityPoolRecord(rawPool(overrides));
}

describe('263-liquidity-pool-withdrawal-risk: amounts and parsing', () => {
  it('validates and normalizes pool IDs', () => {
    expect(normalizeLiquidityPoolId(` ${'A'.repeat(64)} `)).toBe(POOL_ID);
    expect(() => normalizeLiquidityPoolId('short')).toThrow(/Invalid liquidity pool ID/);
  });

  it('uses decimal-safe stroop arithmetic', () => {
    expect(parseAmountUnits('12.5000000')).toBe(125000000n);
    expect(formatAmountUnits(125000000n)).toBe('12.5000000');
    expect(() => parseAmountUnits('1.12345678')).toThrow(/7 decimal places/);
  });

  it('parses both reserves, total shares, fee, and ledger metadata', () => {
    const pool = parsedPool();
    expect(pool.id).toBe(POOL_ID);
    expect(pool.reserves).toHaveLength(2);
    expect(pool.reserves[0].asset.assetType).toBe('native');
    expect(pool.reserves[1].asset.issuer).toContain('GBBD');
    expect(pool.totalShares).toBe('500.0000000');
    expect(pool.feeBasisPoints).toBe(30);
    expect(pool.lastModifiedLedger).toBe(123456);
    expect(pool.complete).toBe(true);
  });

  it('marks malformed or incomplete pool responses without crashing', () => {
    const pool = parseLiquidityPoolRecord({
      id: POOL_ID,
      total_shares: 'not-a-number',
      reserves: [{ asset: 'native', amount: 'bad' }],
    });
    expect(pool.complete).toBe(false);
    expect(pool.warnings.length).toBeGreaterThan(0);
  });
});

describe('263-liquidity-pool-withdrawal-risk: reserve composition', () => {
  it('calculates reserve percentages, ratio, and imbalance', () => {
    const composition = calculateReserveComposition(parsedPool());
    expect(composition.reserves[0].percent).toBeCloseTo(80, 4);
    expect(composition.reserves[1].percent).toBeCloseTo(20, 4);
    expect(composition.reserveRatio).toBe('4.000000');
    expect(composition.imbalancePercent).toBeCloseTo(60, 4);
  });

  it('identifies balanced and significantly imbalanced reserves', () => {
    const balanced = calculateReserveComposition(
      parsedPool({
        reserves: [
          { asset: 'native', amount: '500.0000000' },
          {
            asset: 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
            amount: '500.0000000',
          },
        ],
      }),
    );
    expect(detectReserveImbalance(balanced, 5).significant).toBe(false);
    expect(detectReserveImbalance(calculateReserveComposition(parsedPool()), 5).significant).toBe(
      true,
    );
  });

  it('rejects invalid imbalance thresholds', () => {
    const composition = calculateReserveComposition(parsedPool());
    expect(() => detectReserveImbalance(composition, -1)).toThrow(/between 0 and 100/);
    expect(() => detectReserveImbalance(composition, 101)).toThrow(/between 0 and 100/);
  });
});

describe('263-liquidity-pool-withdrawal-risk: withdrawal estimates', () => {
  it('calculates proportional payouts and ownership redeemed', () => {
    const estimate = estimateWithdrawal(parsedPool(), '100.0000000');
    expect(estimate.payouts[0].amount).toBe('200.0000000');
    expect(estimate.payouts[1].amount).toBe('50.0000000');
    expect(estimate.ownershipRedeemedPercent).toBeCloseTo(20, 4);
  });

  it('rejects zero, negative, and excessive share quantities', () => {
    const pool = parsedPool();
    expect(() => estimateWithdrawal(pool, '0.0000000')).toThrow(/greater than zero/);
    expect(() => estimateWithdrawal(pool, '-1.0000000')).toThrow(/non-negative/);
    expect(() => estimateWithdrawal(pool, '501.0000000')).toThrow(/pool total shares/);
    expect(() => estimateWithdrawal(pool, '10.0000000', '5.0000000')).toThrow(
      /available provider share balance/,
    );
  });

  it('rounds down at seven decimal places and reports precision warnings', () => {
    const pool = parsedPool({
      total_shares: '3.0000000',
      reserves: [
        { asset: 'native', amount: '1.0000000' },
        {
          asset: 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
          amount: '1.0000000',
        },
      ],
    });
    const estimate = estimateWithdrawal(pool, '1.0000000');
    expect(estimate.payouts[0].amount).toBe('0.3333333');
    expect(estimate.warnings.join(' ')).toContain('rounds down');
    expect(estimate.precisionNote).toContain('execution time');
  });
});

describe('263-liquidity-pool-withdrawal-risk: provider exposure and snapshots', () => {
  it('extracts a provider pool-share balance and calculates underlying exposure', () => {
    const provider = extractProviderPoolShare(
      {
        account_id: PROVIDER,
        balances: [
          {
            asset_type: 'liquidity_pool_shares',
            liquidity_pool_id: POOL_ID,
            balance: '50.0000000',
            limit: '1000.0000000',
          },
        ],
      },
      POOL_ID,
    );
    expect(provider?.shareBalance).toBe('50.0000000');
    const exposure = calculateProviderExposure(provider!, parsedPool());
    expect(exposure.ownershipPercent).toBeCloseTo(10, 4);
    expect(exposure.estimatedReserves[0].amount).toBe('100.0000000');
    expect(exposure.estimatedReserves[1].amount).toBe('25.0000000');
  });

  it('reports missing provider share information as null', () => {
    expect(
      extractProviderPoolShare(
        {
          account_id: PROVIDER,
          balances: [
            {
              asset_type: 'credit_alphanum4',
              asset_code: 'USDC',
              asset_issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
              balance: '1.0000000',
            },
          ],
        },
        POOL_ID,
      ),
    ).toBeNull();
  });

  it('compares snapshots and identifies increases, decreases, and identical states', () => {
    const before = parsedPool();
    const after = parsedPool({
      last_modified_ledger: 123500,
      reserves: [
        { asset: 'native', amount: '900.0000000' },
        {
          asset: 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
          amount: '300.0000000',
        },
      ],
    });
    const comparison = comparePoolSnapshots(before, after);
    expect(comparison.decreases).toHaveLength(1);
    expect(comparison.increases).toHaveLength(1);
    expect(comparison.increases[0].percentChange).toBeCloseTo(20, 4);
    expect(comparison.significantCompositionChange).toBe(true);

    const identical = comparePoolSnapshots(before, parsedPool());
    expect(identical.unchanged).toHaveLength(2);
    expect(identical.increases).toHaveLength(0);
    expect(identical.decreases).toHaveLength(0);
  });
});

describe('263-liquidity-pool-withdrawal-risk: report assembly', () => {
  it('builds a machine-readable report with estimates and caveats', () => {
    const report = buildWithdrawalRiskReport({
      pool: parsedPool(),
      requestedShares: '100.0000000',
    });
    expect(report.analysisStatus).toBe('warning');
    expect(report.estimatedWithdrawal?.payouts[0].amount).toBe('200.0000000');
    expect(report.imbalance?.significant).toBe(true);
    expect(report.snapshotCaveat).toContain('estimates');

    const parsed = JSON.parse(JSON.stringify(report));
    expect(parsed.poolId).toBe(POOL_ID);
    expect(parsed.reserves).toHaveLength(2);
  });

  it('marks incomplete pools without producing estimates', () => {
    const report = buildWithdrawalRiskReport({
      pool: parseLiquidityPoolRecord({ id: POOL_ID, reserves: [] }),
      requestedShares: '1.0000000',
    });
    expect(report.analysisStatus).toBe('incomplete');
    expect(report.estimatedWithdrawal).toBeNull();
  });

  it('is registered as a runnable example', () => {
    expect(examples['263-liquidity-pool-withdrawal-risk']).toBeDefined();
    expect(typeof examples['263-liquidity-pool-withdrawal-risk'].run).toBe('function');
  });
});
