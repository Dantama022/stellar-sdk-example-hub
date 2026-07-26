import * as ex1 from '../src/examples/01-create-account';
import * as ex2 from '../src/examples/02-payment';
import * as ex3 from '../src/examples/03-create-trustline';
import * as ex4 from '../src/examples/04-multisig';
import * as ex5 from '../src/examples/05-soroban-invoke';
import * as ex7 from '../src/examples/07-claimable-balances';
import * as ex8 from '../src/examples/08-liquidity-pools';
import * as ex9 from '../src/examples/09-fee-bump';
import * as ex11 from '../src/examples/11-sponsored-reserves';
import * as ex12 from '../src/examples/12-asset-issuance';
import * as ex14 from '../src/examples/14-time-locked-escrow';
import * as ex16 from '../src/examples/16-batched-operations';
import * as ex17 from '../src/examples/17-offline-signing';
import * as ex18 from '../src/examples/18-soroban-errors';
import * as ex19 from '../src/examples/19-horizon-streaming';
import * as ex20 from '../src/examples/20-sep10-authentication';
import * as ex21 from '../src/examples/21-sep24-deposit-withdrawal';
import * as ex22a from '../src/examples/22-advanced-multisig';
import * as ex22 from '../src/examples/22-manage-buy-offer';
import * as ex23 from '../src/examples/23-manage-data-entries';
import * as ex24 from '../src/examples/24-create-passive-sell-offer';
import * as ex25 from '../src/examples/25-account-flags';
import * as ex26 from '../src/examples/26-sponsored-claimable-balance';
import * as ex45 from '../src/examples/45-horizon-effects';
import * as ex47 from '../src/examples/47-account-data-entries';
import * as ex48 from '../src/examples/48-asset-authorization-flags';
import * as ex49 from '../src/examples/49-claimable-balance-inspection';
import * as ex51 from '../src/examples/51-failed-transaction-analysis';
import * as ex54 from '../src/examples/54-fee-stats';
import * as ex56 from '../src/examples/56-account-flags-inspection';
import * as ex57 from '../src/examples/57-account-reserve-calculator';
import * as ex58 from '../src/examples/58-account-relationship-discovery';

import { examples } from '../src/runner/catalog';

describe('Examples Exports', () => {
  it('should export a run function', () => {
    for (const mod of [
      ex1,
      ex2,
      ex3,
      ex4,
      ex5,
      ex7,
      ex8,
      ex9,
      ex11,
      ex12,
      ex14,
      ex16,
      ex17,
      ex18,
      ex19,
      ex20,
      ex21,
      ex22a,
      ex22,
      ex23,
      ex24,
      ex25,
      ex26,
      ex45,
      ex47,
      ex48,
      ex49,
      ex51,
      ex54,
      ex56,
      ex57,
      ex58,
    ]) {
      expect(typeof mod.run).toBe('function');
    }
  });

  it('should register the examples in the catalog', () => {
    for (const key of [
      '07-claimable-balances',
      '08-liquidity-pools',
      '09-fee-bump',
      '11-sponsored-reserves',
      '14-time-locked-escrow',
      '16-batched-operations',
      '19-horizon-streaming',
      '20-sep10-authentication',
      '21-sep24-deposit-withdrawal',
      '22-advanced-multisig',
      '22-manage-buy-offer',
      '23-manage-data-entries',
      '24-create-passive-sell-offer',
      '25-account-flags',
      '26-sponsored-claimable-balance',
      '45-horizon-effects',
      '47-account-data-entries',
      '48-asset-authorization-flags',
      '49-claimable-balance-inspection',
      '51-failed-transaction-analysis',
      '54-fee-stats',
      '56-account-flags-inspection',
      '57-account-reserve-calculator',
      '58-account-relationship-discovery',
    ]) {
      expect(examples[key]).toBeDefined();
    }
  });
});

describe('ISSUE-058: Account Relationship Discovery Unit Tests', () => {
  const accountId = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

  it('extracts signer relationships correctly', () => {
    const signers = [
      { key: accountId, weight: 1 },
      { key: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFXYCZLYF3436GTYOWD4S', weight: 2 },
    ];
    const extracted = ex58.extractSigners(signers, accountId);
    expect(extracted).toHaveLength(2);
    expect(extracted[0].type).toBe('primary');
    expect(extracted[1].type).toBe('co-signer');
  });

  it('extracts trustline asset issuers correctly', () => {
    const balances = [
      { asset_type: 'native', balance: '100' },
      {
        asset_type: 'credit_alphanum4',
        asset_code: 'USDC',
        asset_issuer: 'GBBD47IF6LWK2P7MDEVSCWR7DPUWV3NY3DTQEVFL4TWVCKPXA26VCCKM',
        balance: '500',
      },
    ];
    const issuers = ex58.extractAssetIssuers(balances);
    expect(issuers).toHaveLength(1);
    expect(issuers[0].assetCode).toBe('USDC');
  });

  it('extracts sponsorships correctly', () => {
    const sponsorships = ex58.extractSponsorships({
      sponsor: 'GBSPMXXXX',
      num_sponsored: 2,
      num_sponsoring: 1,
    });
    expect(sponsorships.accountSponsor).toBe('GBSPMXXXX');
    expect(sponsorships.numSponsored).toBe(2);
    expect(sponsorships.numSponsoring).toBe(1);
  });

  it('deduplicates transaction counterparties', () => {
    const ops = [
      { source_account: accountId, to: 'GBPARTY1' },
      { source_account: 'GBPARTY1', to: accountId },
      { funder: 'GBPARTY2', account: accountId },
    ];
    const counterparties = ex58.extractCounterparties(ops, accountId);
    expect(counterparties).toContain('GBPARTY1');
    expect(counterparties).toContain('GBPARTY2');
    expect(counterparties.filter((c) => c === 'GBPARTY1')).toHaveLength(1);
  });

  it('handles empty relationship categories safely', () => {
    const summary = ex58.formatRelationshipSummary({
      accountId,
      signers: [],
      assetIssuers: [],
      sponsorships: { numSponsored: 0, numSponsoring: 0 },
      transactionCounterparties: [],
    });
    expect(summary).toContain(accountId);
    expect(summary).toContain('No signers found');
  });
});

describe('ISSUE-056: Account Flags Inspection Unit Tests', () => {
  const accountId = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

  it('maps every supported flag to a human-readable description', () => {
    const described = ex56.describeAccountFlags({ auth_required: true });

    expect(described.map((f) => f.key)).toEqual([
      'auth_required',
      'auth_revocable',
      'auth_immutable',
      'auth_clawback_enabled',
    ]);
    for (const flag of described) {
      expect(flag.meaning.length).toBeGreaterThan(0);
      expect(flag.whenUnset.length).toBeGreaterThan(0);
      expect(flag.constantName).toMatch(/_FLAG$/);
    }
  });

  it('parses enabled and default flag states from Horizon booleans', () => {
    const enabled = ex56.describeAccountFlags({
      auth_required: true,
      auth_revocable: true,
      auth_immutable: false,
      auth_clawback_enabled: true,
    });
    const byKey = Object.fromEntries(enabled.map((f) => [f.key, f.enabled]));

    expect(byKey.auth_required).toBe(true);
    expect(byKey.auth_revocable).toBe(true);
    expect(byKey.auth_immutable).toBe(false);
    expect(byKey.auth_clawback_enabled).toBe(true);
  });

  it('treats a missing flags object as all defaults', () => {
    const described = ex56.describeAccountFlags(undefined);
    expect(described.every((f) => !f.enabled)).toBe(true);
    expect(ex56.computeRawFlagValue(described)).toBe(0);
  });

  it('reconstructs the raw on-ledger flag bitmask', () => {
    // AUTH_REQUIRED (1) + AUTH_REVOCABLE (2) + AUTH_CLAWBACK_ENABLED (8) = 11
    const described = ex56.describeAccountFlags({
      auth_required: true,
      auth_revocable: true,
      auth_clawback_enabled: true,
    });
    expect(ex56.computeRawFlagValue(described)).toBe(11);
  });

  it('reads the master key weight from the signer list', () => {
    expect(ex56.getMasterKeyWeight(accountId, [{ key: accountId, weight: 3 }])).toBe(3);
    expect(
      ex56.getMasterKeyWeight(accountId, [
        { key: accountId, weight: 0 },
        { key: 'GBOTHERSIGNER', weight: 2 },
      ]),
    ).toBe(0);
    expect(ex56.getMasterKeyWeight(accountId, [])).toBe(0);
  });

  it('reports no findings for an account with default flags', () => {
    const report = ex56.buildAccountFlagsReport({
      id: accountId,
      flags: {},
      signers: [{ key: accountId, weight: 1 }],
    });

    expect(report.usesDefaults).toBe(true);
    expect(report.rawFlagValue).toBe(0);
    expect(report.notableFindings).toEqual([]);
    expect(ex56.formatFlagsReport(report)).toContain('No restrictive or unusual configuration');
  });

  it('identifies restrictive issuer configurations', () => {
    const report = ex56.buildAccountFlagsReport({
      id: accountId,
      flags: {
        auth_required: true,
        auth_revocable: true,
        auth_immutable: true,
        auth_clawback_enabled: true,
      },
      signers: [{ key: accountId, weight: 1 }],
    });

    expect(report.usesDefaults).toBe(false);
    expect(report.rawFlagValue).toBe(15);
    expect(report.notableFindings.join(' ')).toContain('AUTH_IMMUTABLE is set');
    expect(report.notableFindings.join(' ')).toContain('AUTH_REQUIRED + AUTH_REVOCABLE');
    expect(report.notableFindings.join(' ')).toContain('AUTH_CLAWBACK_ENABLED is set');
  });

  it('flags clawback enabled without auth_revocable as unusual', () => {
    const described = ex56.describeAccountFlags({ auth_clawback_enabled: true });
    const findings = ex56.identifyNotableConfigurations(described, 1);
    expect(findings.join(' ')).toContain('clawback is enabled without AUTH_REVOCABLE');
  });

  it('detects a permanently locked account', () => {
    const report = ex56.buildAccountFlagsReport({
      id: accountId,
      flags: { auth_immutable: true },
      signers: [{ key: accountId, weight: 0 }],
    });

    expect(report.masterKeyWeight).toBe(0);
    expect(report.notableFindings.join(' ')).toContain('no other signers exist');
    expect(report.notableFindings.join(' ')).toContain('locked issuer');
  });

  it('notes when control shifts to additional signers', () => {
    const report = ex56.buildAccountFlagsReport({
      id: accountId,
      flags: {},
      signers: [
        { key: accountId, weight: 0 },
        { key: 'GBOTHERSIGNER', weight: 2 },
      ],
    });

    expect(report.notableFindings.join(' ')).toContain('control rests entirely with');
  });

  it('renders a readable report containing every flag name', () => {
    const summary = ex56.formatFlagsReport(
      ex56.buildAccountFlagsReport({
        id: accountId,
        flags: { auth_required: true },
        signers: [{ key: accountId, weight: 1 }],
      }),
    );

    expect(summary).toContain(accountId);
    expect(summary).toContain('auth_required');
    expect(summary).toContain('auth_revocable');
    expect(summary).toContain('auth_immutable');
    expect(summary).toContain('auth_clawback_enabled');
    expect(summary).toContain('[ENABLED ] auth_required');
    expect(summary).toContain('[disabled] auth_immutable');
    expect(summary).toContain('Raw flag value: 1');
  });
});

describe('ISSUE-057: Account Reserve Calculator Unit Tests', () => {
  it('calculates minimum reserve using base reserve rate', () => {
    const reserve = ex57.calculateMinimumReserve(3, 0, 0, 0.5);
    // (2 + 3) * 0.5 = 2.5 XLM
    expect(reserve).toBe(2.5);
  });

  it('handles sponsored entries correctly', () => {
    // 4 subentries, 1 sponsored by someone else -> effective 3 subentries
    const reserve = ex57.calculateMinimumReserve(4, 1, 0, 0.5);
    // (2 + 4 - 1) * 0.5 = 2.5 XLM
    expect(reserve).toBe(2.5);
  });

  it('calculates available balance above minimum reserve', () => {
    const available = ex57.calculateAvailableBalance(10.0, 2.5);
    expect(available).toBe(7.5);
  });

  it('parses account reserve data correctly', () => {
    const accountResponse = {
      id: 'GACCOUNT123',
      balances: [{ asset_type: 'native', balance: '50.0000000' }],
      subentry_count: 2,
      num_sponsored: 0,
      num_sponsoring: 1,
    };
    const parsed = ex57.parseAccountReserveData(accountResponse, 0.5);
    expect(parsed.nativeBalance).toBe(50);
    // (2 + 2 - 0 + 1) * 0.5 = 2.5 XLM minimum reserve
    expect(parsed.minimumReserve).toBe(2.5);
    expect(parsed.availableBalance).toBe(47.5);
  });
});

describe('ISSUE-054: Fee Statistics Inspection Unit Tests', () => {
  it('parses raw Horizon fee stats correctly', () => {
    const raw = {
      last_ledger: '123456',
      last_ledger_base_fee: '100',
      ledger_capacity_usage: '0.45',
      min_accepted_fee: '100',
      mode_accepted_fee: '100',
      p50_accepted_fee: '150',
      p90_accepted_fee: '200',
      p95_accepted_fee: '250',
      p99_accepted_fee: '300',
    };
    const parsed = ex54.parseFeeStats(raw);
    expect(parsed.lastLedger).toBe('123456');
    expect(parsed.baseFee).toBe(100);
    expect(parsed.medianFee).toBe(150);
    expect(parsed.p90Fee).toBe(200);
    expect(parsed.recommendedFee).toBe(200);
  });

  it('handles missing fields safely', () => {
    const parsed = ex54.parseFeeStats({});
    expect(parsed.baseFee).toBe(100);
    expect(parsed.minFee).toBe(100);
    expect(parsed.recommendedFee).toBeGreaterThanOrEqual(100);
  });
});

describe('ISSUE-051: Failed Transaction Result Analysis Unit Tests', () => {
  it('maps common result codes to human-readable explanations', () => {
    expect(ex51.mapResultCodeToExplanation('tx_bad_seq')).toContain('sequence number');
    expect(ex51.mapResultCodeToExplanation('op_underfunded')).toContain('insufficient balance');
  });

  it('identifies failing operation index correctly', () => {
    const opCodes = ['op_success', 'op_underfunded', 'op_success'];
    const idx = ex51.identifyFailingOperationIndex(opCodes);
    expect(idx).toBe(1);
  });

  it('handles unknown result codes without crashing', () => {
    const explanation = ex51.mapResultCodeToExplanation('op_unknown_custom_code');
    expect(explanation).toContain('Unrecognized result code');
  });

  it('parses transaction failure records', () => {
    const record = {
      hash: 'abc123hash',
      successful: false,
      result_codes: {
        transaction: 'tx_failed',
        operations: ['op_no_destination'],
      },
    };
    const parsed = ex51.parseTransactionResult(record);
    expect(parsed.successful).toBe(false);
    expect(parsed.failingOperationIndex).toBe(0);
    expect(parsed.operationExplanations[0].explanation).toContain(
      'Destination account does not exist',
    );
  });
});
