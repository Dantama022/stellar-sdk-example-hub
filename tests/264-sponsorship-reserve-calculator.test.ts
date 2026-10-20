import {
  buildReport,
  calculateReserve,
  formatReport,
  inspectSponsorship,
  parseBaseReserve,
  validateAccountPublicKey,
  type HorizonAccountLike,
  type ReserveParameters,
  type SponsorshipInspection,
} from '../src/examples/264-sponsorship-reserve-calculator';

const ACCOUNT_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
const SPONSOR = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFXYCZLYF3436GTYOWD4S';
const BASE_RESERVE_STROOPS = 5_000_000; // 0.5 XLM

describe('ISSUE-386: Account validation', () => {
  it('accepts a valid public key', () => {
    expect(validateAccountPublicKey(ACCOUNT_ID)).toBe(ACCOUNT_ID);
  });

  it('rejects invalid public keys', () => {
    expect(() => validateAccountPublicKey('')).toThrow(/Missing/);
    expect(() => validateAccountPublicKey('not-a-key')).toThrow(/Invalid/);
    expect(() => validateAccountPublicKey('GTOOSHORT')).toThrow(/Invalid/);
  });
});

describe('ISSUE-386: Base reserve parsing', () => {
  it('parses a whole-number stroop value', () => {
    expect(parseBaseReserve('5000000').value).toBe(5_000_000);
    expect(parseBaseReserve('5000000').error).toBeNull();
  });

  it('returns null for absent input', () => {
    expect(parseBaseReserve()).toEqual({ value: null, error: null });
    expect(parseBaseReserve('')).toEqual({ value: null, error: null });
  });

  it('rejects invalid reserve values', () => {
    expect(parseBaseReserve('abc').value).toBeNull();
    expect(parseBaseReserve('abc').error).not.toBeNull();
    expect(parseBaseReserve('-100').value).toBeNull();
    expect(parseBaseReserve('10.5').value).toBeNull();
  });
});

describe('ISSUE-386: Sponsorship inspection', () => {
  const account: HorizonAccountLike = {
    id: ACCOUNT_ID,
    sequence: '100',
    subentry_count: 4,
    num_sponsored: 1,
    num_sponsoring: 1,
    thresholds: { low_threshold: 1, med_threshold: 2, high_threshold: 3 },
    balances: [
      { asset_type: 'native', balance: '50' },
      {
        asset_type: 'credit_alphanum4',
        asset_code: 'USDC',
        asset_issuer: SPONSOR,
        balance: '100',
        sponsor: SPONSOR,
      },
      {
        asset_type: 'credit_alphanum4',
        asset_code: 'EUR',
        asset_issuer: 'GISSUER',
        balance: '50',
        sponsor: ACCOUNT_ID,
      },
    ],
    signers: [
      { key: ACCOUNT_ID, weight: 1, type: 'ed25519_public_key' },
      { key: SPONSOR, weight: 1, type: 'ed25519_public_key', sponsor: SPONSOR },
    ],
    data: {},
  };

  it('identifies sponsored trustlines and signers', () => {
    const inspection = inspectSponsorship(account);
    expect(
      inspection.sponsoredEntries.some(
        (e) => e.type === 'trustline' && e.identifier === 'USDC:' + SPONSOR,
      ),
    ).toBe(true);
    expect(
      inspection.sponsoredEntries.some((e) => e.type === 'signer' && e.identifier === SPONSOR),
    ).toBe(true);
  });

  it('distinguishes sponsored-by-this-account from sponsored-by-another', () => {
    const inspection = inspectSponsorship(account);
    const usdc = inspection.sponsoredEntries.find((e) => e.identifier === 'USDC:' + SPONSOR)!;
    const eur = inspection.sponsoredEntries.find((e) => e.identifier === 'EUR:GISSUER')!;
    expect(usdc.sponsoredBy).toBe('another-account');
    expect(eur.sponsoredBy).toBe('this-account');
  });

  it('does not count the native balance or duplicate entries', () => {
    const inspection = inspectSponsorship(account);
    expect(inspection.sponsoredEntries.find((e) => e.identifier === 'native')).toBeUndefined();
    expect(inspection.sponsoredEntries.length).toBe(3);
  });

  it('handles an account without sponsorship metadata', () => {
    const plain: HorizonAccountLike = {
      ...account,
      num_sponsored: 0,
      num_sponsoring: 0,
      balances: [{ asset_type: 'native', balance: '10' }],
      signers: [{ key: ACCOUNT_ID, weight: 1, type: 'ed25519_public_key' }],
    };
    const inspection = inspectSponsorship(plain);
    expect(inspection.sponsoredEntries).toEqual([]);
    expect(inspection.sponsoredByOthers).toBe(0);
    expect(inspection.sponsoredByThisAccount).toBe(0);
    expect(inspection.unsupportedEntryTypes.length).toBeGreaterThan(0);
  });
});

describe('ISSUE-386: Reserve calculation', () => {
  const inspection: SponsorshipInspection = {
    accountId: ACCOUNT_ID,
    sponsor: null,
    numSponsored: 1,
    numSponsoring: 1,
    subentryCount: 4,
    sponsoredEntries: [],
    sponsoredByOthers: 1,
    sponsoredByThisAccount: 1,
    unsupportedEntryTypes: [],
  };

  const reserve: ReserveParameters = {
    baseReserveStroops: BASE_RESERVE_STROOPS,
    baseReserveXlm: 0.5,
    source: 'horizon-ledger',
  };

  it('applies the documented reserve formula', () => {
    // effective = 2 + 4 - 1 + 1 = 6; reserve = 6 * 0.5 XLM = 3 XLM
    const calculation = calculateReserve(inspection, reserve, '50');
    expect(calculation.effectiveSubentries).toBe(6);
    expect(calculation.minimumReserveStroops).toBe(30_000_000);
    expect(calculation.minimumReserveXlm).toBe(3);
    expect(calculation.nativeBalanceXlm).toBe(50);
    expect(calculation.estimatedAvailableXlm).toBe(47);
  });

  it('labels the result as an estimate', () => {
    const calculation = calculateReserve(inspection, reserve, undefined);
    expect(calculation.isEstimate).toBe(true);
  });
});

describe('ISSUE-386: Report formatting', () => {
  it('renders reserve inputs, formula, and estimate assumptions', () => {
    const inspection: SponsorshipInspection = {
      accountId: ACCOUNT_ID,
      sponsor: null,
      numSponsored: 0,
      numSponsoring: 0,
      subentryCount: 2,
      sponsoredEntries: [],
      sponsoredByOthers: 0,
      sponsoredByThisAccount: 0,
      unsupportedEntryTypes: ['data entries'],
    };
    const reserve: ReserveParameters = {
      baseReserveStroops: BASE_RESERVE_STROOPS,
      baseReserveXlm: 0.5,
      source: 'horizon-ledger',
    };
    const calculation = calculateReserve(inspection, reserve, '100');
    const report = buildReport(inspection, reserve, calculation);
    const formatted = formatReport(report);
    expect(formatted).toContain('ESTIMATE');
    expect(formatted).toContain('Minimum reserve:');
    expect(formatted).toContain('2.0000000'); // minimum reserve for 2 subentries at 0.5 XLM
    expect(formatted).toContain('not authoritative');
  });
});
