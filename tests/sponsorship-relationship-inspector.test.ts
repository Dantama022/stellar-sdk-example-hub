import {
  estimateReserveDependencies,
  extractSponsorshipData,
  extractSponsorshipMetadata,
  formatStroops,
  inspectSponsorship,
  isPublicKey,
  parseBaseReserve,
  type AccountLoader,
} from '../examples/accounts/sponsorship-relationship-inspector';

const ACCOUNT = 'GB6ZS324HT6VEEDZ6MG6CESWE7YZSY7WAJDRQSP2GZCRZ5GBND377A2F';
const SPONSOR = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
const OTHER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function account(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    account_id: ACCOUNT,
    sequence: '123',
    subentry_count: 2,
    num_sponsoring: 0,
    num_sponsored: 0,
    balances: [{ asset_type: 'native', balance: '10.0000000' }],
    ...overrides,
  };
}

function loader(records: Record<string, unknown>, failingIds: string[] = []): AccountLoader {
  return {
    loadAccount: async (accountId) => {
      if (failingIds.includes(accountId)) throw new Error(`404 for ${accountId}`);
      if (accountId === ACCOUNT) return records;
      return { account_id: accountId, sequence: '1', subentry_count: 0 };
    },
  };
}

describe('sponsorship relationship inspector (ISSUE-405)', () => {
  describe('input helpers', () => {
    it('validates public keys and base reserve amounts', () => {
      expect(isPublicKey(ACCOUNT)).toBe(true);
      expect(isPublicKey('BAD')).toBe(false);
      expect(parseBaseReserve('0.5')).toBe(5_000_000n);
      expect(() => parseBaseReserve('-1')).toThrow(/Invalid base reserve/);
      expect(formatStroops(5_000_000n)).toBe('0.5000000');
    });
  });

  describe('metadata extraction', () => {
    it('handles an account with no sponsorship relationships', () => {
      const metadata = extractSponsorshipMetadata(account());
      expect(metadata.accountSponsor).toBeNull();
      expect(metadata.numSponsoring).toBe(0);
      expect(metadata.numSponsored).toBe(0);
    });

    it('extracts account-level sponsored and sponsoring metadata', () => {
      const sponsored = extractSponsorshipMetadata(account({ sponsor: SPONSOR, num_sponsored: 1 }));
      expect(sponsored.accountSponsor).toBe(SPONSOR);
      expect(sponsored.numSponsored).toBe(1);
      const sponsoring = extractSponsorshipMetadata(
        account({ num_sponsoring: 2, sponsorship_counter: 2 }),
      );
      expect(sponsoring.numSponsoring).toBe(2);
      expect(sponsoring.sponsorshipCounter).toBe(2);
    });
  });

  describe('entry-level inspection', () => {
    it('extracts sponsored trustline metadata', () => {
      const data = extractSponsorshipData(
        account({
          balances: [
            { asset_type: 'native', balance: '10' },
            {
              asset_type: 'credit_alphanum4',
              asset_code: 'USD',
              asset_issuer: SPONSOR,
              balance: '5',
              sponsor: SPONSOR,
            },
          ],
        }),
      );
      expect(data.entries).toHaveLength(1);
      expect(data.entries[0]).toMatchObject({ type: 'trustline', sponsor: SPONSOR });
    });

    it('extracts sponsored signer metadata', () => {
      const data = extractSponsorshipData(
        account({
          signers: [{ key: OTHER, weight: 1, sponsor: SPONSOR }],
        }),
      );
      expect(data.entries).toHaveLength(1);
      expect(data.entries[0].type).toBe('signer');
      expect(data.entries[0].sponsor).toBe(SPONSOR);
    });

    it('reports multiple sponsored ledger entries', () => {
      const data = extractSponsorshipData(
        account({
          balances: [
            {
              asset_type: 'credit_alphanum4',
              asset_code: 'USD',
              asset_issuer: SPONSOR,
              balance: '5',
              sponsor: SPONSOR,
            },
            {
              asset_type: 'credit_alphanum12',
              asset_code: 'LONGASSET',
              asset_issuer: SPONSOR,
              balance: '1',
              sponsor: OTHER,
            },
          ],
          signers: [{ key: OTHER, weight: 1, sponsor: SPONSOR }],
        }),
      );
      expect(data.entries).toHaveLength(3);
    });

    it('reports missing entry-level sponsorship information', () => {
      const data = extractSponsorshipData(
        account({
          balances: [
            {
              asset_type: 'credit_alphanum4',
              asset_code: 'USD',
              asset_issuer: SPONSOR,
              balance: '5',
            },
          ],
        }),
      );
      expect(data.entries[0].sponsor).toBeNull();
    });

    it('reports unsupported endpoint capabilities', () => {
      const data = extractSponsorshipData(account(), { supportedEntryTypes: ['offers'] });
      expect(data.limitations.join(' ')).toMatch(/Offer sponsorship/);
      expect(data.entries).toHaveLength(0);
    });
  });

  describe('reserve estimation', () => {
    it('estimates obligations with known network parameters', () => {
      const metadata = extractSponsorshipMetadata(
        account({ num_sponsoring: 2, subentry_count: 3 }),
      );
      const entries = extractSponsorshipData(
        account({
          balances: [
            {
              asset_type: 'credit_alphanum4',
              asset_code: 'USD',
              asset_issuer: SPONSOR,
              balance: '5',
              sponsor: SPONSOR,
            },
          ],
        }),
      ).entries;
      const estimate = estimateReserveDependencies(metadata, entries, 5_000_000n);
      expect(estimate.outgoingReserveStroops).toBe('10000000');
      expect(estimate.incomingReserveReliefStroops).toBe('5000000');
      expect(estimate.ownReserveStroops).toBe('10000000');
      expect(estimate.assumptions.join(' ')).toMatch(/base reserve/);
    });
  });

  describe('report generation', () => {
    it('distinguishes sponsors from sponsored accounts', async () => {
      const report = await inspectSponsorship(
        loader(account({ sponsor: SPONSOR, num_sponsored: 1 })),
        ACCOUNT,
        {
          baseReserveStroops: 5_000_000n,
        },
      );
      expect(report.sponsors).toContain(SPONSOR);
      expect(report.sponsored).toContain(ACCOUNT);
      expect(report.reserve).not.toBeNull();
    });

    it('handles an account with no sponsorship relationships', async () => {
      const report = await inspectSponsorship(loader(account()), ACCOUNT);
      expect(report.sponsors).toEqual([]);
      expect(report.entries).toEqual([]);
      expect(report.risks).toEqual([]);
    });

    it('reports a sponsor account that cannot be retrieved', async () => {
      const record = account({
        balances: [
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USD',
            asset_issuer: SPONSOR,
            balance: '5',
            sponsor: SPONSOR,
          },
        ],
      });
      const report = await inspectSponsorship(loader(record, [SPONSOR]), ACCOUNT);
      expect(report.errors.join(' ')).toMatch(/404 for/);
      expect(report.risks.join(' ')).toMatch(/could not be verified/);
    });

    it('reports incomplete or inconsistent sponsorship metadata', async () => {
      const report = await inspectSponsorship(loader(account({ num_sponsored: 2 })), ACCOUNT);
      expect(report.risks.join(' ')).toMatch(/num_sponsored is positive/);
    });

    it('reports a network failure when the account cannot be loaded', async () => {
      const failing: AccountLoader = {
        loadAccount: async () => {
          throw new Error('ECONNRESET');
        },
      };
      await expect(inspectSponsorship(failing, ACCOUNT)).rejects.toThrow(
        /Unable to load account .*ECONNRESET/,
      );
    });

    it('reports a significant reserve obligation as a risk', async () => {
      const record = account({ num_sponsoring: 20, subentry_count: 20 });
      const report = await inspectSponsorship(loader(record), ACCOUNT, {
        baseReserveStroops: 5_000_000n,
        significantReserveStroops: 10_000_000n,
      });
      expect(report.risks.join(' ')).toMatch(/exceeds the configured significance threshold/);
    });
  });
});
