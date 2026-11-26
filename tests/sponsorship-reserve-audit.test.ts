import { Keypair } from '@stellar/stellar-sdk';
import {
  analyzeSponsorshipRelationships,
  estimateAccountReserves,
  fetchSponsorshipAccountData,
  formatSponsorshipAuditReport,
  runSponsorshipReserveAudit,
  SponsorshipDataSource,
} from '../src/examples/265-sponsorship-reserve-audit';
import { examples } from '../src/runner/catalog';

const ACCOUNT_ID = Keypair.random().publicKey();
const SPONSOR_ID = Keypair.random().publicKey();
const ISSUER_ID = Keypair.random().publicKey();
const HORIZON_URL = 'https://horizon-testnet.stellar.org';

describe('265-sponsorship-reserve-audit', () => {
  it('audits an account with no sponsorship relationships and computes reserve estimate', async () => {
    const dataSource: SponsorshipDataSource = {
      async loadAccount() {
        return {
          account_id: ACCOUNT_ID,
          subentry_count: 1,
          num_sponsoring: 0,
          num_sponsored: 0,
          balances: [{ asset_type: 'native', balance: '10.0000000' }],
          signers: [{ key: ACCOUNT_ID, type: 'ed25519_public_key', weight: 1 }],
        };
      },
    };

    const report = await runSponsorshipReserveAudit(ACCOUNT_ID, HORIZON_URL, 0.5, dataSource);
    expect(report.relationships.numSponsoring).toBe(0);
    expect(report.relationships.numSponsored).toBe(0);
    expect(report.reserveAssessment.status).toBe('estimated');
    expect(report.reserveAssessment.effectiveReserveEntries).toBe(3); // 2 + 1 + 0 - 0
    expect(report.reserveAssessment.minimumReserveEstimateXlm).toBe('1.5000000');
    expect(report.reserveAssessment.estimatedAboveReserveXlm).toBe('8.5000000');
  });

  it('audits an account sponsoring ledger entries and flags external-entry unresolved check', async () => {
    const report = await runSponsorshipReserveAudit(ACCOUNT_ID, HORIZON_URL, 0.5, {
      async loadAccount() {
        return {
          account_id: ACCOUNT_ID,
          subentry_count: 2,
          num_sponsoring: 3,
          num_sponsored: 0,
          balances: [{ asset_type: 'native', balance: '20.0000000' }],
          signers: [{ key: ACCOUNT_ID, type: 'ed25519_public_key', weight: 1 }],
        };
      },
    });

    expect(report.reserveAssessment.effectiveReserveEntries).toBe(7); // 2 + 2 + 3 - 0
    expect(report.reserveAssessment.minimumReserveEstimateXlm).toBe('3.5000000');
    expect(report.relationships.unresolvedChecks.some((c) => c.includes('num_sponsoring'))).toBe(true);
  });

  it('audits an account with sponsored entries and mixed sponsorship relationships', async () => {
    const report = await runSponsorshipReserveAudit(ACCOUNT_ID, HORIZON_URL, 0.5, {
      async loadAccount() {
        return {
          account_id: ACCOUNT_ID,
          subentry_count: 3,
          num_sponsoring: 1,
          num_sponsored: 2,
          sponsor: SPONSOR_ID,
          balances: [
            { asset_type: 'native', balance: '5.0000000' },
            {
              asset_type: 'credit_alphanum4',
              asset_code: 'USDC',
              asset_issuer: ISSUER_ID,
              balance: '100.0000000',
              sponsor: SPONSOR_ID,
            },
          ],
          signers: [
            { key: ACCOUNT_ID, type: 'ed25519_public_key', weight: 1 },
            { key: Keypair.random().publicKey(), type: 'ed25519_public_key', weight: 1, sponsor: SPONSOR_ID },
          ],
        };
      },
    });

    expect(report.relationships.accountSponsor).toBe(SPONSOR_ID);
    expect(report.relationships.sponsoredTrustlines).toHaveLength(1);
    expect(report.relationships.sponsoredSigners).toHaveLength(1);
    expect(report.reserveAssessment.effectiveReserveEntries).toBe(4); // 2 + 3 + 1 - 2
    expect(report.reserveAssessment.minimumReserveEstimateXlm).toBe('2.0000000');
  });

  it('does not claim a discrepancy when additional ledger entries are not retrieved, and reports insufficient reserve data', async () => {
    const retrieved = await fetchSponsorshipAccountData(ACCOUNT_ID, HORIZON_URL, {
      async loadAccount() {
        return {
          account_id: ACCOUNT_ID,
          num_sponsored: 2,
          balances: [],
        };
      },
    });

    const rel = analyzeSponsorshipRelationships(retrieved);
    expect(rel.potentialInconsistencies).toEqual([]);
    expect(rel.unresolvedChecks.some((u) => u.includes('num_sponsored=2'))).toBe(true);
    expect(rel.missingData.some((m) => m.includes('num_sponsoring'))).toBe(true);

    const reserve = estimateAccountReserves(retrieved.account, null);
    expect(reserve.status).toBe('insufficient_data');
    expect(reserve.minimumReserveEstimateXlm).toBeNull();
    expect(reserve.missingInputs.length).toBeGreaterThan(0);
  });

  it('detects confirmed inconsistency when complete ledger-entry inspection contradicts num_sponsored', async () => {
    const report = await runSponsorshipReserveAudit(ACCOUNT_ID, HORIZON_URL, 0.5, {
      async loadAccount() {
        return {
          account_id: ACCOUNT_ID,
          subentry_count: 1,
          num_sponsoring: 0,
          num_sponsored: 2,
          balances: [{ asset_type: 'native', balance: '10.0000000' }],
          signers: [{ key: ACCOUNT_ID, type: 'ed25519_public_key', weight: 1 }],
        };
      },
      async loadSponsoredEntriesPages() {
        return {
          records: [],
        };
      },
    });

    expect(
      report.relationships.potentialInconsistencies.some((i) => i.includes('complete ledger-entry inspection')),
    ).toBe(true);
    const rendered = formatSponsorshipAuditReport(report);
    expect(rendered).toContain('Disclaimer:');
    expect(JSON.parse(JSON.stringify(report)).accountId).toBe(ACCOUNT_ID);
  });

  it('handles pagination failures and invalid account identifiers', async () => {
    await expect(
      fetchSponsorshipAccountData('BAD_KEY', HORIZON_URL, {
        async loadAccount() {
          throw new Error('unused');
        },
      }),
    ).rejects.toThrow(/Invalid Stellar account public key/);

    await expect(
      fetchSponsorshipAccountData(ACCOUNT_ID, HORIZON_URL, {
        async loadAccount() {
          return { account_id: ACCOUNT_ID };
        },
        async loadSponsoredEntriesPages() {
          return {
            records: [],
            async next() {
              throw new Error('Horizon 503');
            },
          };
        },
      }),
    ).rejects.toThrow(/Pagination failed/);
  });

  it('is registered in the example catalog', () => {
    expect(examples['265-sponsorship-reserve-audit']).toBeDefined();
  });
});
