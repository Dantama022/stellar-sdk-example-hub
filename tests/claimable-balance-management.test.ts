import {
  evaluatePredicateEligibility,
  filterByAsset,
  findClaimantRecord,
  findCreatedClaimableBalanceId,
  stringifyClaimPredicate,
  type ClaimableBalanceLike,
} from '../src/examples/126-claimable-balance-management';
import { examples } from '../src/runner/catalog';

describe('126-claimable-balance-management', () => {
  describe('stringifyClaimPredicate', () => {
    it('renders unconditional predicates', () => {
      expect(stringifyClaimPredicate({ unconditional: true })).toBe('unconditional');
    });

    it('renders before_absolute_time predicates', () => {
      expect(stringifyClaimPredicate({ before_absolute_time: '1234567890' })).toBe(
        'before_absolute_time(1234567890)',
      );
    });

    it('renders not/and/or predicates recursively', () => {
      expect(stringifyClaimPredicate({ not: { unconditional: true } })).toBe('not(unconditional)');
      expect(
        stringifyClaimPredicate({
          and: [{ unconditional: true }, { before_absolute_time: '10' }],
        }),
      ).toBe('and(unconditional, before_absolute_time(10))');
    });

    it('returns a fallback string for unrecognized shapes', () => {
      expect(stringifyClaimPredicate(null)).toBe('unknown predicate');
      expect(stringifyClaimPredicate({})).toBe('unknown predicate');
    });
  });

  describe('evaluatePredicateEligibility', () => {
    it('is ELIGIBLE for unconditional predicates', () => {
      expect(evaluatePredicateEligibility({ unconditional: true })).toBe('ELIGIBLE');
    });

    it('evaluates before_absolute_time against the provided clock', () => {
      expect(evaluatePredicateEligibility({ before_absolute_time: '2000' }, 1000)).toBe('ELIGIBLE');
      expect(evaluatePredicateEligibility({ before_absolute_time: '2000' }, 3000)).toBe(
        'NOT_ELIGIBLE',
      );
    });

    it('is UNKNOWN for before_relative_time predicates', () => {
      expect(evaluatePredicateEligibility({ before_relative_time: '3600' })).toBe('UNKNOWN');
    });

    it('negates inner results for not()', () => {
      expect(evaluatePredicateEligibility({ not: { unconditional: true } })).toBe('NOT_ELIGIBLE');
    });

    it('requires all branches ELIGIBLE for and()', () => {
      expect(
        evaluatePredicateEligibility(
          {
            and: [{ unconditional: true }, { before_absolute_time: '2000' }],
          },
          1000,
        ),
      ).toBe('ELIGIBLE');
      expect(
        evaluatePredicateEligibility(
          {
            and: [{ unconditional: true }, { before_absolute_time: '2000' }],
          },
          3000,
        ),
      ).toBe('NOT_ELIGIBLE');
    });

    it('requires any branch ELIGIBLE for or()', () => {
      expect(
        evaluatePredicateEligibility(
          {
            or: [{ before_absolute_time: '2000' }, { unconditional: true }],
          },
          3000,
        ),
      ).toBe('ELIGIBLE');
    });

    it('is UNKNOWN when unable to interpret the shape', () => {
      expect(evaluatePredicateEligibility(null)).toBe('UNKNOWN');
    });
  });

  describe('findClaimantRecord', () => {
    const balance: ClaimableBalanceLike = {
      id: 'bal-1',
      asset: 'native',
      amount: '10',
      claimants: [{ destination: 'GABC', predicate: { unconditional: true } }],
    };

    it('finds a matching claimant', () => {
      expect(findClaimantRecord(balance, 'GABC')?.destination).toBe('GABC');
    });

    it('returns undefined when the account is not a claimant', () => {
      expect(findClaimantRecord(balance, 'GXYZ')).toBeUndefined();
    });
  });

  describe('filterByAsset', () => {
    const balances: ClaimableBalanceLike[] = [
      { id: '1', asset: 'native', amount: '1', claimants: [] },
      { id: '2', asset: 'USD:GISSUER', amount: '2', claimants: [] },
    ];

    it('returns all balances when no filter is given', () => {
      expect(filterByAsset(balances, undefined)).toHaveLength(2);
    });

    it('filters to native when "native" or "xlm" is given', () => {
      expect(filterByAsset(balances, 'native')).toEqual([balances[0]]);
      expect(filterByAsset(balances, 'XLM')).toEqual([balances[0]]);
    });

    it('filters to a matching issued asset', () => {
      expect(filterByAsset(balances, 'USD:GISSUER')).toEqual([balances[1]]);
    });
  });

  describe('findCreatedClaimableBalanceId', () => {
    it('extracts the balance ID from effects', () => {
      const id = findCreatedClaimableBalanceId([
        { type: 'account_debited' },
        { type: 'claimable_balance_created', balance_id: 'bal-42' },
      ]);
      expect(id).toBe('bal-42');
    });

    it('throws when no creation effect is present', () => {
      expect(() => findCreatedClaimableBalanceId([{ type: 'account_debited' }])).toThrow();
    });
  });

  describe('runner registration', () => {
    it('registers 126-claimable-balance-management in the catalog', () => {
      expect(examples['126-claimable-balance-management']).toBeDefined();
      expect(typeof examples['126-claimable-balance-management'].run).toBe('function');
    });
  });
});
