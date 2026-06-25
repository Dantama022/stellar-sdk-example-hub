import { extractSponsorshipSummary } from '../src/examples/11-sponsored-reserves';

describe('Sponsored reserves helpers', () => {
  it('extracts sponsorship metrics from Horizon account-like objects', () => {
    const summary = extractSponsorshipSummary(
      {
        account_id: 'GSPONSOR',
        num_sponsoring: 3,
      },
      {
        account_id: 'GSPONSORED',
        num_sponsored: 1,
      },
    );

    expect(summary.sponsorAccount).toBe('GSPONSOR');
    expect(summary.sponsoredAccount).toBe('GSPONSORED');
    expect(summary.sponsorOutstandingCount).toBe(3);
    expect(summary.sponsoredResourceCount).toBe(1);
  });

  it('uses defaults when sponsorship counters are missing', () => {
    const summary = extractSponsorshipSummary(
      {
        account_id: 'GSPONSOR',
      },
      {
        account_id: 'GSPONSORED',
      },
    );

    expect(summary.sponsorOutstandingCount).toBe(0);
    expect(summary.sponsoredResourceCount).toBe(0);
  });
});
