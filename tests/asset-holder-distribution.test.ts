import {
  buildAsset,
  buildReport,
  computeConcentration,
  computeStatistics,
  extractHolder,
  extractHolders,
  fetchAllHolders,
  formatAmount,
  isValidAccountId,
  isValidAssetCode,
  median,
  parseAmount,
  percentOf,
  rankHolders,
  type AssetHolder,
} from '../src/examples/169-asset-holder-distribution';
import { examples } from '../src/runner/catalog';

const ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const HOLDER_A = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

function makeAccount(accountId: string, balance: string, overrides: Record<string, any> = {}) {
  return {
    account_id: accountId,
    balances: [
      { asset_type: 'native', balance: '100' } as Record<string, any>,
      {
        asset_type: 'credit_alphanum4',
        asset_code: 'USDC',
        asset_issuer: ISSUER,
        balance,
        limit: '1000',
        buying_liabilities: '0',
        selling_liabilities: '0',
        ...overrides,
      } as Record<string, any>,
    ],
  };
}

function holder(account: string, balance: number, authorized = true): AssetHolder {
  return {
    account,
    balance,
    limit: 1000,
    authorized,
    authorizedToMaintainLiabilities: true,
    buyingLiabilities: 0,
    sellingLiabilities: 0,
  };
}

describe('Issue #229 / ISSUE-169: asset validation', () => {
  it('accepts alphanumeric-4 and alphanumeric-12 asset codes', () => {
    expect(isValidAssetCode('USDC')).toBe(true);
    expect(isValidAssetCode('LONGASSET123')).toBe(true);
    expect(isValidAssetCode('A')).toBe(true);
  });

  it('rejects malformed asset codes', () => {
    expect(isValidAssetCode('')).toBe(false);
    expect(isValidAssetCode('THIRTEENCHARS')).toBe(false);
    expect(isValidAssetCode('BAD-CODE')).toBe(false);
    expect(isValidAssetCode(42)).toBe(false);
  });

  it('validates issuer account IDs', () => {
    expect(isValidAccountId(ISSUER)).toBe(true);
    expect(isValidAccountId('not-an-account')).toBe(false);
    expect(isValidAccountId(undefined)).toBe(false);
  });

  it('builds an asset from a valid code and issuer', () => {
    const asset = buildAsset('USDC', ISSUER);
    expect(asset.getCode()).toBe('USDC');
    expect(asset.getIssuer()).toBe(ISSUER);
  });

  it('raises actionable errors for invalid identifiers', () => {
    expect(() => buildAsset('BAD-CODE', ISSUER)).toThrow(/Invalid asset code/);
    expect(() => buildAsset('USDC', 'nope')).toThrow(/Invalid issuer account/);
  });
});

describe('Issue #229 / ISSUE-169: amount parsing', () => {
  it('parses Horizon amount strings and falls back to zero', () => {
    expect(parseAmount('12.5000000')).toBe(12.5);
    expect(parseAmount(undefined)).toBe(0);
    expect(parseAmount('not-a-number')).toBe(0);
  });

  it('formats amounts with 7 decimals', () => {
    expect(formatAmount(12.5)).toBe('12.5000000');
  });
});

describe('Issue #229 / ISSUE-169: trustline extraction', () => {
  it('extracts the matching trustline from an account record', () => {
    const extracted = extractHolder(makeAccount(HOLDER_A, '250.5'), 'USDC', ISSUER);
    expect(extracted).toEqual({
      account: HOLDER_A,
      balance: 250.5,
      limit: 1000,
      authorized: true,
      authorizedToMaintainLiabilities: true,
      buyingLiabilities: 0,
      sellingLiabilities: 0,
    });
  });

  it('extracts liabilities and authorization flags', () => {
    const extracted = extractHolder(
      makeAccount(HOLDER_A, '10', {
        is_authorized: false,
        is_authorized_to_maintain_liabilities: false,
        buying_liabilities: '3',
        selling_liabilities: '4',
      }),
      'USDC',
      ISSUER,
    );
    expect(extracted?.authorized).toBe(false);
    expect(extracted?.authorizedToMaintainLiabilities).toBe(false);
    expect(extracted?.buyingLiabilities).toBe(3);
    expect(extracted?.sellingLiabilities).toBe(4);
  });

  it('does not match a same-coded asset from a different issuer', () => {
    const other = makeAccount(HOLDER_A, '5');
    other.balances[1].asset_issuer = 'GDIFFERENTISSUER';
    expect(extractHolder(other, 'USDC', ISSUER)).toBeNull();
  });

  it('skips records with no matching trustline or no account id', () => {
    expect(extractHolder({ balances: [] }, 'USDC', ISSUER)).toBeNull();
    expect(extractHolders([{ account_id: HOLDER_A, balances: [] }], 'USDC', ISSUER)).toEqual([]);
  });
});

describe('Issue #229 / ISSUE-169: aggregation', () => {
  it('computes the median for odd and even length sets', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });

  it('guards percentage calculations against a zero supply', () => {
    expect(percentOf(5, 20)).toBe(25);
    expect(percentOf(5, 0)).toBe(0);
  });

  it('aggregates balances, averages, and medians', () => {
    const stats = computeStatistics([holder('A', 100), holder('B', 50), holder('C', 10)]);
    expect(stats.holderCount).toBe(3);
    expect(stats.totalBalance).toBe(160);
    expect(stats.averageBalance).toBeCloseTo(53.3333333, 6);
    expect(stats.medianBalance).toBe(50);
    expect(stats.largestBalance).toBe(100);
  });

  it('counts zero-balance trustlines without distorting the total', () => {
    const stats = computeStatistics([holder('A', 100), holder('B', 0), holder('C', 0)]);
    expect(stats.totalBalance).toBe(100);
    expect(stats.zeroBalanceHolderCount).toBe(2);
    expect(stats.nonZeroHolderCount).toBe(1);
  });

  it('separates authorized and unauthorized balances', () => {
    const stats = computeStatistics([
      holder('A', 100, true),
      holder('B', 40, false),
      holder('C', 10, false),
    ]);
    expect(stats.authorizedHolderCount).toBe(1);
    expect(stats.unauthorizedHolderCount).toBe(2);
    expect(stats.authorizedBalance).toBe(100);
    expect(stats.unauthorizedBalance).toBe(50);
  });

  it('handles an empty holder set', () => {
    const stats = computeStatistics([]);
    expect(stats).toMatchObject({
      holderCount: 0,
      totalBalance: 0,
      averageBalance: 0,
      medianBalance: 0,
      largestBalance: 0,
    });
  });
});

describe('Issue #229 / ISSUE-169: ranking and concentration', () => {
  it('ranks holders by balance, largest first, without mutating the input', () => {
    const holders = [holder('A', 10), holder('B', 100), holder('C', 50)];
    const ranked = rankHolders(holders);
    expect(ranked.map((entry) => entry.account)).toEqual(['B', 'C', 'A']);
    expect(ranked[0].rank).toBe(1);
    expect(ranked[0].percentOfTotal).toBeCloseTo(62.5, 6);
    expect(holders[0].account).toBe('A');
  });

  it('computes cumulative top-N concentration', () => {
    const ranked = rankHolders([holder('A', 60), holder('B', 30), holder('C', 10)]);
    const tiers = computeConcentration(ranked, 100, [1, 2, 3]);
    expect(tiers).toEqual([
      { topN: 1, balance: 60, percentOfTotal: 60 },
      { topN: 2, balance: 90, percentOfTotal: 90 },
      { topN: 3, balance: 100, percentOfTotal: 100 },
    ]);
  });

  it('clamps tiers larger than the holder count and de-duplicates them', () => {
    const ranked = rankHolders([holder('A', 60), holder('B', 40)]);
    const tiers = computeConcentration(ranked, 100, [1, 5, 10]);
    expect(tiers).toHaveLength(2);
    expect(tiers[1]).toEqual({ topN: 2, balance: 100, percentOfTotal: 100 });
  });

  it('returns no tiers when there are no holders', () => {
    expect(computeConcentration([], 0, [1, 5])).toEqual([]);
  });
});

describe('Issue #229 / ISSUE-169: report assembly', () => {
  it('builds a report limited to the requested number of top holders', () => {
    const report = buildReport([holder('A', 30), holder('B', 20), holder('C', 10)], {
      assetCode: 'USDC',
      assetIssuer: ISSUER,
      horizonUrl: 'https://horizon-testnet.stellar.org',
      topN: 2,
      pagesFetched: 1,
    });
    expect(report.topHolders).toHaveLength(2);
    expect(report.statistics.totalBalance).toBe(60);
    expect(report.paginationError).toBeNull();
  });

  it('reports an empty distribution for an asset with no holders', () => {
    const report = buildReport([], {
      assetCode: 'USDC',
      assetIssuer: ISSUER,
      horizonUrl: 'https://horizon-testnet.stellar.org',
    });
    expect(report.statistics.holderCount).toBe(0);
    expect(report.topHolders).toEqual([]);
    expect(report.concentration).toEqual([]);
  });

  it('produces machine-readable JSON', () => {
    const report = buildReport([holder('A', 30)], {
      assetCode: 'USDC',
      assetIssuer: ISSUER,
      horizonUrl: 'https://horizon-testnet.stellar.org',
    });
    const parsed = JSON.parse(JSON.stringify(report));
    expect(parsed.statistics.totalBalance).toBe(30);
    expect(parsed.assetCode).toBe('USDC');
  });
});

describe('Issue #229 / ISSUE-169: pagination', () => {
  const asset = buildAsset('USDC', ISSUER);

  function serverReturning(pages: any[][], failAtPage?: number): any {
    let index = 0;
    const makePage = (): any => {
      if (failAtPage !== undefined && index === failAtPage) {
        throw new Error('Horizon page request failed');
      }
      const records = pages[index] ?? [];
      index += 1;
      return {
        records,
        next: async () => makePage(),
      };
    };

    return {
      accounts: () => ({
        forAsset: () => ({
          limit: () => ({
            call: async () => makePage(),
          }),
        }),
      }),
    };
  }

  it('follows pages until an empty page is returned', async () => {
    const server = serverReturning([
      [makeAccount(HOLDER_A, '10')],
      [makeAccount(HOLDER_A, '20')],
      [],
    ]);
    const result = await fetchAllHolders(server, asset, 100);
    expect(result.holders).toHaveLength(2);
    expect(result.pagesFetched).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.paginationError).toBeNull();
  });

  it('stops and marks the result truncated at the holder cap', async () => {
    const server = serverReturning([
      [makeAccount(HOLDER_A, '10'), makeAccount(HOLDER_A, '20')],
      [makeAccount(HOLDER_A, '30')],
    ]);
    const result = await fetchAllHolders(server, asset, 2);
    expect(result.holders).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it('reports a mid-stream pagination failure while keeping earlier holders', async () => {
    const server = serverReturning([[makeAccount(HOLDER_A, '10')], []], 1);
    const result = await fetchAllHolders(server, asset, 100);
    expect(result.holders).toHaveLength(1);
    expect(result.paginationError).toMatch(/Horizon page request failed/);
  });

  it('reports a first-page failure with no holders', async () => {
    const server = serverReturning([[]], 0);
    const result = await fetchAllHolders(server, asset, 100);
    expect(result.holders).toEqual([]);
    expect(result.pagesFetched).toBe(0);
    expect(result.paginationError).toMatch(/Horizon page request failed/);
  });
});

describe('Issue #229 / ISSUE-169: runner registration', () => {
  it('registers the example with configurable parameters', () => {
    const entry = examples['169-asset-holder-distribution'];
    expect(entry).toBeDefined();
    expect(entry.name).toBe('169-asset-holder-distribution');
    expect(typeof entry.run).toBe('function');
    expect(entry.params?.map((param) => param.name)).toEqual([
      'assetCode',
      'assetIssuer',
      'maxHolders',
      'topN',
    ]);
  });
});
