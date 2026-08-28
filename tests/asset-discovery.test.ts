import { Horizon } from '@stellar/stellar-sdk';

import {
  fetchAssetRecords,
  formatAssetDiscoveryReport,
  formatAssetRecord,
  getTotalAccountHolders,
  isInvalidAssetQueryError,
  normalizeAssetCode,
  normalizeAssetLimit,
  parseAssetDiscoveryRecord,
  summarizeAssetRecords,
  type ParsedAssetRecord,
  type RawAssetRecord,
} from '../src/examples/63-asset-discovery';

const ISSUER_ONE = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const ISSUER_TWO = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBDV';

function createParsedAsset(overrides: Partial<ParsedAssetRecord> = {}): ParsedAssetRecord {
  return {
    assetType: 'credit_alphanum4',
    assetCode: 'USD',
    assetIssuer: ISSUER_ONE,
    uniqueIdentity: `USD:${ISSUER_ONE}`,
    pagingToken: `USD_${ISSUER_ONE}_credit_alphanum4`,

    accountHolders: {
      total: 12,
      authorized: 10,
      authorizedToMaintainLiabilities: 1,
      unauthorized: 1,
    },

    balances: {
      authorized: '500.0000000',
      authorizedToMaintainLiabilities: '20.0000000',
      unauthorized: '5.0000000',
    },

    claimableBalances: {
      count: 3,
      amount: '30.0000000',
    },

    liquidityPools: {
      count: 2,
      amount: '100.0000000',
    },

    contracts: {
      count: 1,
      amount: '10.0000000',
    },

    flags: {
      authRequired: false,
      authRevocable: true,
      authImmutable: false,
      authClawbackEnabled: false,
    },

    tomlUrl: 'https://example.com/.well-known/stellar.toml',

    ...overrides,
  };
}

describe('Example 63: Horizon asset discovery helpers', () => {
  describe('normalizeAssetLimit', () => {
    it('uses the default for missing and invalid values', () => {
      expect(normalizeAssetLimit()).toBe(10);
      expect(normalizeAssetLimit('invalid')).toBe(10);
    });

    it('clamps the result limit to the Horizon range', () => {
      expect(normalizeAssetLimit(0)).toBe(1);
      expect(normalizeAssetLimit(-5)).toBe(1);
      expect(normalizeAssetLimit(25)).toBe(25);
      expect(normalizeAssetLimit('50')).toBe(50);
      expect(normalizeAssetLimit(999)).toBe(200);
    });
  });

  describe('normalizeAssetCode', () => {
    it('returns undefined when no filter is supplied', () => {
      expect(normalizeAssetCode()).toBeUndefined();
      expect(normalizeAssetCode('   ')).toBeUndefined();
    });

    it('trims a valid asset code without changing its case', () => {
      expect(normalizeAssetCode('  USDC  ')).toBe('USDC');
      expect(normalizeAssetCode('usd')).toBe('usd');
    });

    it('rejects invalid asset-code filters', () => {
      expect(() => normalizeAssetCode('TOO-LONG-ASSET-CODE')).toThrow('Invalid asset code');

      expect(() => normalizeAssetCode('USD!')).toThrow('Invalid asset code');
    });
  });

  describe('getTotalAccountHolders', () => {
    it('adds grouped account-holder statistics', () => {
      expect(
        getTotalAccountHolders({
          accounts: {
            authorized: 10,
            authorized_to_maintain_liabilities: 2,
            unauthorized: 3,
          },
        }),
      ).toBe(15);
    });

    it('supports the older num_accounts response field', () => {
      expect(
        getTotalAccountHolders({
          num_accounts: 22,
        }),
      ).toBe(22);
    });
  });

  describe('parseAssetDiscoveryRecord', () => {
    it('parses Horizon asset metadata and statistics', () => {
      const record: RawAssetRecord = {
        asset_type: 'credit_alphanum4',
        asset_code: 'USDC',
        asset_issuer: ISSUER_ONE,
        paging_token: `USDC_${ISSUER_ONE}_credit_alphanum4`,

        accounts: {
          authorized: 100,
          authorized_to_maintain_liabilities: 5,
          unauthorized: 2,
        },

        balances: {
          authorized: '1000.0000000',
          authorized_to_maintain_liabilities: '25.0000000',
          unauthorized: '4.0000000',
        },

        num_claimable_balances: 8,
        claimable_balances_amount: '80.0000000',

        num_liquidity_pools: 4,
        liquidity_pools_amount: '250.0000000',

        num_contracts: 3,
        contracts_amount: '75.0000000',

        flags: {
          auth_required: true,
          auth_revocable: true,
          auth_immutable: false,
          auth_clawback_enabled: true,
        },

        _links: {
          toml: {
            href: 'https://example.com/.well-known/stellar.toml',
          },
        },
      };

      expect(parseAssetDiscoveryRecord(record)).toEqual({
        assetType: 'credit_alphanum4',
        assetCode: 'USDC',
        assetIssuer: ISSUER_ONE,
        uniqueIdentity: `USDC:${ISSUER_ONE}`,
        pagingToken: `USDC_${ISSUER_ONE}_credit_alphanum4`,

        accountHolders: {
          total: 107,
          authorized: 100,
          authorizedToMaintainLiabilities: 5,
          unauthorized: 2,
        },

        balances: {
          authorized: '1000.0000000',
          authorizedToMaintainLiabilities: '25.0000000',
          unauthorized: '4.0000000',
        },

        claimableBalances: {
          count: 8,
          amount: '80.0000000',
        },

        liquidityPools: {
          count: 4,
          amount: '250.0000000',
        },

        contracts: {
          count: 3,
          amount: '75.0000000',
        },

        flags: {
          authRequired: true,
          authRevocable: true,
          authImmutable: false,
          authClawbackEnabled: true,
        },

        tomlUrl: 'https://example.com/.well-known/stellar.toml',
      });
    });

    it('uses safe defaults for optional statistics', () => {
      const asset = parseAssetDiscoveryRecord({
        asset_type: 'credit_alphanum12',
        asset_code: 'LONGASSET',
        asset_issuer: ISSUER_ONE,
      });

      expect(asset.accountHolders.total).toBe(0);
      expect(asset.balances.authorized).toBe('0.0000000');
      expect(asset.claimableBalances.count).toBe(0);
      expect(asset.claimableBalances.amount).toBe('0.0000000');
      expect(asset.liquidityPools.count).toBe(0);
      expect(asset.contracts.count).toBe(0);
    });
  });

  describe('fetchAssetRecords', () => {
    it('queries Horizon with an asset-code filter and limit', async () => {
      const call = jest.fn().mockResolvedValue({
        records: [
          {
            asset_code: 'USDC',
            asset_issuer: ISSUER_ONE,
          },
        ],
      });

      const limit = jest.fn().mockReturnValue({
        call,
      });

      const order = jest.fn().mockReturnValue({
        limit,
      });

      const filteredBuilder = {
        order,
      };

      const forCode = jest.fn().mockReturnValue(filteredBuilder);

      const assets = jest.fn().mockReturnValue({
        forCode,
        order,
      });

      const server = {
        assets,
      } as unknown as Horizon.Server;

      const records = await fetchAssetRecords(server, 'USDC', 25);

      expect(assets).toHaveBeenCalledTimes(1);
      expect(forCode).toHaveBeenCalledWith('USDC');
      expect(order).toHaveBeenCalledWith('desc');
      expect(limit).toHaveBeenCalledWith(25);
      expect(call).toHaveBeenCalledTimes(1);
      expect(records).toHaveLength(1);
    });

    it('browses assets without applying a code filter', async () => {
      const call = jest.fn().mockResolvedValue({
        records: [],
      });

      const limit = jest.fn().mockReturnValue({
        call,
      });

      const order = jest.fn().mockReturnValue({
        limit,
      });

      const forCode = jest.fn();

      const assets = jest.fn().mockReturnValue({
        forCode,
        order,
      });

      const server = {
        assets,
      } as unknown as Horizon.Server;

      const records = await fetchAssetRecords(server, undefined, 10);

      expect(forCode).not.toHaveBeenCalled();
      expect(order).toHaveBeenCalledWith('desc');
      expect(limit).toHaveBeenCalledWith(10);
      expect(records).toEqual([]);
    });
  });

  describe('summarizeAssetRecords', () => {
    it('counts records, codes, issuers, holders, and claimable balances', () => {
      const first = createParsedAsset();

      const second = createParsedAsset({
        assetIssuer: ISSUER_TWO,
        uniqueIdentity: `USD:${ISSUER_TWO}`,
        accountHolders: {
          total: 8,
          authorized: 8,
          authorizedToMaintainLiabilities: 0,
          unauthorized: 0,
        },
        claimableBalances: {
          count: 2,
          amount: '15.0000000',
        },
      });

      expect(summarizeAssetRecords([first, second])).toEqual({
        totalRecords: 2,
        uniqueAssetCodes: 1,
        uniqueIssuers: 2,
        totalAccountHolders: 20,
        totalClaimableBalances: 5,
      });
    });
  });

  describe('formatAssetRecord', () => {
    it('formats asset metadata and balance statistics', () => {
      const output = formatAssetRecord(createParsedAsset(), 0);

      expect(output).toContain('[1] USD');
      expect(output).toContain(`Unique Identity: USD:${ISSUER_ONE}`);
      expect(output).toContain(`Issuer:          ${ISSUER_ONE}`);
      expect(output).toContain('Total:                              12');
      expect(output).toContain('Authorized:                         500.0000000');
      expect(output).toContain('Records:                            3');
      expect(output).toContain('Amount:                             30.0000000');
    });
  });

  describe('formatAssetDiscoveryReport', () => {
    it('displays multiple issuers sharing the same code distinctly', () => {
      const assets = [
        createParsedAsset(),
        createParsedAsset({
          assetIssuer: ISSUER_TWO,
          uniqueIdentity: `USD:${ISSUER_TWO}`,
        }),
      ];

      const report = formatAssetDiscoveryReport('USD', 10, assets);

      expect(report).toContain(`USD:${ISSUER_ONE}`);
      expect(report).toContain(`USD:${ISSUER_TWO}`);
      expect(report).toContain('Distinct codes:            1');
      expect(report).toContain('Distinct issuers:          2');
      expect(report).toContain('Code + issuer uniquely identifies an issued Stellar asset.');
    });

    it('handles an empty filtered search gracefully', () => {
      const report = formatAssetDiscoveryReport('MISSING', 10, []);

      expect(report).toContain('No Horizon asset records matched the code "MISSING".');
      expect(report).toContain('valid empty result');
      expect(report).toContain('an asset code alone does not uniquely identify an asset');
    });

    it('handles an empty unfiltered result gracefully', () => {
      const report = formatAssetDiscoveryReport(undefined, 10, []);

      expect(report).toContain('Horizon returned no indexed asset records.');
      expect(report).toContain('Records Found:     0');
    });
  });

  describe('isInvalidAssetQueryError', () => {
    it('detects invalid Horizon query responses', () => {
      expect(
        isInvalidAssetQueryError({
          response: {
            status: 400,
          },
        }),
      ).toBe(true);

      expect(
        isInvalidAssetQueryError({
          response: {
            status: 422,
          },
        }),
      ).toBe(true);

      expect(
        isInvalidAssetQueryError({
          response: {
            status: 500,
          },
        }),
      ).toBe(false);
    });
  });
});
