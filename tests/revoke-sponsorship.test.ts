import {
  buildRevocationSummary,
  describeReserveResponsibility,
} from '../src/examples/35-revoke-sponsorship';

describe('Revoke sponsorship helpers', () => {
  it('builds a before/after sponsorship summary', () => {
    const summary = buildRevocationSummary(
      { account_id: 'GSPONSOR', num_sponsoring: 1 },
      { account_id: 'GSPONSOR', num_sponsoring: 0 },
      { account_id: 'GSPONSORED', num_sponsored: 1 },
      { account_id: 'GSPONSORED', num_sponsored: 0 },
      'GSPONSOR',
      null,
    );

    expect(summary.sponsorOutstandingBefore).toBe(1);
    expect(summary.sponsorOutstandingAfter).toBe(0);
    expect(summary.dataEntrySponsorAfter).toBeNull();
  });

  it('explains reserve responsibility after revocation', () => {
    const message = describeReserveResponsibility({
      sponsorAccount: 'GSPONSOR',
      sponsoredAccount: 'GSPONSORED',
      sponsorOutstandingBefore: 1,
      sponsorOutstandingAfter: 0,
      sponsoredCountBefore: 1,
      sponsoredCountAfter: 0,
      dataEntrySponsorBefore: 'GSPONSOR',
      dataEntrySponsorAfter: null,
    });

    expect(message).toContain('GSPONSORED');
  });
});
