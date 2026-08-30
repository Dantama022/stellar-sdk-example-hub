import { Horizon } from '@stellar/stellar-sdk';

import {
  fetchLiquidityPoolById,
  fetchLiquidityPools,
  formatLiquidityPool,
  formatLiquidityPoolFee,
  formatLiquidityPoolReport,
  formatLiquidityPoolReserve,
  getHorizonErrorStatus,
  isLiquidityPoolNotFoundError,
  normalizeLiquidityPoolId,
  normalizeLiquidityPoolLimit,
  parseLiquidityPoolAsset,
  parseLiquidityPoolRecord,
  parseLiquidityPoolReserve,
  summarizeLiquidityPools,
  type ParsedLiquidityPool,
  type RawLiquidityPoolRecord,
} from '../src/examples/64-liquidity-pool-inspection';

const POOL_ID = 'a'.repeat(64);
const ISSUER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

function createParsedPool(overrides: Partial<ParsedLiquidityPool> = {}): ParsedLiquidityPool {
  return {
    id: POOL_ID,
    pagingToken: POOL_ID,
    poolType: 'constant_product',
    feeBasisPoints: 30,
    feePercentage: '0.30%',
    totalShares: '500.0000000',
    participatingAccounts: 12,
    reserves: [
      {
        asset: {
          canonical: 'native',
          assetType: 'native',
          code: 'XLM',
        },
        amount: '1000.0000000',
      },
      {
        asset: {
          canonical: `USDC:${ISSUER}`,
          assetType: 'issued',
          code: 'USDC',
          issuer: ISSUER,
        },
        amount: '250.0000000',
      },
    ],
    lastModifiedLedger: 123456,
    lastModifiedTime: '2026-07-29T12:00:00Z',
    selfUrl: `https://horizon-testnet.stellar.org/liquidity_pools/${POOL_ID}`,
    ...overrides,
  };
}

describe('Example 64: Horizon liquidity pool inspection helpers', () => {
  describe('normalizeLiquidityPoolLimit', () => {
    it('uses the default for missing and invalid values', () => {
      expect(normalizeLiquidityPoolLimit()).toBe(5);
      expect(normalizeLiquidityPoolLimit('invalid')).toBe(5);
    });

    it('clamps values to the Horizon limit range', () => {
      expect(normalizeLiquidityPoolLimit(0)).toBe(1);
      expect(normalizeLiquidityPoolLimit(-10)).toBe(1);
      expect(normalizeLiquidityPoolLimit(25)).toBe(25);
      expect(normalizeLiquidityPoolLimit('40')).toBe(40);
      expect(normalizeLiquidityPoolLimit(500)).toBe(200);
    });
  });

  describe('normalizeLiquidityPoolId', () => {
    it('returns undefined when no ID is supplied', () => {
      expect(normalizeLiquidityPoolId()).toBeUndefined();
      expect(normalizeLiquidityPoolId('   ')).toBeUndefined();
    });

    it('trims and lowercases a valid pool ID', () => {
      expect(normalizeLiquidityPoolId(`  ${'A'.repeat(64)}  `)).toBe('a'.repeat(64));
    });

    it('rejects malformed pool IDs', () => {
      expect(() => normalizeLiquidityPoolId('abc123')).toThrow('Invalid liquidity pool ID');

      expect(() => normalizeLiquidityPoolId('z'.repeat(64))).toThrow('Invalid liquidity pool ID');
    });
  });

  describe('formatLiquidityPoolFee', () => {
    it('formats basis points as percentages', () => {
      expect(formatLiquidityPoolFee(30)).toBe('0.30%');
      expect(formatLiquidityPoolFee(100)).toBe('1.00%');
      expect(formatLiquidityPoolFee(5)).toBe('0.05%');
    });
  });

  describe('parseLiquidityPoolAsset', () => {
    it('parses native XLM', () => {
      expect(parseLiquidityPoolAsset('native')).toEqual({
        canonical: 'native',
        assetType: 'native',
        code: 'XLM',
      });
    });

    it('parses an issued asset code and issuer', () => {
      expect(parseLiquidityPoolAsset(`USDC:${ISSUER}`)).toEqual({
        canonical: `USDC:${ISSUER}`,
        assetType: 'issued',
        code: 'USDC',
        issuer: ISSUER,
      });
    });

    it('handles an unknown asset representation safely', () => {
      expect(parseLiquidityPoolAsset('unexpected')).toEqual({
        canonical: 'unexpected',
        assetType: 'unknown',
        code: 'unexpected',
      });
    });
  });

  describe('parseLiquidityPoolReserve', () => {
    it('parses a reserve amount and asset', () => {
      expect(
        parseLiquidityPoolReserve({
          asset: `EURC:${ISSUER}`,
          amount: '52.5000000',
        }),
      ).toEqual({
        asset: {
          canonical: `EURC:${ISSUER}`,
          assetType: 'issued',
          code: 'EURC',
          issuer: ISSUER,
        },
        amount: '52.5000000',
      });
    });

    it('uses a safe default for a missing amount', () => {
      expect(
        parseLiquidityPoolReserve({
          asset: 'native',
        }).amount,
      ).toBe('0.0000000');
    });
  });

  describe('parseLiquidityPoolRecord', () => {
    it('parses reserves, shares, fees, and participating accounts', () => {
      const record: RawLiquidityPoolRecord = {
        id: POOL_ID,
        paging_token: POOL_ID,
        type: 'constant_product',
        fee_bp: 30,
        total_shares: '500.0000000',
        total_trustlines: 12,
        reserves: [
          {
            asset: 'native',
            amount: '1000.0000000',
          },
          {
            asset: `USDC:${ISSUER}`,
            amount: '250.0000000',
          },
        ],
        last_modified_ledger: 123456,
        last_modified_time: '2026-07-29T12:00:00Z',
        _links: {
          self: {
            href: `https://horizon-testnet.stellar.org/liquidity_pools/${POOL_ID}`,
          },
        },
      };

      expect(parseLiquidityPoolRecord(record)).toEqual(createParsedPool());
    });

    it('uses safe defaults for optional pool fields', () => {
      const pool = parseLiquidityPoolRecord({
        id: POOL_ID,
      });

      expect(pool.poolType).toBe('Unknown');
      expect(pool.feeBasisPoints).toBe(0);
      expect(pool.feePercentage).toBe('0.00%');
      expect(pool.totalShares).toBe('0.0000000');
      expect(pool.participatingAccounts).toBe(0);
      expect(pool.reserves).toEqual([]);
    });
  });

  describe('fetchLiquidityPools', () => {
    it('retrieves an ordered and limited pool page', async () => {
      const call = jest.fn().mockResolvedValue({
        records: [
          {
            id: POOL_ID,
          },
        ],
      });

      const limit = jest.fn().mockReturnValue({
        call,
      });

      const order = jest.fn().mockReturnValue({
        limit,
      });

      const liquidityPools = jest.fn().mockReturnValue({
        order,
      });

      const server = {
        liquidityPools,
      } as unknown as Horizon.Server;

      const records = await fetchLiquidityPools(server, 10);

      expect(liquidityPools).toHaveBeenCalledTimes(1);
      expect(order).toHaveBeenCalledWith('desc');
      expect(limit).toHaveBeenCalledWith(10);
      expect(call).toHaveBeenCalledTimes(1);
      expect(records).toEqual([
        {
          id: POOL_ID,
        },
      ]);
    });
  });

  describe('fetchLiquidityPoolById', () => {
    it('retrieves one pool by ID', async () => {
      const call = jest.fn().mockResolvedValue({
        id: POOL_ID,
        total_shares: '500.0000000',
      });

      const liquidityPoolId = jest.fn().mockReturnValue({
        call,
      });

      const liquidityPools = jest.fn().mockReturnValue({
        liquidityPoolId,
      });

      const server = {
        liquidityPools,
      } as unknown as Horizon.Server;

      const record = await fetchLiquidityPoolById(server, POOL_ID);

      expect(liquidityPools).toHaveBeenCalledTimes(1);
      expect(liquidityPoolId).toHaveBeenCalledWith(POOL_ID);
      expect(call).toHaveBeenCalledTimes(1);
      expect(record.id).toBe(POOL_ID);
    });
  });

  describe('summarizeLiquidityPools', () => {
    it('summarizes pools, reserves, participants, and pool types', () => {
      const first = createParsedPool();

      const second = createParsedPool({
        id: 'b'.repeat(64),
        pagingToken: 'b'.repeat(64),
        participatingAccounts: 8,
        reserves: [
          {
            asset: {
              canonical: 'native',
              assetType: 'native',
              code: 'XLM',
            },
            amount: '50.0000000',
          },
          {
            asset: {
              canonical: `EURC:${ISSUER}`,
              assetType: 'issued',
              code: 'EURC',
              issuer: ISSUER,
            },
            amount: '40.0000000',
          },
        ],
      });

      expect(summarizeLiquidityPools([first, second])).toEqual({
        totalPools: 2,
        totalReserveEntries: 4,
        totalParticipatingAccounts: 20,
        poolTypes: {
          constant_product: 2,
        },
      });
    });
  });

  describe('formatLiquidityPoolReserve', () => {
    it('formats native reserves clearly', () => {
      const output = formatLiquidityPoolReserve(
        {
          asset: {
            canonical: 'native',
            assetType: 'native',
            code: 'XLM',
          },
          amount: '100.0000000',
        },
        0,
      );

      expect(output).toContain('Reserve 1: 100.0000000 XLM (native)');
    });

    it('formats issued reserves with the issuer', () => {
      const output = formatLiquidityPoolReserve(
        {
          asset: {
            canonical: `USDC:${ISSUER}`,
            assetType: 'issued',
            code: 'USDC',
            issuer: ISSUER,
          },
          amount: '50.0000000',
        },
        1,
      );

      expect(output).toContain('Reserve 2: 50.0000000 USDC');
      expect(output).toContain(`Issuer: ${ISSUER}`);
      expect(output).toContain(`Canonical asset: USDC:${ISSUER}`);
    });
  });

  describe('formatLiquidityPool', () => {
    it('displays reserves, pool shares, fee, and participation', () => {
      const output = formatLiquidityPool(createParsedPool(), 0);

      expect(output).toContain(`Pool ID:                 ${POOL_ID}`);
      expect(output).toContain('Fee:                     30 bp (0.30%)');
      expect(output).toContain('Total Pool Shares:       500.0000000');
      expect(output).toContain('Participating Accounts:  12');
      expect(output).toContain('Reserve 1: 1000.0000000 XLM (native)');
      expect(output).toContain('Reserve 2: 250.0000000 USDC');
    });
  });

  describe('formatLiquidityPoolReport', () => {
    it('formats a successful pool lookup', () => {
      const report = formatLiquidityPoolReport(POOL_ID, 5, [createParsedPool()]);

      expect(report).toContain('Inspection Mode: Specific liquidity pool');
      expect(report).toContain(`Requested Pool:  ${POOL_ID}`);
      expect(report).toContain('Pools Found:     1');
      expect(report).toContain('Pool shares represent proportional ownership of the reserves.');
      expect(report).toContain('The ID is derived from canonical pool parameters');
    });

    it('handles an unknown pool ID gracefully', () => {
      const report = formatLiquidityPoolReport(POOL_ID, 5, []);

      expect(report).toContain(`No liquidity pool was found for ID ${POOL_ID}.`);
      expect(report).toContain('This empty result was handled safely.');
      expect(report).toContain('are deterministic hashes of the canonical pool parameters');
    });

    it('handles an empty pool list gracefully', () => {
      const report = formatLiquidityPoolReport(undefined, 10, []);

      expect(report).toContain('Horizon returned no available liquidity pools.');
      expect(report).toContain('Pools Found:     0');
    });
  });

  describe('Horizon error handling', () => {
    it('extracts an HTTP response status', () => {
      expect(
        getHorizonErrorStatus({
          response: {
            status: 404,
          },
        }),
      ).toBe(404);

      expect(getHorizonErrorStatus(new Error('Failure'))).toBeUndefined();
    });

    it('identifies an unknown liquidity pool response', () => {
      expect(
        isLiquidityPoolNotFoundError({
          response: {
            status: 404,
          },
        }),
      ).toBe(true);

      expect(
        isLiquidityPoolNotFoundError({
          response: {
            status: 500,
          },
        }),
      ).toBe(false);
    });
  });
});
