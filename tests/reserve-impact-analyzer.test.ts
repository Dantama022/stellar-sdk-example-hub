import { compareReserve } from '../examples/reserve-analysis/reserve-impact-analyzer';
import { HorizonAccount } from '../examples/_shared/horizon';

const account: HorizonAccount = {
  account_id: 'account-A', sequence: '1', subentry_count: 3,
  num_sponsoring: 2, num_sponsored: 1,
  balances: [{ asset_type: 'native', balance: '2', selling_liabilities: '0.1' }],
  signers: [],
};
const input = {
  currentBaseReserveStroops: '5000000', proposedBaseReserveStroops: '10000000',
  currentSource: 'reference', proposedSource: 'scenario',
};

describe('reserve impact (#578)', () => {
  it('uses sponsorship counters once, and calculates hypothetical minimums', () => {
    const result = compareReserve(account, input);
    // (2 + 3 + 2 - 1) * 0.5 = 3 XLM; at 1 XLM = 6 XLM.
    expect(result.reserveUnits).toBe('6');
    expect(result.minimumBalanceXlm).toEqual({ current: '3', proposed: '6' });
    expect(result.deltaXlm).toBe('3');
    expect(result.changePercent).toBe(100);
    expect(result.availableBeforeLiabilitiesXlm).toEqual({ current: '-1', proposed: '-4' });
    expect(result.estimatedSpendableXlm).toEqual({ current: '-1.1', proposed: '-4.1' });
    expect(result.additionalXlmNeeded).toBe('4');
    expect(result.sponsorship.sponsoredReliefChangeXlm).toBe('0.5');
    expect(result.sponsorship.sponsoringContributionChangeXlm).toBe('1');
  });
  it('handles a fully sponsored account and a lower proposed reserve', () => {
    const result = compareReserve({ ...account, subentry_count: 0, num_sponsoring: 0, num_sponsored: 2 }, {
      ...input, proposedBaseReserveStroops: '100000',
    });
    expect(result.reserveUnits).toBe('0');
    expect(result.minimumBalanceXlm.proposed).toBe('0');
    expect(result.changePercent).toBeNull();
  });
  it('rejects invalid inputs and incomplete sponsorship metadata', () => {
    expect(() => compareReserve(account, { ...input, proposedBaseReserveStroops: '-1' })).toThrow();
    expect(() => compareReserve({ ...account, num_sponsored: undefined }, input)).toThrow(/sponsorship/i);
    expect(() => compareReserve({ ...account, subentry_count: -1 }, input)).toThrow(/subentry/i);
  });
  it('uses additional signers/subentries in the reference formula', () => {
    const result = compareReserve({ ...account, subentry_count: 4, num_sponsoring: 0, num_sponsored: 0 }, input);
    expect(result.minimumBalanceXlm.current).toBe('3');
  });
});
