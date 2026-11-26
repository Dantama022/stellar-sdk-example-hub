import { Keypair } from '@stellar/stellar-sdk';
import {
  analyzeTrustlineExposure,
  fetchAccountTrustlines,
  fetchIssuerContexts,
  formatTrustlineExposureReport,
  runTrustlineExposureAudit,
  TrustlineDataSource,
} from '../src/examples/262-asset-trustline-exposure';
import { examples } from '../src/runner/catalog';

const ACCOUNT_ID = Keypair.random().publicKey();
const ISSUER_A = Keypair.random().publicKey();
const ISSUER_B = Keypair.random().publicKey();
const HORIZON_URL = 'https://horizon-testnet.stellar.org';

describe('262-asset-trustline-exposure', () => {
  it('analyzes an account with multiple issued assets and distinct balances/limits', async () => {
    const dataSource: TrustlineDataSource = {
      async loadAccount() {
        return {
          account_id: ACCOUNT_ID,
          balances: [
            { asset_type: 'native', balance: '100.0000000' },
            {
              asset_type: 'credit_alphanum4',
              asset_code: 'USDC',
              asset_issuer: ISSUER_A,
              balance: '250.5000000',
              limit: '10000.0000000',
              is_authorized: true,
              is_clawback_enabled: false,
            },
            {
              asset_type: 'credit_alphanum4',
              asset_code: 'EURC',
              asset_issuer: ISSUER_B,
              balance: '10.0000000',
              limit: '500.0000000',
              is_authorized: true,
              is_clawback_enabled: false,
            },
          ],
        };
      },
      async loadIssuerAccount(issuerId) {
        return {
          account_id: issuerId,
          flags: {
            auth_required: false,
            auth_revocable: false,
            auth_immutable: true,
            auth_clawback_enabled: false,
          },
        };
      },
    };

    const report = await runTrustlineExposureAudit(ACCOUNT_ID, HORIZON_URL, dataSource);
    expect(report.nativeXlmBalance).toBe('100.0000000');
    expect(report.trustlineCount).toBe(2);
    expect(report.uniqueAssetIdentities).toBe(2);
    expect(report.holdings.map((h) => [h.assetCode, h.balance, h.limit])).toEqual([
      ['USDC', '250.5000000', '10000.0000000'],
      ['EURC', '10.0000000', '500.0000000'],
    ]);
  });

  it('treats two issuers using the same asset code as distinct assets and flags duplicates', async () => {
    const retrieval = await fetchAccountTrustlines(ACCOUNT_ID, HORIZON_URL, {
      async loadAccount() {
        return {
          account_id: ACCOUNT_ID,
          balances: [
            { asset_type: 'native', balance: '50.0000000' },
            {
              asset_type: 'credit_alphanum4',
              asset_code: 'USD',
              asset_issuer: ISSUER_A,
              balance: '100.0000000',
              limit: '1000.0000000',
              is_authorized: true,
            },
            {
              asset_type: 'credit_alphanum4',
              asset_code: 'USD',
              asset_issuer: ISSUER_B,
              balance: '200.0000000',
              limit: '2000.0000000',
              is_authorized: true,
            },
          ],
        };
      },
    });

    const report = analyzeTrustlineExposure(retrieval);
    expect(report.trustlineCount).toBe(2);
    expect(report.uniqueAssetIdentities).toBe(2);
    expect(report.holdings.map((h) => h.assetIdentity)).toEqual([
      `USD:${ISSUER_A}`,
      `USD:${ISSUER_B}`,
    ]);
    expect(report.duplicateAssetCodes).toEqual([{ assetCode: 'USD', issuers: [ISSUER_A, ISSUER_B] }]);
    expect(report.holdings.every((h) => h.hasDuplicateAssetCode)).toBe(true);
  });

  it('identifies trustlines with authorization restrictions and clawback enabled', async () => {
    const retrieval = await fetchAccountTrustlines(ACCOUNT_ID, HORIZON_URL, {
      async loadAccount() {
        return {
          account_id: ACCOUNT_ID,
          balances: [
            { asset_type: 'native', balance: '20.0000000' },
            {
              asset_type: 'credit_alphanum4',
              asset_code: 'RWA',
              asset_issuer: ISSUER_A,
              balance: '5.0000000',
              limit: '100.0000000',
              is_authorized: false,
              is_authorized_to_maintain_liabilities: false,
              is_clawback_enabled: true,
            },
            {
              asset_type: 'credit_alphanum4',
              asset_code: 'BOND',
              asset_issuer: ISSUER_B,
              balance: '15.0000000',
              limit: '100.0000000',
              is_authorized: false,
              is_authorized_to_maintain_liabilities: true,
            },
          ],
        };
      },
    });

    const report = analyzeTrustlineExposure(retrieval);
    expect(report.holdings[0].authorizationState).toBe('unauthorized');
    expect(report.holdings[0].reviewFlags).toContain('trustline_unauthorized');
    expect(report.holdings[0].reviewFlags).toContain('clawback_enabled');
    expect(report.holdings[1].authorizationState).toBe('authorized_to_maintain_liabilities');
    expect(report.holdings[1].reviewFlags).toContain('authorized_to_maintain_liabilities_only');
  });

  it('handles empty trustline collections cleanly', async () => {
    const retrieval = await fetchAccountTrustlines(ACCOUNT_ID, HORIZON_URL, {
      async loadAccount() {
        return {
          account_id: ACCOUNT_ID,
          balances: [{ asset_type: 'native', balance: '10.0000000' }],
        };
      },
    });

    const report = analyzeTrustlineExposure(retrieval);
    expect(report.trustlineCount).toBe(0);
    expect(report.holdings).toEqual([]);
    expect(formatTrustlineExposureReport(report)).toContain('(no issued-asset trustlines found)');
  });

  it('supports multi-page trustline retrieval and reports interrupted pagination errors', async () => {
    const multiPageSource: TrustlineDataSource = {
      async loadAccount() {
        throw new Error('not used');
      },
      async loadTrustlinePages() {
        return {
          records: [
            { asset_type: 'native', balance: '25.0000000' },
            {
              asset_type: 'credit_alphanum4',
              asset_code: 'AAA',
              asset_issuer: ISSUER_A,
              balance: '1.0000000',
              limit: '10.0000000',
              is_authorized: true,
            },
          ],
          async next() {
            return {
              records: [
                {
                  asset_type: 'credit_alphanum4',
                  asset_code: 'BBB',
                  asset_issuer: ISSUER_B,
                  balance: '2.0000000',
                  limit: '20.0000000',
                  is_authorized: true,
                },
              ],
            };
          },
        };
      },
    };

    const retrieval = await fetchAccountTrustlines(ACCOUNT_ID, HORIZON_URL, multiPageSource);
    expect(retrieval.pagesFetched).toBe(2);
    expect(retrieval.paginationComplete).toBe(true);
    expect(retrieval.trustlines).toHaveLength(2);

    const failingPageSource: TrustlineDataSource = {
      async loadAccount() {
        throw new Error('not used');
      },
      async loadTrustlinePages() {
        return {
          records: [{ asset_type: 'native', balance: '25.0000000' }],
          async next() {
            throw new Error('504 Gateway Timeout');
          },
        };
      },
    };

    await expect(fetchAccountTrustlines(ACCOUNT_ID, HORIZON_URL, failingPageSource)).rejects.toThrow(
      /Interrupted pagination after 1 page\(s\)/,
    );
  });

  it('handles missing issuer context and network errors without fabricating safety claims', async () => {
    const contexts = await fetchIssuerContexts(
      [
        {
          asset_type: 'credit_alphanum4',
          asset_code: 'USDC',
          asset_issuer: ISSUER_A,
          balance: '10.0000000',
        },
      ],
      {
        async loadAccount() {
          throw new Error('unused');
        },
        async loadIssuerAccount() {
          throw new Error('Horizon timeout');
        },
      },
    );

    expect(contexts.get(ISSUER_A)?.status).toBe('unavailable');
    expect(contexts.get(ISSUER_A)?.error).toContain('Horizon timeout');

    const report = analyzeTrustlineExposure(
      {
        accountId: ACCOUNT_ID,
        networkUrl: HORIZON_URL,
        nativeBalance: '10.0000000',
        trustlines: [
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USDC',
            asset_issuer: ISSUER_A,
            balance: '10.0000000',
            limit: '100.0000000',
            is_authorized: true,
          },
        ],
        otherBalances: [],
        pagesFetched: 1,
        paginationComplete: true,
        warnings: [],
      },
      contexts,
    );

    expect(report.missingInformation.some((m) => m.includes('Horizon timeout'))).toBe(true);
    const rendered = formatTrustlineExposureReport(report);
    expect(rendered).toContain('Disclaimer:');
    expect(rendered).toContain('market value');
    expect(JSON.parse(JSON.stringify(report)).accountId).toBe(ACCOUNT_ID);
  });

  it('rejects invalid account identifiers', async () => {
    await expect(
      fetchAccountTrustlines('NOT_A_VALID_KEY', HORIZON_URL, {
        async loadAccount() {
          throw new Error('should not be called');
        },
      }),
    ).rejects.toThrow(/Invalid Stellar account public key/);
  });

  it('is registered in the example catalog', () => {
    expect(examples['262-asset-trustline-exposure']).toBeDefined();
  });
});
