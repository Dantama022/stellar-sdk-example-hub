import { planReserves, reserveMinimum } from '../examples/reserve-planning/reserve-calculator';
import { applyChanges } from '../examples/reserve-planning/sponsorship-impact';
import { Account } from '../examples/_shared/horizon-readonly';

const owner = 'GABMKJM6I25XI4K7U6XWMULOUQIQ27BCTMLS6BYYSOWKTBUXVRJSXHYQ';
const sponsor = 'GCVLWV5B3L3YE6DSCCMHLCK7QIB365NYOLQLW3ZKHI5XINNMRLJ6YHVX';
const mock = (overrides: Partial<Account> = {}): Account => ({
  account_id: owner, balances: [{ asset_type: 'native', balance: '10', selling_liabilities: '1' }],
  subentry_count: 2, num_sponsoring: 0, num_sponsored: 0, signers: [], data: {}, ...overrides,
});
const setup = (changes: Parameters<typeof planReserves>[1]['changes'], base = '5000000') => ({
  changes, baseReserveStroops: base, reserveSource: 'Test fixture (not live network setting)',
});

describe('ISSUE-397 Stellar reserve planner', () => {
  test('reference case: 2 subentries require 2 XLM at 0.5 XLM base reserve', () => {
    expect(reserveMinimum({ subentries: 2, sponsored: 0, sponsoring: 0 }, 5_000_000n)).toBe(20_000_000n);
    const result = planReserves(mock(), setup([]));
    expect(result.minimumXlm.current).toBe('2');
    expect(result.estimatedSpendableXlm.current).toBe('7');
  });
  test.each(['trustline', 'signer', 'offer', 'data'] as const)('adding %s increases reserve by 0.5 XLM', (kind: 'trustline' | 'signer' | 'offer' | 'data') => {
    const report = planReserves(mock(), setup([{ action: 'add', kind }]));
    expect(report.reserveDifferenceXlm).toBe('0.5');
    expect(report.estimatedSpendableXlm.proposed).toBe('6.5');
  });
  test('removals release reserves', () => {
    expect(planReserves(mock(), setup([{ action: 'remove', kind: 'offer' }])).reserveDifferenceXlm).toBe('-0.5');
    expect(planReserves(mock(), setup([{ action: 'remove', kind: 'trustline' }])).reserveDifferenceXlm).toBe('-0.5');
    expect(planReserves(mock(), setup([{ action: 'remove', kind: 'signer' }])).minimumXlm.proposed).toBe('1.5');
  });
  test('a newly sponsored trustline transfers the reserve cost to sponsor', () => {
    const report = planReserves(mock(), setup([{ action: 'add', kind: 'trustline', sponsorId: sponsor }]), {
      [sponsor]: mock({ account_id: sponsor }),
    });
    expect(report.reserveDifferenceXlm).toBe('0');
    expect(report.sponsorImpacts[0].reserveDeltaXlm).toBe('0.5');
  });
  test('ending sponsorship returns reserve responsibility to owner', () => {
    const report = planReserves(mock({ num_sponsored: 1 }),
      setup([{ action: 'end-sponsorship', kind: 'signer', sponsorId: sponsor, entryIsCurrentlySponsored: true }]));
    expect(report.reserveDifferenceXlm).toBe('0.5');
    expect(report.sponsorImpacts[0].reserveDeltaXlm).toBe('-0.5');
  });
  test('higher supplied base reserve changes the reference requirement', () => {
    expect(planReserves(mock(), setup([], '10000000')).minimumXlm.current).toBe('4');
  });
  test('detects insufficient XLM and incomplete sponsor information', () => {
    const r = planReserves(mock({ balances: [{ asset_type: 'native', balance: '1' }] }),
      setup([{ action: 'add', kind: 'offer', sponsorId: sponsor }]));
    expect(r.warnings.some(w => w.includes('insufficient'))).toBe(true);
    expect(r.warnings.some(w => w.includes('not supplied'))).toBe(true);
  });
  test('rejects invalid values and impossible state transitions', () => {
    expect(() => planReserves(mock(), setup([], '-1'))).toThrow();
    expect(() => reserveMinimum({ subentries: -1, sponsoring: 0, sponsored: 0 }, 5n)).toThrow();
    expect(() => applyChanges({ subentries: 0, sponsoring: 0, sponsored: 0 },
      [{ action: 'remove', kind: 'trustline' }], owner)).toThrow();
  });
});
