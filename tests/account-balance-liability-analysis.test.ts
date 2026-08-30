import {
  analyseAccount,
  analysePosition,
  calculateMinimumReserve,
  describeAsset,
  formatAmount,
  isValidAccountId,
  parseAmount,
  type AccountLike,
  type BalanceLine,
} from '../src/examples/170-account-balance-liability-analysis';
import { examples } from '../src/runner/catalog';

const ACCOUNT = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
const ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const HORIZON = 'https://horizon-testnet.stellar.org';

function nativeLine(overrides: Partial<BalanceLine> = {}): BalanceLine {
  return {
    asset_type: 'native',
    balance: '100.0000000',
    buying_liabilities: '0.0000000',
    selling_liabilities: '0.0000000',
    ...overrides,
  };
}

function issuedLine(overrides: Partial<BalanceLine> = {}): BalanceLine {
  return {
    asset_type: 'credit_alphanum4',
    asset_code: 'USDC',
    asset_issuer: ISSUER,
    balance: '500.0000000',
    limit: '1000.0000000',
    buying_liabilities: '0.0000000',
    selling_liabilities: '0.0000000',
    ...overrides,
  };
}

function account(overrides: Partial<AccountLike> = {}): AccountLike {
  return {
    account_id: ACCOUNT,
    sequence: '123456789',
    subentry_count: 2,
    num_sponsored: 0,
    num_sponsoring: 0,
    balances: [nativeLine(), issuedLine()],
    ...overrides,
  };
}

describe('Issue #230 / ISSUE-170: input validation', () => {
  it('accepts a valid account ID and rejects malformed input', () => {
    expect(isValidAccountId(ACCOUNT)).toBe(true);
    expect(isValidAccountId('GINVALID')).toBe(false);
    expect(isValidAccountId(null)).toBe(false);
  });

  it('parses and formats Horizon amounts', () => {
    expect(parseAmount('3.5000000')).toBe(3.5);
    expect(parseAmount('nope')).toBe(0);
    expect(formatAmount(3.5)).toBe('3.5000000');
  });

  it('labels native, issued, and pool-share balance lines', () => {
    expect(describeAsset(nativeLine())).toBe('XLM (native)');
    expect(describeAsset(issuedLine())).toBe('USDC');
    expect(describeAsset({ asset_type: 'liquidity_pool_shares' })).toBe('Liquidity pool shares');
  });
});

describe('Issue #230 / ISSUE-170: minimum reserve', () => {
  it('charges the base entries plus each subentry', () => {
    expect(calculateMinimumReserve(0)).toBe(1);
    expect(calculateMinimumReserve(2)).toBe(2);
  });

  it('exempts sponsored entries and charges sponsored-for-others entries', () => {
    expect(calculateMinimumReserve(4, 2, 0)).toBe(2);
    expect(calculateMinimumReserve(4, 0, 2)).toBe(4);
  });

  it('never returns a negative reserve', () => {
    expect(calculateMinimumReserve(0, 10, 0)).toBe(0);
  });
});

describe('Issue #230 / ISSUE-170: position analysis', () => {
  it('separates ledger-reported values from derived ones', () => {
    const position = analysePosition(
      issuedLine({ buying_liabilities: '100', selling_liabilities: '50' }),
    );
    expect(position.reported.balance).toBe(500);
    expect(position.reported.buyingLiabilities).toBe(100);
    expect(position.reported.sellingLiabilities).toBe(50);
    expect(position.derived.totalLiabilities).toBe(150);
    expect(position.derived.availableAmount).toBe(450);
  });

  it('deducts the minimum reserve from the native balance only', () => {
    const native = analysePosition(nativeLine({ selling_liabilities: '10' }), 5);
    expect(native.derived.reserveDeduction).toBe(5);
    expect(native.derived.availableAmount).toBe(85);

    const issued = analysePosition(issuedLine());
    expect(issued.derived.reserveDeduction).toBe(0);
  });

  it('floors the available amount at zero when everything is committed', () => {
    const position = analysePosition(nativeLine({ balance: '5', selling_liabilities: '10' }), 2);
    expect(position.derived.availableAmount).toBe(0);
  });

  it('computes trustline utilization and headroom from balance plus buying liabilities', () => {
    const position = analysePosition(
      issuedLine({ balance: '500', limit: '1000', buying_liabilities: '200' }),
    );
    expect(position.derived.limitUtilization).toBeCloseTo(70, 6);
    expect(position.derived.limitHeadroom).toBe(300);
    expect(position.derived.nearLimit).toBe(false);
  });

  it('flags a trustline at or above 90% of its limit', () => {
    const position = analysePosition(issuedLine({ balance: '950', limit: '1000' }));
    expect(position.derived.nearLimit).toBe(true);
  });

  it('reports no limit metrics for the native balance', () => {
    const position = analysePosition(nativeLine());
    expect(position.reported.limit).toBeNull();
    expect(position.derived.limitUtilization).toBeNull();
    expect(position.derived.limitHeadroom).toBeNull();
    expect(position.derived.nearLimit).toBe(false);
  });

  it('treats absent authorization flags as authorized', () => {
    expect(analysePosition(issuedLine()).reported.authorized).toBe(true);
    expect(analysePosition(issuedLine({ is_authorized: false })).reported.authorized).toBe(false);
    expect(
      analysePosition(issuedLine({ is_authorized_to_maintain_liabilities: false })).reported
        .authorizedToMaintainLiabilities,
    ).toBe(false);
  });

  it('flags liabilities that are significant relative to the balance', () => {
    const significant = analysePosition(issuedLine({ balance: '100', selling_liabilities: '80' }));
    expect(significant.derived.significantLiabilities).toBe(true);

    const modest = analysePosition(issuedLine({ balance: '100', selling_liabilities: '5' }));
    expect(modest.derived.significantLiabilities).toBe(false);
  });
});

describe('Issue #230 / ISSUE-170: account analysis', () => {
  it('identifies the native balance and issued assets separately', () => {
    const report = analyseAccount(account(), HORIZON);
    expect(report.accountId).toBe(ACCOUNT);
    expect(report.native?.isNative).toBe(true);
    expect(report.derived.issuedAssetCount).toBe(1);
    expect(report.issuedAssets[0].assetCode).toBe('USDC');
  });

  it('computes account-level derived totals', () => {
    const report = analyseAccount(
      account({
        subentry_count: 2,
        balances: [nativeLine({ balance: '100', selling_liabilities: '10' }), issuedLine()],
      }),
      HORIZON,
    );
    expect(report.derived.minimumReserveXlm).toBe(2);
    expect(report.derived.nativeBalance).toBe(100);
    expect(report.derived.nativeAvailable).toBe(88);
    expect(report.derived.nativeSellingLiabilities).toBe(10);
  });

  it('handles accounts with no issued assets', () => {
    const report = analyseAccount(account({ balances: [nativeLine()] }), HORIZON);
    expect(report.issuedAssets).toEqual([]);
    expect(report.derived.issuedAssetCount).toBe(0);
    expect(report.warnings).toContain(
      'Account holds no issued assets; only the native balance is analysed.',
    );
  });

  it('warns about unauthorized trustlines', () => {
    const report = analyseAccount(
      account({ balances: [nativeLine(), issuedLine({ is_authorized: false })] }),
      HORIZON,
    );
    expect(report.derived.unauthorizedTrustlineCount).toBe(1);
    expect(report.warnings.some((w) => w.includes('not authorized'))).toBe(true);
  });

  it('warns about trustlines approaching their limit', () => {
    const report = analyseAccount(
      account({ balances: [nativeLine(), issuedLine({ balance: '999', limit: '1000' })] }),
      HORIZON,
    );
    expect(report.derived.nearLimitTrustlineCount).toBe(1);
    expect(report.warnings.some((w) => w.includes('op_line_full'))).toBe(true);
  });

  it('handles an account with no balance lines at all', () => {
    const report = analyseAccount({ account_id: ACCOUNT, balances: [] }, HORIZON);
    expect(report.native).toBeNull();
    expect(report.derived.nativeAvailable).toBe(0);
    expect(report.warnings.some((w) => w.includes('no native XLM balance line'))).toBe(true);
  });

  it('produces machine-readable JSON', () => {
    const parsed = JSON.parse(JSON.stringify(analyseAccount(account(), HORIZON)));
    expect(parsed.accountId).toBe(ACCOUNT);
    expect(parsed.derived.minimumReserveXlm).toBe(2);
    expect(parsed.native.reported.balance).toBe(100);
  });
});

describe('Issue #230 / ISSUE-170: runner registration', () => {
  it('registers the example with an account ID parameter', () => {
    const entry = examples['170-account-balance-liability-analysis'];
    expect(entry).toBeDefined();
    expect(typeof entry.run).toBe('function');
    expect(entry.params?.map((param) => param.name)).toEqual(['accountId']);
  });
});
