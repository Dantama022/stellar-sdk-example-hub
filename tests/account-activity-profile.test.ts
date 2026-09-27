import {
  buildProfile,
  buildRecentActivity,
  isValidAccountId,
  normalizeLimit,
  observedWindowHours,
  summarizeBalances,
  summarizeOperations,
  summarizePayments,
  summarizeTransactions,
  type ActivityProfile,
  type OperationRecord,
  type PaymentRecord,
  type TransactionRecord,
} from '../src/examples/171-account-activity-profile';
import { examples } from '../src/runner/catalog';

const ACCOUNT = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
const OTHER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const HORIZON = 'https://horizon-testnet.stellar.org';

const okSections = (): ActivityProfile['sections'] => ({
  account: { ok: true, error: null },
  transactions: { ok: true, error: null },
  operations: { ok: true, error: null },
  payments: { ok: true, error: null },
});

const transactions: TransactionRecord[] = [
  {
    hash: 'a',
    ledger: 100,
    created_at: '2026-01-01T00:00:00Z',
    successful: true,
    fee_charged: '100',
    operation_count: 2,
  },
  {
    hash: 'b',
    ledger: 100,
    created_at: '2026-01-01T12:00:00Z',
    successful: false,
    fee_charged: '200',
    operation_count: 1,
  },
  {
    hash: 'c',
    ledger: 101,
    created_at: '2026-01-02T00:00:00Z',
    successful: true,
    fee_charged: '300',
    operation_count: 1,
  },
];

describe('Issue #231 / ISSUE-171: input handling', () => {
  it('validates account IDs', () => {
    expect(isValidAccountId(ACCOUNT)).toBe(true);
    expect(isValidAccountId('GNOPE')).toBe(false);
  });

  it("clamps the record limit into Horizon's accepted range", () => {
    expect(normalizeLimit(25)).toBe(25);
    expect(normalizeLimit('75')).toBe(75);
    expect(normalizeLimit(5000)).toBe(200);
    expect(normalizeLimit(0)).toBe(50);
    expect(normalizeLimit('abc')).toBe(50);
    expect(normalizeLimit(undefined)).toBe(50);
  });
});

describe('Issue #231 / ISSUE-171: transaction statistics', () => {
  it('counts successful and failed transactions', () => {
    const stats = summarizeTransactions(transactions);
    expect(stats.total).toBe(3);
    expect(stats.successful).toBe(2);
    expect(stats.failed).toBe(1);
    expect(stats.successRate).toBeCloseTo(66.6667, 3);
  });

  it('aggregates fees in stroops and XLM', () => {
    const stats = summarizeTransactions(transactions);
    expect(stats.totalFeeStroops).toBe(600);
    expect(stats.totalFeeXlm).toBeCloseTo(0.00006, 10);
    expect(stats.averageFeeStroops).toBe(200);
  });

  it('ignores unusable fee values instead of producing NaN', () => {
    const stats = summarizeTransactions([{ fee_charged: undefined }, { fee_charged: 'x' }]);
    expect(stats.totalFeeStroops).toBe(0);
  });

  it('counts distinct active ledgers and the observed time window', () => {
    const stats = summarizeTransactions(transactions);
    expect(stats.activeLedgers).toBe(2);
    expect(stats.firstObservedAt).toBe('2026-01-01T00:00:00Z');
    expect(stats.lastObservedAt).toBe('2026-01-02T00:00:00Z');
    expect(stats.operationCountFromTransactions).toBe(4);
  });

  it('handles an empty transaction history', () => {
    const stats = summarizeTransactions([]);
    expect(stats).toMatchObject({ total: 0, successful: 0, failed: 0, successRate: 0 });
    expect(stats.firstObservedAt).toBeNull();
  });
});

describe('Issue #231 / ISSUE-171: operation statistics', () => {
  const operations: OperationRecord[] = [
    { type: 'payment', created_at: '2026-01-01T00:00:00Z' },
    { type: 'payment', created_at: '2026-01-02T00:00:00Z' },
    { type: 'create_account', created_at: '2026-01-03T00:00:00Z' },
    { created_at: '2026-01-04T00:00:00Z' },
  ];

  it('groups operations by type', () => {
    const stats = summarizeOperations(operations);
    expect(stats.total).toBe(4);
    expect(stats.byType).toEqual({ payment: 2, create_account: 1, unknown: 1 });
  });

  it('ranks the most frequent operation types', () => {
    const stats = summarizeOperations(operations);
    expect(stats.mostFrequentTypes[0]).toEqual({ type: 'payment', count: 2 });
    expect(stats.mostFrequentTypes).toHaveLength(3);
  });

  it('handles no operations', () => {
    expect(summarizeOperations([])).toEqual({ total: 0, byType: {}, mostFrequentTypes: [] });
  });

  it('lists recent activity newest first', () => {
    const recent = buildRecentActivity(operations, 2);
    expect(recent).toHaveLength(2);
    expect(recent[0].at).toBe('2026-01-04T00:00:00Z');
    expect(recent[1].at).toBe('2026-01-03T00:00:00Z');
  });

  it('marks failed transactions in recent activity', () => {
    const recent = buildRecentActivity([
      { type: 'payment', created_at: '2026-01-01T00:00:00Z', transaction_successful: false },
    ]);
    expect(recent[0].detail).toContain('transaction failed');
  });
});

describe('Issue #231 / ISSUE-171: payment statistics', () => {
  const payments: PaymentRecord[] = [
    { type: 'payment', from: OTHER, to: ACCOUNT, asset_type: 'native', amount: '10' },
    {
      type: 'payment',
      from: ACCOUNT,
      to: OTHER,
      asset_type: 'credit_alphanum4',
      asset_code: 'USDC',
    },
    { type: 'create_account', source_account: OTHER, to: ACCOUNT, asset_type: 'native' },
  ];

  it('splits payments into incoming and outgoing', () => {
    const stats = summarizePayments(payments, ACCOUNT);
    expect(stats.total).toBe(3);
    expect(stats.incoming).toBe(2);
    expect(stats.outgoing).toBe(1);
  });

  it('falls back to the source account when `from` is absent', () => {
    const stats = summarizePayments([{ source_account: ACCOUNT, to: OTHER }], ACCOUNT);
    expect(stats.outgoing).toBe(1);
    expect(stats.incoming).toBe(0);
  });

  it('tracks self-payments in both directions without hiding them', () => {
    const stats = summarizePayments([{ from: ACCOUNT, to: ACCOUNT }], ACCOUNT);
    expect(stats.incoming).toBe(1);
    expect(stats.outgoing).toBe(1);
    expect(stats.selfPayments).toBe(1);
  });

  it('groups payments by asset', () => {
    const stats = summarizePayments(payments, ACCOUNT);
    expect(stats.byAsset).toEqual({ XLM: 2, USDC: 1 });
  });

  it('handles no payments', () => {
    expect(summarizePayments([], ACCOUNT)).toEqual({
      total: 0,
      incoming: 0,
      outgoing: 0,
      selfPayments: 0,
      byAsset: {},
    });
  });
});

describe('Issue #231 / ISSUE-171: balances and activity window', () => {
  it('summarizes balances and trustlines', () => {
    const summary = summarizeBalances({
      balances: [
        { asset_type: 'native', balance: '100' },
        { asset_type: 'credit_alphanum4', asset_code: 'USDC', balance: '5' },
      ],
    });
    expect(summary).toEqual({
      balanceCount: 2,
      nativeBalance: '100',
      trustlineCount: 1,
      assets: ['USDC'],
    });
  });

  it('handles an account with no balances', () => {
    expect(summarizeBalances({})).toEqual({
      balanceCount: 0,
      nativeBalance: null,
      trustlineCount: 0,
      assets: [],
    });
  });

  it('measures the observed window in hours', () => {
    expect(observedWindowHours(summarizeTransactions(transactions))).toBeCloseTo(24, 6);
  });

  it('returns null when the window cannot be measured', () => {
    expect(observedWindowHours(summarizeTransactions([]))).toBeNull();
    expect(
      observedWindowHours(
        summarizeTransactions([{ created_at: '2026-01-01T00:00:00Z', successful: true }]),
      ),
    ).toBeNull();
  });
});

describe('Issue #231 / ISSUE-171: profile assembly', () => {
  const baseInput = {
    accountId: ACCOUNT,
    horizonUrl: HORIZON,
    recordLimit: 50,
    account: { account_id: ACCOUNT, sequence: '42', subentry_count: 1, balances: [] },
    transactions,
    operations: [{ type: 'payment', created_at: '2026-01-01T00:00:00Z' }],
    payments: [{ from: OTHER, to: ACCOUNT }],
    sections: okSections(),
  };

  it('assembles a complete profile', () => {
    const profile = buildProfile(baseInput);
    expect(profile.accountId).toBe(ACCOUNT);
    expect(profile.account.sequence).toBe('42');
    expect(profile.transactions.total).toBe(3);
    expect(profile.operations.total).toBe(1);
    expect(profile.payments.incoming).toBe(1);
    expect(profile.incompleteSections).toEqual([]);
  });

  it('derives operations per transaction and an activity rate', () => {
    const profile = buildProfile(baseInput);
    expect(profile.derived.operationsPerTransaction).toBeCloseTo(1 / 3, 6);
    expect(profile.derived.observedWindowHours).toBeCloseTo(24, 6);
    expect(profile.derived.transactionsPerDay).toBeCloseTo(3, 6);
  });

  it('lists sections that failed rather than reporting silent zeros', () => {
    const profile = buildProfile({
      ...baseInput,
      operations: [],
      payments: [],
      sections: {
        ...okSections(),
        operations: { ok: false, error: 'rate limited' },
        payments: { ok: false, error: 'timeout' },
      },
    });
    expect(profile.incompleteSections).toEqual(['operations', 'payments']);
    expect(profile.sections.operations.error).toBe('rate limited');
  });

  it('handles an account with no history', () => {
    const profile = buildProfile({
      ...baseInput,
      transactions: [],
      operations: [],
      payments: [],
    });
    expect(profile.transactions.total).toBe(0);
    expect(profile.derived.operationsPerTransaction).toBe(0);
    expect(profile.derived.transactionsPerDay).toBeNull();
    expect(profile.recentActivity).toEqual([]);
  });

  it('produces a complete machine-readable profile', () => {
    const parsed = JSON.parse(JSON.stringify(buildProfile(baseInput)));
    expect(parsed.accountId).toBe(ACCOUNT);
    expect(parsed.transactions.totalFeeStroops).toBe(600);
    expect(parsed.sections.account.ok).toBe(true);
    expect(typeof parsed.observedAt).toBe('string');
  });
});

describe('Issue #231 / ISSUE-171: runner registration', () => {
  it('registers the example with account and limit parameters', () => {
    const entry = examples['171-account-activity-profile'];
    expect(entry).toBeDefined();
    expect(typeof entry.run).toBe('function');
    expect(entry.params?.map((param) => param.name)).toEqual(['accountId', 'limit']);
  });
});
