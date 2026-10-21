import { Keypair } from '@stellar/stellar-sdk';

import {
  buildAsset,
  buildReport,
  classifyOperation,
  fetchAuthorizationHistory,
  formatReport,
  readTrustlineState,
  validateAssetCode,
  validateIssuerPublicKey,
  type AuthorizationHistoryRecord,
  type HorizonOperationRecordLike,
  type IssuerAuthorizationSettings,
  type TrustlineStatus,
} from '../src/examples/262-asset-authorization-audit';

const ISSUER = Keypair.random().publicKey();
const HOLDER = Keypair.random().publicKey();

describe('ISSUE-384: Asset and issuer input validation', () => {
  it('accepts valid asset codes', () => {
    expect(validateAssetCode('USD')).toBe('USD');
    expect(validateAssetCode('USDC')).toBe('USDC');
    expect(validateAssetCode('A12345678901')).toBe('A12345678901');
  });

  it('rejects invalid asset codes', () => {
    expect(() => validateAssetCode('')).toThrow(/Missing asset code/);
    expect(() => validateAssetCode('TOOLONGCODE123')).toThrow(/at most 12/);
    expect(() => validateAssetCode('BAD!CODE')).toThrow(/alphanumeric/);
  });

  it('accepts a valid issuer public key', () => {
    expect(validateIssuerPublicKey(ISSUER)).toBe(ISSUER);
  });

  it('rejects invalid issuer public keys', () => {
    expect(() => validateIssuerPublicKey('')).toThrow(/Missing/);
    expect(() => validateIssuerPublicKey('not-a-key')).toThrow(/Invalid/);
    expect(() => validateIssuerPublicKey('GTOOSHORT')).toThrow(/Invalid/);
  });

  it('builds an Asset from validated input', () => {
    const asset = buildAsset('USDC', ISSUER);
    expect(asset.getCode()).toBe('USDC');
    expect(asset.getIssuer()).toBe(ISSUER);
    expect(asset.isNative()).toBe(false);
  });
});

describe('ISSUE-384: Trustline authorization state', () => {
  it('reports AUTHORIZED when is_authorized is true', () => {
    const state = readTrustlineState(
      {
        id: HOLDER,
        balances: [
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USDC',
            asset_issuer: ISSUER,
            balance: '100',
            is_authorized: true,
          },
        ],
      },
      'USDC',
      ISSUER,
    );
    expect(state.state).toBe('AUTHORIZED');
    expect(state.note).toContain('fully authorized');
  });

  it('reports AUTHORIZED_TO_MAINTAIN_LIABILITIES when only that flag is true', () => {
    const state = readTrustlineState(
      {
        id: HOLDER,
        balances: [
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USDC',
            asset_issuer: ISSUER,
            balance: '0',
            is_authorized: false,
            is_authorized_to_maintain_liabilities: true,
          },
        ],
      },
      'USDC',
      ISSUER,
    );
    expect(state.state).toBe('AUTHORIZED_TO_MAINTAIN_LIABILITIES');
  });

  it('reports UNAUTHORIZED when the trustline exists but is not authorized', () => {
    const state = readTrustlineState(
      {
        id: HOLDER,
        balances: [
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USDC',
            asset_issuer: ISSUER,
            balance: '0',
            is_authorized: false,
          },
        ],
      },
      'USDC',
      ISSUER,
    );
    expect(state.state).toBe('UNAUTHORIZED');
  });

  it('reports NOT_FOUND when no matching trustline exists', () => {
    const state = readTrustlineState(
      {
        id: HOLDER,
        balances: [
          { asset_type: 'credit_alphanum4', asset_code: 'EUR', asset_issuer: ISSUER, balance: '5' },
        ],
      },
      'USDC',
      ISSUER,
    );
    expect(state.state).toBe('NOT_FOUND');
    expect(state.note).toContain('No trustline found');
  });

  it('ignores native balances and other issuers', () => {
    const state = readTrustlineState(
      {
        id: HOLDER,
        balances: [
          { asset_type: 'native', balance: '100' },
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USDC',
            asset_issuer: 'GISSUER2',
            balance: '5',
            is_authorized: true,
          },
        ],
      },
      'USDC',
      ISSUER,
    );
    expect(state.state).toBe('NOT_FOUND');
  });
});

describe('ISSUE-384: Authorization history classification', () => {
  it('classifies set_options as issuer-configuration', () => {
    const record = {
      paging_token: '1',
      transaction_hash: 'abc',
      created_at: '2026-01-01T00:00:00Z',
      source_account: ISSUER,
      type: 'set_options',
      set_flags: [1],
      clear_flags: [],
      set_flags_s: ['auth_required_flag'],
      clear_flags_s: [],
    } as HorizonOperationRecordLike;
    const classified = classifyOperation(record, 'USDC', ISSUER);
    expect(classified).not.toBeNull();
    expect(classified!.category).toBe('issuer-configuration');
    expect(classified!.description).toContain('AUTH_REQUIRED');
  });

  it('classifies allow_trust as trustline-authorization', () => {
    const record = {
      paging_token: '2',
      transaction_hash: 'def',
      created_at: '2026-01-02T00:00:00Z',
      source_account: ISSUER,
      type: 'allow_trust',
      asset_code: 'USDC',
      asset_issuer: ISSUER,
      trustee: HOLDER,
      authorize: true,
    } as HorizonOperationRecordLike;
    const classified = classifyOperation(record, 'USDC', ISSUER);
    expect(classified!.category).toBe('trustline-authorization');
    expect(classified!.description).toContain('authorized');
  });

  it('classifies set_trust_line_flags as trustline-authorization', () => {
    const record = {
      paging_token: '3',
      transaction_hash: 'ghi',
      created_at: '2026-01-03T00:00:00Z',
      source_account: ISSUER,
      type: 'set_trust_line_flags',
      asset_code: 'USDC',
      asset_issuer: ISSUER,
      trustor: HOLDER,
      set_flags: [1],
      clear_flags: [],
    } as HorizonOperationRecordLike;
    const classified = classifyOperation(record, 'USDC', ISSUER);
    expect(classified!.category).toBe('trustline-authorization');
  });

  it('ignores non-authorization operations', () => {
    const record = {
      paging_token: '4',
      transaction_hash: 'jkl',
      created_at: '2026-01-04T00:00:00Z',
      source_account: HOLDER,
      type: 'payment',
    } as HorizonOperationRecordLike;
    expect(classifyOperation(record, 'USDC', ISSUER)).toBeNull();
  });
});

describe('ISSUE-384: Bounded pagination and history retrieval', () => {
  const makePage = (records: HorizonOperationRecordLike[], hasNext: boolean): any => ({
    records,
    next: hasNext ? async () => makePage([], false) : undefined,
  });

  it('retrieves multiple pages and deduplicates records', async () => {
    const op1: HorizonOperationRecordLike = {
      paging_token: '1',
      transaction_hash: 'tx1',
      created_at: '2026-01-01T00:00:00Z',
      source_account: ISSUER,
      type: 'allow_trust',
      asset_code: 'USDC',
      asset_issuer: ISSUER,
      trustee: HOLDER,
      authorize: true,
    };
    const op2 = { ...op1, paging_token: '2', transaction_hash: 'tx2' };
    const server = {
      operations: () => ({
        forAccount: () => ({
          limit: () => ({
            order: () => ({
              call: async () => makePage([op1, op2, op1], true), // op1 duplicated across pages
            }),
          }),
        }),
      }),
    } as any;

    const result = await fetchAuthorizationHistory(server, ISSUER, 'USDC', ISSUER, {
      pageSize: 10,
      maxPages: 5,
    });
    expect(result.records).toHaveLength(2);
    expect(result.pagesRead).toBeGreaterThan(0);
  });

  it('marks incomplete coverage when max pages are reached', async () => {
    const op: HorizonOperationRecordLike = {
      paging_token: '1',
      transaction_hash: 'tx1',
      created_at: '2026-01-01T00:00:00Z',
      source_account: ISSUER,
      type: 'set_options',
      set_flags: [2],
      clear_flags: [],
    };
    const server = {
      operations: () => ({
        forAccount: () => ({
          limit: () => ({
            order: () => ({ call: async () => makePage([op], true) }),
          }),
        }),
      }),
    } as any;

    const result = await fetchAuthorizationHistory(server, ISSUER, 'USDC', ISSUER, {
      pageSize: 10,
      maxPages: 1,
    });
    expect(result.incompleteCoverage).toBe(true);
  });

  it('returns an empty history gracefully', async () => {
    const server = {
      operations: () => ({
        forAccount: () => ({
          limit: () => ({
            order: () => ({ call: async () => makePage([], false) }),
          }),
        }),
      }),
    } as any;

    const result = await fetchAuthorizationHistory(server, ISSUER, 'USDC', ISSUER, {
      pageSize: 10,
      maxPages: 3,
    });
    expect(result.records).toEqual([]);
  });
});

describe('ISSUE-384: Audit report assembly', () => {
  const issuer: IssuerAuthorizationSettings = {
    accountId: ISSUER,
    authRequired: true,
    authRevocable: true,
    authImmutable: false,
    authClawbackEnabled: false,
    flagsSource: 'horizon-account-response',
  };

  const trustline: TrustlineStatus = {
    holderAccount: HOLDER,
    assetCode: 'USDC',
    assetIssuer: ISSUER,
    state: 'AUTHORIZED',
    balance: '100',
    limit: '1000',
    note: 'Fully authorized trustline.',
  };

  const history: AuthorizationHistoryRecord[] = [
    {
      pagingToken: '1',
      transactionHash: 'tx1',
      ledgerSequence: 100,
      closedAt: '2026-01-01T00:00:00Z',
      operationType: 'allow_trust',
      sourceAccount: ISSUER,
      category: 'trustline-authorization',
      description: 'Authorized holder',
      assetCode: 'USDC',
      assetIssuer: ISSUER,
    },
  ];

  it('builds a report with separated sections', () => {
    const report = buildReport('USDC', ISSUER, issuer, trustline, history, []);
    expect(report.asset.code).toBe('USDC');
    expect(report.issuer.authRequired).toBe(true);
    expect(report.trustline?.state).toBe('AUTHORIZED');
    expect(report.history).toHaveLength(1);
    expect(report.sections['current-state']).toContain('USDC');
    expect(report.sections['current-state']).toContain('AUTH_REQUIRED: true');
    expect(report.sections['historical-observations']).toContain('tx1');
    expect(report.sections.interpretation).toContain('Caveats');
  });

  it('formats a readable report', () => {
    const report = buildReport('USDC', ISSUER, issuer, null, [], ['No history found']);
    const formatted = formatReport(report);
    expect(formatted).toContain('Current state');
    expect(formatted).toContain('Historical observations');
    expect(formatted).toContain('Interpretation');
    expect(formatted).toContain('read-only audit');
  });
});
