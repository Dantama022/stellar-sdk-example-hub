/**
 * Tests for the account inspection and the report of the merge readiness
 * auditor (ISSUE-378).
 *
 * The tests use a fake data source, so no network access is required.
 */

import {
  DEFAULT_LIMIT,
  HorizonAccountDataSource,
  inspectAccount,
  type AccountDataSource,
  type RawAccountRecord,
} from '../account-inspector';
import { analyzeMergeBlockers, classifyMergeReadiness } from '../blocker-analysis';
import { analyzeReserves } from '../reserve-analysis';
import { buildAuditReport, formatAuditReport, formatAuditReportJson } from '../report';
import { parseArgs } from '../index';
import type { MergeAuditReport } from '../types';

/** Builds a raw Horizon account record. */
function rawAccount(overrides: Partial<RawAccountRecord> = {}): RawAccountRecord {
  return {
    account_id: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    sequence: '42',
    subentry_count: 0,
    balances: [{ asset_type: 'native', balance: '12.5000000' }],
    signers: [
      {
        key: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
        weight: 1,
        type: 'master_key',
      },
    ],
    data_attr: {},
    num_sponsoring: 0,
    num_sponsored: 0,
    thresholds: { low: 0, medium: 0, high: 0 },
    flags: {},
    last_modified_ledger: 100,
    ...overrides,
  };
}

/** A data source that returns fixed records. */
class FakeSource implements AccountDataSource {
  constructor(
    private readonly account: RawAccountRecord,
    private readonly offers: any[] = [],
    private readonly claimableBalances: any[] = [],
    private readonly failOffers = false,
    private readonly failClaimableBalances = false,
  ) {}

  async fetchAccount(): Promise<RawAccountRecord> {
    return this.account;
  }

  async fetchOffers(): Promise<any[]> {
    if (this.failOffers) throw new Error('offers endpoint unavailable');
    return this.offers;
  }

  async fetchClaimableBalances(): Promise<any[]> {
    if (this.failClaimableBalances) throw new Error('claimable balances endpoint unavailable');
    return this.claimableBalances;
  }
}

describe('account merge readiness auditor', () => {
  // ─── Account inspection ────────────────────────────────────────────────────

  describe('inspectAccount', () => {
    it('normalizes the account state', async () => {
      const source = new FakeSource(rawAccount());
      const result = await inspectAccount({
        accountId: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
        source,
      });

      expect(result.snapshot?.nativeBalance).toBe('12.5000000');
      expect(result.snapshot?.sequence).toBe('42');
      expect(result.snapshot?.subentryCount).toBe(0);
      expect(result.snapshot?.trustlines).toHaveLength(1);
      expect(result.missingInformation).toHaveLength(0);
    });

    it('normalizes trustlines and their liabilities', async () => {
      const source = new FakeSource(
        rawAccount({
          subentry_count: 1,
          balances: [
            { asset_type: 'native', balance: '12.5000000' },
            {
              asset_type: 'credit_alphanum4',
              asset_code: 'USD',
              asset_issuer: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
              balance: '3.0000000',
              buying_liabilities: '1.0000000',
            },
          ],
        }),
      );
      const result = await inspectAccount({
        accountId: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
        source,
      });

      const trustline = result.snapshot?.trustlines[1];
      expect(trustline?.assetCode).toBe('USD');
      expect(trustline?.buyingLiabilities).toBe('1.0000000');
    });

    it('records offers and data entries', async () => {
      const source = new FakeSource(
        rawAccount({ subentry_count: 2, data_attr: { config: 'e30=' } }),
        [
          {
            id: 7,
            seller: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
            selling: { asset_type: 'native', amount: '1.0000000' },
            buying: { asset_type: 'credit_alphanum4', asset_code: 'USD', amount: '2.0000000' },
          },
        ],
      );
      const result = await inspectAccount({
        accountId: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
        source,
      });

      expect(result.snapshot?.offers).toHaveLength(1);
      expect(result.snapshot?.offers[0].id).toBe('7');
      expect(result.snapshot?.dataEntries[0].name).toBe('config');
    });

    it('records missing information when a collection cannot be loaded', async () => {
      const source = new FakeSource(rawAccount(), [], [], true);
      const result = await inspectAccount({
        accountId: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
        source,
      });

      expect(result.snapshot).toBeDefined();
      expect(result.missingInformation).toHaveLength(1);
      expect(result.missingInformation[0].field).toBe('offers');
    });

    it('reports a missing account instead of throwing', async () => {
      const source: AccountDataSource = {
        fetchAccount: async () => {
          throw new Error('404 Not Found');
        },
        fetchOffers: async () => [],
        fetchClaimableBalances: async () => [],
      };
      const result = await inspectAccount({
        accountId: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
        source,
      });

      expect(result.snapshot).toBeUndefined();
      expect(result.missingInformation[0].field).toBe('account');
    });

    it('uses a default limit for paginated collections', () => {
      expect(DEFAULT_LIMIT).toBeGreaterThan(0);
    });

    it('creates a Horizon backed data source for an endpoint', () => {
      const source = new HorizonAccountDataSource('https://horizon-testnet.stellar.org');
      expect(source).toBeInstanceOf(HorizonAccountDataSource);
    });
  });

  // ─── Report ────────────────────────────────────────────────────────────────

  describe('report', () => {
    const buildReport = async (source: AccountDataSource): Promise<MergeAuditReport> => {
      const inspection = await inspectAccount({
        accountId: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
        source,
      });
      const snapshot = inspection.snapshot!;
      const findings = analyzeMergeBlockers(snapshot, inspection.missingInformation);
      const { readiness, evidence } = classifyMergeReadiness(
        findings,
        inspection.missingInformation,
      );
      return buildAuditReport({
        accountId: snapshot.accountId,
        network: 'testnet',
        endpoint: 'https://horizon-testnet.stellar.org',
        auditedAt: '2024-01-01T00:00:00.000Z',
        account: snapshot,
        findings,
        reserve: analyzeReserves(snapshot),
        readiness,
        readinessEvidence: evidence,
        missingInformation: inspection.missingInformation,
      });
    };

    it('produces a console report with the same information as the JSON report', async () => {
      const report = await buildReport(new FakeSource(rawAccount()));
      const text = formatAuditReport(report);
      const json = JSON.parse(formatAuditReportJson(report));

      expect(text).toContain('Stellar account merge readiness audit');
      expect(text).toContain('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF');
      expect(text).toContain('Classification:');
      expect(json.accountId).toBe(report.accountId);
      expect(json.readiness).toBe(report.readiness);
      expect(json.findings).toHaveLength(report.findings.length);
      expect(json.reserve.minimumBalance).toBe(report.reserve.minimumBalance);
    });

    it('documents the limitations of a static audit', async () => {
      const report = await buildReport(new FakeSource(rawAccount()));

      expect(report.limitations.length).toBeGreaterThan(3);
      expect(report.limitations.join(' ')).toContain('not a guarantee');
    });

    it('never exposes secret keys', async () => {
      const report = await buildReport(new FakeSource(rawAccount()));
      const serialized = formatAuditReportJson(report);

      expect(serialized).not.toContain('PRIVATE_KEY');
      expect(serialized).not.toMatch(/\bS[A-Z2-7]{55}\b/);
    });

    it('reports a missing collection in the console report', async () => {
      const report = await buildReport(new FakeSource(rawAccount(), [], [], true));

      expect(report.missingInformation).toHaveLength(1);
      expect(formatAuditReport(report)).toContain('Missing information');
    });
  });

  // ─── CLI ───────────────────────────────────────────────────────────────────

  describe('parseArgs', () => {
    it('parses the account, endpoint, limit, output and format options', () => {
      const options = parseArgs([
        '--account',
        'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
        '--endpoint',
        'https://horizon.stellar.org',
        '--limit',
        '50',
        '--output',
        'report.json',
        '--format',
        'json',
      ]);

      expect(options.account).toBe('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF');
      expect(options.endpoint).toBe('https://horizon.stellar.org');
      expect(options.limit).toBe(50);
      expect(options.output).toBe('report.json');
      expect(options.format).toBe('json');
    });

    it('parses the --name=value syntax', () => {
      const options = parseArgs([
        '--account=GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
        '--format=json',
      ]);

      expect(options.account).toBe('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF');
      expect(options.format).toBe('json');
    });

    it('defaults to the console format', () => {
      expect(parseArgs([]).format).toBe('console');
    });
  });
});
