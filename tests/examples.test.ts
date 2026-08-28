import { readFileSync } from 'fs';
import path from 'path';

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
import * as ex50 from '../src/examples/50-asset-issuer-discovery';
import * as ex51 from '../src/examples/51-failed-transaction-analysis';
import * as ex52 from '../src/examples/52-account-balance-history';
import * as ex53 from '../src/examples/53-ledger-inspection';
import * as ex54 from '../src/examples/54-fee-stats';
import * as ex55 from '../src/examples/55-trade-history';
import * as ex56 from '../src/examples/56-account-flags-inspection';
import * as ex57 from '../src/examples/57-account-reserve-calculator';
import * as ex58 from '../src/examples/58-account-relationship-discovery';
import * as ex66 from '../src/examples/66-ledger-effects';
import * as ex67 from '../src/examples/67-soroban-contract-events';
import * as ex60 from '../src/examples/60-network-configuration';
import * as ex59 from '../src/examples/59-account-offer-inspection';
import * as ex96 from '../src/examples/96-fee-bump-recovery-workflow';
import * as ex139 from '../src/examples/139-account-offer-inspection';
import * as ex138 from '../src/examples/138-account-merge-preflight';
import * as ex132 from '../src/examples/132-fee-bump-inspection';
import * as ex136 from '../src/examples/136-transaction-fee-estimation';
import * as ex124 from '../src/examples/124-liquidity-pool-inspection';
import * as ex125 from '../src/examples/125-liquidity-pool-simulation';
import * as ex127 from '../src/examples/127-trustline-management';
import * as ex129 from '../src/examples/129-asset-clawback';

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
      ex50,
      ex51,
      ex52,
      ex53,
      ex54,
      ex55,
      ex56,
      ex57,
      ex58,
      ex66,
      ex67,
        ex58,
      ex59,
      ex60,
      ex96,
      ex139,
      ex138,
      ex132,
      ex136,
      ex124,
      ex125,
      ex127,
      ex129,
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
      '50-asset-issuer-discovery',
      '51-failed-transaction-analysis',
      '52-account-balance-history',
      '53-ledger-inspection',
      '54-fee-stats',
      '55-trade-history',
      '56-account-flags-inspection',
      '57-account-reserve-calculator',
      '58-account-relationship-discovery',
      '66-ledger-effects',
      '67-soroban-contract-events',
      '60-network-configuration',
      '59-account-offer-inspection',
      '96-fee-bump-recovery-workflow',
      '139-account-offer-inspection',
      '138-account-merge-preflight',
      '132-fee-bump-inspection',
      '136-transaction-fee-estimation',
      '124-liquidity-pool-inspection',
      '125-liquidity-pool-simulation',
      '127-trustline-management',
      '129-asset-clawback',
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

describe('ISSUE-055: Trade History Unit Tests', () => {
  const issuer = 'GB6ZS324HT6VEEDZ6MG6CESWE7YZSY7WAJDRQSP2GZCRZ5GBND377A2F';

  /** Builds a Horizon-shaped trade record with sensible defaults. */
  const rawTrade = (overrides: Partial<ex55.RawTradeRecord> = {}): ex55.RawTradeRecord => ({
    id: '123456789-0',
    paging_token: '123456789-0',
    ledger_close_time: '2024-05-01T10:00:00Z',
    trade_type: 'orderbook',
    base_account: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7',
    base_amount: '100.0000000',
    base_asset_type: 'native',
    counter_account: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFXYCZLYF3436GTYOWD4S',
    counter_amount: '25.0000000',
    counter_asset_type: 'credit_alphanum4',
    counter_asset_code: 'USDC',
    counter_asset_issuer: issuer,
    base_is_seller: true,
    price: { n: '1', d: '4' },
    _links: { operation: { href: 'https://horizon-testnet.stellar.org/operations/123456789' } },
    ...overrides,
  });

  describe('asset pair parameters', () => {
    it('maps native input to the native asset', () => {
      expect(ex55.parseAssetInput('native').isNative()).toBe(true);
      expect(ex55.parseAssetInput('XLM').isNative()).toBe(true);
      expect(ex55.parseAssetInput('  Native  ').isNative()).toBe(true);
    });

    it('maps CODE:ISSUER input to an issued asset', () => {
      const asset = ex55.parseAssetInput(`USDC:${issuer}`);
      expect(asset.isNative()).toBe(false);
      expect(asset.getCode()).toBe('USDC');
      expect(asset.getIssuer()).toBe(issuer);
    });

    it('rejects malformed and empty asset input', () => {
      expect(() => ex55.parseAssetInput('USDC', 'base asset')).toThrow(/base asset/);
      expect(() => ex55.parseAssetInput('   ', 'counter asset')).toThrow(/Missing counter asset/);
      expect(() => ex55.parseAssetInput('USDC:not-an-issuer')).toThrow(/Invalid asset/);
    });

    it('describes both asset kinds for display', () => {
      expect(ex55.describeAsset(ex55.parseAssetInput('native'))).toContain('XLM');
      expect(ex55.describeAsset(ex55.parseAssetInput(`USDC:${issuer}`))).toBe(`USDC:${issuer}`);
    });

    it('labels trade sides, defaulting an absent type to native', () => {
      expect(ex55.describeTradeSideAsset('native')).toBe('XLM');
      expect(ex55.describeTradeSideAsset(undefined)).toBe('XLM');
      expect(ex55.describeTradeSideAsset('credit_alphanum4', 'USDC', issuer)).toBe(
        `USDC:${issuer}`,
      );
    });

    it('clamps the result limit into the range Horizon accepts', () => {
      expect(ex55.normalizeLimit(25)).toBe(25);
      expect(ex55.normalizeLimit('25')).toBe(25);
      expect(ex55.normalizeLimit(0)).toBe(1);
      expect(ex55.normalizeLimit(5000)).toBe(200);
      expect(ex55.normalizeLimit(undefined)).toBe(10);
      expect(ex55.normalizeLimit('not-a-number')).toBe(10);
    });
  });

  describe('trade record parsing', () => {
    it('parses a native/issued orderbook trade', () => {
      const trade = ex55.parseTradeRecord(rawTrade());

      expect(trade.id).toBe('123456789-0');
      expect(trade.ledgerCloseTime).toBe('2024-05-01T10:00:00Z');
      expect(trade.tradeType).toBe('orderbook');
      expect(trade.baseAsset).toBe('XLM');
      expect(trade.counterAsset).toBe(`USDC:${issuer}`);
      expect(trade.baseAmount).toBe(100);
      expect(trade.counterAmount).toBe(25);
      expect(trade.baseIsSeller).toBe(true);
      expect(trade.operationId).toBe('123456789');
      expect(trade.operationLink).toContain('/operations/123456789');
    });

    it('uses the rational price from Horizon when present', () => {
      const trade = ex55.parseTradeRecord(rawTrade({ price: { n: '3', d: '8' } }));
      expect(trade.price).toBeCloseTo(0.375, 7);
    });

    it('derives the price from amounts when Horizon omits it', () => {
      const trade = ex55.parseTradeRecord(
        rawTrade({ price: undefined, base_amount: '50', counter_amount: '20' }),
      );
      expect(trade.price).toBeCloseTo(0.4, 7);
    });

    it('avoids dividing by a zero base amount', () => {
      const trade = ex55.parseTradeRecord(
        rawTrade({ price: undefined, base_amount: '0', counter_amount: '20' }),
      );
      expect(trade.price).toBe(0);
    });

    it('parses liquidity pool trades and their pool references', () => {
      const trade = ex55.parseTradeRecord(
        rawTrade({
          trade_type: 'liquidity_pool',
          base_account: undefined,
          base_liquidity_pool_id: 'abc123poolid',
        }),
      );

      expect(trade.tradeType).toBe('liquidity_pool');
      expect(trade.baseParty).toBe('abc123poolid');
    });

    it('extracts operation IDs from trade IDs', () => {
      expect(ex55.extractOperationId('123456789-0')).toBe('123456789');
      expect(ex55.extractOperationId('987654321-1')).toBe('987654321');
      expect(ex55.extractOperationId('nodashes')).toBe('nodashes');
      expect(ex55.extractOperationId(undefined)).toBe('');
    });
  });

  describe('market activity statistics', () => {
    const trades = [
      ex55.parseTradeRecord(
        rawTrade({ base_amount: '100', counter_amount: '25', price: { n: '1', d: '4' } }),
      ),
      ex55.parseTradeRecord(
        rawTrade({
          id: '223456789-0',
          ledger_close_time: '2024-05-01T09:00:00Z',
          base_amount: '300',
          counter_amount: '150',
          price: { n: '1', d: '2' },
          trade_type: 'liquidity_pool',
        }),
      ),
    ];

    it('totals traded volume on both sides of the pair', () => {
      const summary = ex55.summarizeTrades(trades);
      expect(summary.tradeCount).toBe(2);
      expect(summary.totalBaseVolume).toBeCloseTo(400, 7);
      expect(summary.totalCounterVolume).toBeCloseTo(175, 7);
    });

    it('calculates unweighted and volume-weighted average prices', () => {
      const summary = ex55.summarizeTrades(trades);
      // Unweighted mean of 0.25 and 0.5.
      expect(summary.averagePrice).toBeCloseTo(0.375, 7);
      // VWAP: 175 counter / 400 base, pulled toward the larger 0.5 trade.
      expect(summary.volumeWeightedPrice).toBeCloseTo(0.4375, 7);
    });

    it('reports the price range and the time window covered', () => {
      const summary = ex55.summarizeTrades(trades);
      expect(summary.highestPrice).toBeCloseTo(0.5, 7);
      expect(summary.lowestPrice).toBeCloseTo(0.25, 7);
      expect(summary.earliestTradeAt).toBe('2024-05-01T09:00:00Z');
      expect(summary.latestTradeAt).toBe('2024-05-01T10:00:00Z');
    });

    it('splits trades by execution venue', () => {
      const summary = ex55.summarizeTrades(trades);
      expect(summary.orderbookTradeCount).toBe(1);
      expect(summary.liquidityPoolTradeCount).toBe(1);
    });

    it('reports zeroed statistics instead of NaN for an empty result set', () => {
      const summary = ex55.summarizeTrades([]);
      expect(summary.tradeCount).toBe(0);
      expect(summary.totalBaseVolume).toBe(0);
      expect(summary.averagePrice).toBe(0);
      expect(summary.volumeWeightedPrice).toBe(0);
      expect(summary.earliestTradeAt).toBeNull();
      expect(summary.latestTradeAt).toBeNull();
    });

    it('reports a zero VWAP when only zero-amount trades exist', () => {
      const zeroVolume = [
        ex55.parseTradeRecord(rawTrade({ base_amount: '0', counter_amount: '0' })),
      ];
      expect(ex55.summarizeTrades(zeroVolume).volumeWeightedPrice).toBe(0);
    });
  });

  describe('report formatting', () => {
    it('renders trade records with timestamps, prices, amounts, and references', () => {
      const trades = [ex55.parseTradeRecord(rawTrade())];
      const report = ex55.formatTradeHistoryReport(
        'XLM',
        'USDC',
        trades,
        ex55.summarizeTrades(trades),
      );

      expect(report).toContain('2024-05-01T10:00:00Z');
      expect(report).toContain('0.2500000');
      expect(report).toContain('100.0000000');
      expect(report).toMatch(/Operation ID:\s+123456789/);
      expect(report).toContain('USDC:' + issuer);
      expect(report).toContain('Volume-Weighted Price');
    });

    it('shows the trade direction implied by base_is_seller', () => {
      const sell = [ex55.parseTradeRecord(rawTrade({ base_is_seller: true }))];
      const buy = [ex55.parseTradeRecord(rawTrade({ base_is_seller: false }))];

      expect(
        ex55.formatTradeHistoryReport('XLM', 'USDC', sell, ex55.summarizeTrades(sell)),
      ).toContain('SELL XLM');
      expect(
        ex55.formatTradeHistoryReport('XLM', 'USDC', buy, ex55.summarizeTrades(buy)),
      ).toContain('BUY  XLM');
    });

    it('explains an empty trade history instead of printing empty statistics', () => {
      const report = ex55.formatTradeHistoryReport('XLM', 'USDC', [], ex55.summarizeTrades([]));

      expect(report).toContain('No trades found for this asset pair');
      expect(report).toContain('orderbook');
      expect(report).not.toContain('Volume-Weighted Price');
    });

    it('distinguishes completed trades from resting orderbook offers', () => {
      const trades = [ex55.parseTradeRecord(rawTrade())];
      const report = ex55.formatTradeHistoryReport(
        'XLM',
        'USDC',
        trades,
        ex55.summarizeTrades(trades),
      );

      expect(report).toContain('SDEX orderbook');
      expect(report).toContain('counter units (USDC) per 1 base unit (XLM)');
    });
  });

  describe('empty and failed result handling', () => {
    it('treats a Horizon 404 as an empty trade history', () => {
      expect(ex55.isEmptyTradeHistoryError({ response: { status: 404 } })).toBe(true);
      expect(ex55.isEmptyTradeHistoryError({ name: 'NotFoundError' })).toBe(true);
    });

    it('does not treat other failures as an empty history', () => {
      expect(ex55.isEmptyTradeHistoryError({ response: { status: 400 } })).toBe(false);
      expect(ex55.isEmptyTradeHistoryError(new Error('network down'))).toBe(false);
      expect(ex55.isEmptyTradeHistoryError(undefined)).toBe(false);
    });
  });

  describe('transaction reference resolution', () => {
    it('returns the transaction hash behind a trade operation', async () => {
      const server = {
        operations: () => ({
          operation: () => ({ call: async () => ({ transaction_hash: 'abcdef123456' }) }),
        }),
      } as any;

      await expect(ex55.resolveTransactionHash(server, '123456789')).resolves.toBe('abcdef123456');
    });

    it('degrades gracefully when the operation cannot be fetched', async () => {
      const server = {
        operations: () => ({
          operation: () => ({
            call: async () => {
              throw new Error('not found');
            },
          }),
        }),
      } as any;

      await expect(ex55.resolveTransactionHash(server, '123456789')).resolves.toBeUndefined();
      await expect(ex55.resolveTransactionHash(server, '')).resolves.toBeUndefined();
    });
  });

  describe('runner and documentation registration', () => {
    it('registers the example with asset pair and limit parameters', () => {
      const entry = examples['55-trade-history'];

      expect(entry).toBeDefined();
      expect(typeof entry.run).toBe('function');
      expect(entry.params?.map((p) => p.name)).toEqual(['baseAsset', 'counterAsset', 'limit']);
    });

    it('documents the example in the README catalog', () => {
      const readme = readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');

      expect(readme).toContain('`55-trade-history`');
      expect(readme).toContain('npm run run-example 55-trade-history');
    });
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

describe('ISSUE-050: Asset Issuer Discovery Unit Tests', () => {
  const issuer = 'GBBD47IF6LWK2P7MDEVSCWR7DPUWV3NY3DTQEVFL4TWVCKPXA26VCCKM';

  it('parses code and issuer into an Asset', () => {
    // Use a known-valid Testnet-style issuer from other examples.
    const validIssuer = 'GB6ZS324HT6VEEDZ6MG6CESWE7YZSY7WAJDRQSP2GZCRZ5GBND377A2F';
    const asset = ex50.parseAssetIdentifier('USDC', validIssuer);
    expect(asset.getCode()).toBe('USDC');
    expect(asset.getIssuer()).toBe(validIssuer);
  });

  it('parses combined CODE:ISSUER input', () => {
    const validIssuer = 'GB6ZS324HT6VEEDZ6MG6CESWE7YZSY7WAJDRQSP2GZCRZ5GBND377A2F';
    const asset = ex50.parseCombinedAssetInput(`USDC:${validIssuer}`);
    expect(asset.getCode()).toBe('USDC');
    expect(asset.getIssuer()).toBe(validIssuer);
  });

  it('rejects malformed asset identifiers', () => {
    expect(() => ex50.parseAssetIdentifier('', issuer)).toThrow(/Missing asset code/);
    expect(() => ex50.parseCombinedAssetInput('USDC')).toThrow(/CODE:ISSUER/);
  });

  it('parses Horizon asset records and formats a report', () => {
    const parsed = ex50.parseAssetRecord({
      asset_type: 'credit_alphanum4',
      asset_code: 'USDC',
      asset_issuer: issuer,
      num_accounts: 42,
      num_claimable_balances: 1,
      num_liquidity_pools: 2,
      amount: '1000.0000000',
      flags: { auth_required: true, auth_revocable: false },
    });

    expect(parsed.numAccounts).toBe(42);
    expect(parsed.flags.authRequired).toBe(true);

    const report = ex50.formatAssetDiscoveryReport(parsed);
    expect(report).toContain('USDC');
    expect(report).toContain(issuer);
    expect(report).toContain('Accounts Trusting');
    expect(report).toContain('code + issuer');
  });

  it('detects unknown asset errors', () => {
    expect(ex50.isUnknownAssetError({ response: { status: 404 } })).toBe(true);
    expect(ex50.isUnknownAssetError({ name: 'NotFoundError' })).toBe(true);
    expect(ex50.isUnknownAssetError({ response: { status: 500 } })).toBe(false);
  });

  it('registers the example and documents it in the README', () => {
    expect(examples['50-asset-issuer-discovery']).toBeDefined();
    const readme = readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
    expect(readme).toContain('`50-asset-issuer-discovery`');
    expect(readme).toContain('npm run run-example 50-asset-issuer-discovery');
  });
});

describe('ISSUE-052: Account Balance History Unit Tests', () => {
  it('normalizes history limits into Horizon range', () => {
    expect(ex52.normalizeLimit(undefined)).toBe(25);
    expect(ex52.normalizeLimit('10')).toBe(10);
    expect(ex52.normalizeLimit(0)).toBe(1);
    expect(ex52.normalizeLimit(999)).toBe(200);
  });

  it('identifies native balance-changing effects only', () => {
    expect(
      ex52.isNativeBalanceChangingEffect({
        type: 'account_credited',
        asset_type: 'native',
        amount: '1',
      }),
    ).toBe(true);
    expect(
      ex52.isNativeBalanceChangingEffect({
        type: 'account_credited',
        asset_type: 'credit_alphanum4',
        asset_code: 'USDC',
        amount: '1',
      }),
    ).toBe(false);
    expect(ex52.isNativeBalanceChangingEffect({ type: 'offer_created' })).toBe(false);
  });

  it('parses credits, debits, and account creation into signed deltas', () => {
    expect(
      ex52.parseBalanceEffect({ type: 'account_credited', amount: '5.5', id: '1' })?.deltaXlm,
    ).toBe(5.5);
    expect(
      ex52.parseBalanceEffect({ type: 'account_debited', amount: '2', id: '2' })?.deltaXlm,
    ).toBe(-2);
    expect(
      ex52.parseBalanceEffect({ type: 'account_created', starting_balance: '100', id: '3' })
        ?.deltaXlm,
    ).toBe(100);
  });

  it('sorts chronologically and attaches running balances', () => {
    const changes = [
      ex52.parseBalanceEffect({
        type: 'account_credited',
        amount: '10',
        id: 'b',
        created_at: '2024-01-02T00:00:00Z',
      })!,
      ex52.parseBalanceEffect({
        type: 'account_debited',
        amount: '3',
        id: 'a',
        created_at: '2024-01-01T00:00:00Z',
      })!,
    ];

    const chronological = ex52.sortChronologically(changes);
    expect(chronological[0].type).toBe('account_debited');

    const withBalances = ex52.attachRunningBalances(chronological, 107);
    // window delta = -3 + 10 = 7; start = 107 - 7 = 100
    expect(withBalances[0].balanceAfter).toBe(97);
    expect(withBalances[1].balanceAfter).toBe(107);
  });

  it('formats empty history and documents limitations', () => {
    const report = ex52.formatBalanceHistoryReport({
      accountId: 'GACCOUNT',
      currentBalanceXlm: 10,
      changes: [],
      windowLimit: 25,
      reconstructed: false,
    });
    expect(report).toContain('No native XLM balance-changing effects');
    expect(report).toContain('GACCOUNT');
  });

  it('registers the example and documents it in the README', () => {
    expect(examples['52-account-balance-history']).toBeDefined();
    const readme = readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
    expect(readme).toContain('`52-account-balance-history`');
    expect(readme).toContain('npm run run-example 52-account-balance-history');
  });
});

describe('ISSUE-053: Ledger Inspection Unit Tests', () => {
  it('parses valid ledger sequences and rejects invalid ones', () => {
    expect(ex53.parseLedgerSequence(undefined)).toBeUndefined();
    expect(ex53.parseLedgerSequence('12345')).toBe(12345);
    expect(() => ex53.parseLedgerSequence('0')).toThrow(/positive integer/);
    expect(() => ex53.parseLedgerSequence('abc')).toThrow(/Invalid ledger sequence/);
  });

  it('parses Horizon ledger records into structured metadata', () => {
    const parsed = ex53.parseLedgerRecord({
      sequence: 100,
      hash: 'abc',
      prev_hash: 'def',
      closed_at: '2024-01-01T00:00:00Z',
      successful_transaction_count: 3,
      failed_transaction_count: 1,
      operation_count: 7,
      protocol_version: 20,
      base_fee_in_stroops: 100,
      base_reserve_in_stroops: 5000000,
      total_coins: '105000000000',
      fee_pool: '1000',
      max_tx_set_size: 1000,
    });

    expect(parsed.sequence).toBe(100);
    expect(parsed.successfulTransactionCount).toBe(3);
    expect(parsed.protocolVersion).toBe(20);

    const report = ex53.formatLedgerReport(parsed);
    expect(report).toContain('Ledger Sequence');
    expect(report).toContain('Previous Ledger Hash');
    expect(report).toContain('ledgers relate to transactions');
  });

  it('detects unavailable ledger errors', () => {
    expect(ex53.isUnavailableLedgerError({ response: { status: 404 } })).toBe(true);
    expect(ex53.isUnavailableLedgerError({ name: 'NotFoundError' })).toBe(true);
    expect(ex53.isUnavailableLedgerError({})).toBe(false);
  });

  it('registers the example and documents it in the README', () => {
    expect(examples['53-ledger-inspection']).toBeDefined();
    const readme = readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
    expect(readme).toContain('`53-ledger-inspection`');
    expect(readme).toContain('npm run run-example 53-ledger-inspection');
  });
});

describe('ISSUE-059: Account Offer Inspection Unit Tests', () => {
  it('describes native and issued offer assets', () => {
    expect(ex59.describeOfferAsset({ asset_type: 'native' })).toBe('XLM');
    expect(
      ex59.describeOfferAsset({
        asset_type: 'credit_alphanum4',
        asset_code: 'USDC',
        asset_issuer: 'GISSUER',
      }),
    ).toBe('USDC:GISSUER');
  });

  it('parses offer records with price and approximate volume', () => {
    const offer = ex59.parseOfferRecord({
      id: '99',
      seller: 'GSELLER',
      selling: { asset_type: 'native' },
      buying: {
        asset_type: 'credit_alphanum4',
        asset_code: 'USDC',
        asset_issuer: 'GISSUER',
      },
      amount: '10.0000000',
      price_r: { n: '1', d: '4' },
      price: '0.2500000',
      last_modified_ledger: 1000,
    });

    expect(offer.offerType).toBe('sell');
    expect(offer.sellingAsset).toBe('XLM');
    expect(offer.buyingAsset).toBe('USDC:GISSUER');
    expect(offer.price).toBe(0.25);
    expect(offer.approximateBuyingVolume).toBe(2.5);
  });

  it('summarizes offers and formats empty-state messaging', () => {
    const offers = [
      ex59.parseOfferRecord({
        id: '1',
        selling: { asset_type: 'native' },
        buying: { asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: 'G' },
        amount: '4',
        price: '2',
        price_r: { n: 2, d: 1 },
      }),
    ];
    const summary = ex59.summarizeOffers(offers);
    expect(summary.offerCount).toBe(1);
    expect(summary.totalSellingByAsset.XLM).toBe(4);

    const empty = ex59.formatOfferInspectionReport('GACCOUNT', [], {
      offerCount: 0,
      totalSellingByAsset: {},
      totalBuyingVolumeByAsset: {},
    });
    expect(empty).toContain('No active offers found');
    expect(empty).toContain('orderbook');
  });

  it('normalizes offer limits', () => {
    expect(ex59.normalizeLimit('5')).toBe(5);
    expect(ex59.normalizeLimit(500)).toBe(200);
  });

  it('registers the example and documents it in the README', () => {
    expect(examples['59-account-offer-inspection']).toBeDefined();
    const readme = readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
    expect(readme).toContain('`59-account-offer-inspection`');
    expect(readme).toContain('npm run run-example 59-account-offer-inspection');
  });
});
