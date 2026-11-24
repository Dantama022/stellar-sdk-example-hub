import { Asset, Horizon } from '@stellar/stellar-sdk';
import {
  buildAuthorizationImpactReport,
  extractTrustline,
  fetchAllTrustlines,
  fetchAuthorizationHistory,
  formatAuthorizationImpactReport,
  getIssuerAuthorizationConfig,
  getTrustlineAuthorizationState,
  normalizeAuthorizationOperation,
  simulateAuthorizationImpact,
  summarizeTrustlineAuthorization,
  validateAssetIdentity,
  type AssetTrustline,
} from '../src/examples/265-authorization-revocation-impact';
import { examples } from '../src/runner/catalog';

const ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const HOLDER_A = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
const HOLDER_B = 'GC4ZWNILJFLN22KU7UQIEB5TIVMHEUXYEIKO5J2AJAGQWI4FYJPGGXYV';
const USDC = new Asset('USDC', ISSUER);

function trustline(
  account: string,
  balance: string,
  state: AssetTrustline['state'],
): AssetTrustline {
  const units = BigInt(balance.replace('.', '').padEnd(balance.includes('.') ? 0 : 7, '0'));
  return {
    account,
    assetCode: 'USDC',
    assetIssuer: ISSUER,
    balance: balance.includes('.') ? balance : `${balance}.0000000`,
    balanceUnits: units.toString(),
    limit: '1000.0000000',
    buyingLiabilities: '0.0000000',
    sellingLiabilities: '0.0000000',
    state,
  };
}

function accountRecord(
  accountId: string,
  balance: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    account_id: accountId,
    balances: [
      { asset_type: 'native', balance: '100.0000000' },
      {
        asset_type: 'credit_alphanum4',
        asset_code: 'USDC',
        asset_issuer: ISSUER,
        balance,
        limit: '1000.0000000',
        ...overrides,
      },
    ],
  };
}

describe('265-authorization-revocation-impact: validation and issuer flags', () => {
  it('validates the asset identity', () => {
    expect(validateAssetIdentity('USDC', ISSUER)).toEqual({
      assetCode: 'USDC',
      assetIssuer: ISSUER,
    });
    expect(() => validateAssetIdentity('BAD-CODE', ISSUER)).toThrow(/Invalid asset code/);
    expect(() => validateAssetIdentity('USDC', 'invalid')).toThrow(/Invalid issuer/);
    expect(() => validateAssetIdentity('XLM', ISSUER)).toThrow(/native asset/);
  });

  it('maps authorization flags to an authorization mode', () => {
    expect(getIssuerAuthorizationConfig({}).authorizationMode).toBe('not_required');
    expect(
      getIssuerAuthorizationConfig({
        auth_required: true,
        auth_revocable: true,
      }).authorizationMode,
    ).toBe('revocable');
    expect(
      getIssuerAuthorizationConfig({
        auth_required: true,
        auth_revocable: false,
      }).authorizationMode,
    ).toBe('locked');
    expect(
      getIssuerAuthorizationConfig({
        auth_required: true,
        auth_revocable: true,
        auth_immutable: true,
      }).authorizationMode,
    ).toBe('immutable');
  });

  it('reports clawback separately from revocation and warns about locked flags', () => {
    const config = getIssuerAuthorizationConfig({
      auth_required: true,
      auth_revocable: false,
      auth_clawback_enabled: true,
    });
    expect(config.clawbackStatus).toBe('enabled');
    expect(config.authClawbackEnabled).toBe(true);
    expect(config.warnings.join(' ')).toContain('cannot be revoked');
  });
});

describe('265-authorization-revocation-impact: trustline retrieval', () => {
  it('extracts authorized, maintain-liabilities, and unauthorized trustlines', () => {
    expect(getTrustlineAuthorizationState({ is_authorized: true })).toBe('AUTHORIZED');
    expect(
      getTrustlineAuthorizationState({
        is_authorized: false,
        is_authorized_to_maintain_liabilities: true,
      }),
    ).toBe('AUTHORIZED_TO_MAINTAIN_LIABILITIES');
    expect(
      getTrustlineAuthorizationState({
        is_authorized: false,
        is_authorized_to_maintain_liabilities: false,
      }),
    ).toBe('UNAUTHORIZED');
    expect(getTrustlineAuthorizationState({})).toBe('AUTHORIZED');
  });

  it('extracts balances, limits, liabilities, and authorization state', () => {
    const extracted = extractTrustline(
      accountRecord(HOLDER_A, '125.0000000', {
        is_authorized_to_maintain_liabilities: true,
        buying_liabilities: '2.0000000',
        selling_liabilities: '3.0000000',
      }),
      'USDC',
      ISSUER,
    );
    expect(extracted).toMatchObject({
      account: HOLDER_A,
      balance: '125.0000000',
      balanceUnits: '1250000000',
      state: 'AUTHORIZED_TO_MAINTAIN_LIABILITIES',
      buyingLiabilities: '2.0000000',
      sellingLiabilities: '3.0000000',
    });
  });

  it('ignores accounts without a matching trustline and malformed balances safely', () => {
    expect(
      extractTrustline(
        accountRecord(HOLDER_A, '1', { asset_issuer: 'other' }),
        'USDC',
        ISSUER,
      ),
    ).toBeNull();
    const malformed = extractTrustline(
      accountRecord(HOLDER_A, 'not-a-number', { is_authorized: true }),
      'USDC',
      ISSUER,
    );
    expect(malformed?.balanceUnits).toBe('0');
  });

  it('paginates through multiple trustline pages', async () => {
    const firstPage = {
      records: [accountRecord(HOLDER_A, '1.0000000')],
      next: jest.fn(),
    };
    const secondPage = {
      records: [accountRecord(HOLDER_B, '2.0000000')],
      next: jest.fn(),
    };
    firstPage.next.mockResolvedValue(secondPage);
    secondPage.next.mockResolvedValue({ records: [], next: jest.fn() });
    const server = {
      accounts: () => ({
        forAsset: () => ({
          limit: () => ({
            call: jest.fn().mockResolvedValue(firstPage),
          }),
        }),
      }),
    } as unknown as Horizon.Server;

    const result = await fetchAllTrustlines(server, USDC, 10);
    expect(result.pagesFetched).toBe(2);
    expect(result.trustlines).toHaveLength(2);
    expect(result.paginationError).toBeNull();
  });
});

describe('265-authorization-revocation-impact: statistics and impact', () => {
  const lines = [
    trustline(HOLDER_A, '100.0000000', 'AUTHORIZED'),
    trustline(HOLDER_B, '40.0000000', 'AUTHORIZED_TO_MAINTAIN_LIABILITIES'),
    trustline('GDIFFERENT', '0.0000000', 'UNAUTHORIZED'),
  ];

  it('summarizes authorized and unauthorized balances', () => {
    const stats = summarizeTrustlineAuthorization(lines);
    expect(stats.totalTrustlines).toBe(3);
    expect(stats.authorizedCount).toBe(1);
    expect(stats.maintainLiabilitiesCount).toBe(1);
    expect(stats.unauthorizedCount).toBe(1);
    expect(stats.totalBalance).toBe('140.0000000');
    expect(stats.authorizedBalance).toBe('100.0000000');
    expect(stats.unauthorizedBalance).toBe('0.0000000');
    expect(stats.nonZeroAccounts).toEqual([HOLDER_A, HOLDER_B].sort());
  });

  it('projects revocation impact and warns about nonzero balances', () => {
    const impact = simulateAuthorizationImpact(lines, 'revoke');
    expect(impact.affectedTrustlineCount).toBe(2);
    expect(impact.aggregateAffectedBalance).toBe('140.0000000');
    expect(impact.accountsWithNonzeroBalances).toEqual([HOLDER_A, HOLDER_B].sort());
    expect(impact.changes.every((change) => change.proposedState === 'UNAUTHORIZED')).toBe(true);
    expect(impact.assumptions.join(' ')).toContain('does not guarantee removal');
  });

  it('supports target accounts and reports missing targets', () => {
    const impact = simulateAuthorizationImpact(lines, 'revoke', [HOLDER_A, 'GMISSING']);
    expect(impact.affectedAccounts).toEqual([HOLDER_A]);
    expect(impact.missingTargetAccounts).toEqual(['GMISSING']);
    expect(impact.targetAccountCount).toBe(2);
  });

  it('supports authorize and maintain-liabilities proposals', () => {
    const authorize = simulateAuthorizationImpact(lines, 'authorize');
    expect(authorize.affectedTrustlineCount).toBe(2);
    const maintain = simulateAuthorizationImpact(lines, 'maintain_liabilities');
    expect(
      maintain.changes.some(
        (change) => change.proposedState === 'AUTHORIZED_TO_MAINTAIN_LIABILITIES',
      ),
    ).toBe(true);
  });

  it('builds the full report with issuer flags, history, and warnings', () => {
    const report = buildAuthorizationImpactReport({
      assetCode: 'USDC',
      assetIssuer: ISSUER,
      issuerAccount: {
        account_id: ISSUER,
        flags: {
          auth_required: true,
          auth_revocable: true,
          auth_clawback_enabled: true,
        },
      },
      trustlines: lines,
      proposedChange: 'revoke',
      targetAccounts: [HOLDER_A],
      history: {
        changes: [
          {
            operationId: '1',
            operationType: 'set_trust_line_flags',
            createdAt: '2026-01-02T03:04:05Z',
            ledger: 100,
            sourceAccount: ISSUER,
            trustor: HOLDER_A,
            assetCode: 'USDC',
            assetIssuer: ISSUER,
            description: 'Trustline flags changed.',
          },
        ],
        pagesFetched: 1,
        truncated: false,
        error: null,
      },
    });
    expect(report.issuerAuthorization.authorizationMode).toBe('revocable');
    expect(report.clawbackConfigurationStatus).toBe('enabled');
    expect(report.impact.affectedTrustlineCount).toBe(1);
    expect(report.overallImpactAssessment).toBe('medium');
    expect(report.warnings.join(' ')).toContain('different operation');
    expect(report.historyStatus).toBe('retrieved');
    expect(formatAuthorizationImpactReport(report)).toContain('Overall impact assessment');
  });

  it('reports missing issuer and history failures as unknown impact', () => {
    const report = buildAuthorizationImpactReport({
      assetCode: 'USDC',
      assetIssuer: ISSUER,
      issuerAccount: null,
      issuerError: 'not found',
      trustlines: [],
      history: {
        changes: [],
        pagesFetched: 0,
        truncated: false,
        error: 'history unavailable',
      },
    });
    expect(report.issuerAccountExists).toBe(false);
    expect(report.overallImpactAssessment).toBe('unknown');
    expect(report.historyStatus).toBe('failed');
    expect(report.warnings.join(' ')).toContain('Issuer account retrieval failed');
  });

  it('normalizes authorization operations and filters unrelated operations', () => {
    expect(
      normalizeAuthorizationOperation({
        type: 'payment',
        id: '1',
      }),
    ).toBeNull();
    expect(
      normalizeAuthorizationOperation({
        type: 'set_trust_line_flags',
        id: '2',
        trustor: HOLDER_A,
        created_at: '2026-01-02T03:04:05Z',
        ledger: 10,
      }),
    ).toMatchObject({
      operationId: '2',
      trustor: HOLDER_A,
      ledger: 10,
    });
    expect(
      normalizeAuthorizationOperation({
        type: 'set_options',
        id: '3',
        set_flags: 3,
      }),
    ).not.toBeNull();
  });

  it('retrieves authorization history pages', async () => {
    const server = {
      operations: () => ({
        forAccount: () => ({
          order: () => ({
            limit: () => ({
              call: jest.fn().mockResolvedValue({
                records: [
                  {
                    type: 'set_trust_line_flags',
                    id: '1',
                    trustor: HOLDER_A,
                    created_at: '2026-01-02T03:04:05Z',
                  },
                  { type: 'payment', id: 'ignored' },
                ],
                next: jest.fn().mockResolvedValue({ records: [], next: jest.fn() }),
              }),
            }),
          }),
        }),
      }),
    } as unknown as Horizon.Server;
    const history = await fetchAuthorizationHistory(server, ISSUER, 10);
    expect(history.changes).toHaveLength(1);
    expect(history.pagesFetched).toBe(1);
    expect(history.error).toBeNull();
  });

  it('serializes the report as JSON and registers the example', () => {
    const report = buildAuthorizationImpactReport({
      assetCode: 'USDC',
      assetIssuer: ISSUER,
      issuerAccount: { account_id: ISSUER, flags: { auth_required: true, auth_revocable: true } },
      trustlines: lines,
    });
    const parsed = JSON.parse(JSON.stringify(report));
    expect(parsed.assetCode).toBe('USDC');
    expect(parsed.impact.affectedTrustlineCount).toBe(2);

    expect(examples['265-authorization-revocation-impact']).toBeDefined();
    expect(typeof examples['265-authorization-revocation-impact'].run).toBe('function');
  });
});
