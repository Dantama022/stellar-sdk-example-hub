import {
  formatEffectSummary,
  isEffectRelatedToAccount,
  isValidTransactionHash,
} from '../src/examples/45-horizon-effects';

import {
  decodeDataValue,
  estimateMinimumBalanceXlm,
  getDecodedDataEntry,
} from '../src/examples/47-account-data-entries';

import {
  getIssuerFlagSummary,
  getTrustlineAuthorizationState,
} from '../src/examples/48-asset-authorization-flags';

import {
  extractClaimantDestinations,
  findCreatedClaimableBalanceId,
  stringifyClaimPredicate,
} from '../src/examples/49-claimable-balance-inspection';

import { examples } from '../src/runner/catalog';

describe('Issue #57: horizon effects helpers', () => {
  it('validates transaction hash formatting', () => {
    expect(isValidTransactionHash('a'.repeat(64))).toBe(true);
    expect(isValidTransactionHash('A'.repeat(64))).toBe(true);
    expect(isValidTransactionHash('abc')).toBe(false);
  });

  it('formats an effect summary with key details', () => {
    const summary = formatEffectSummary({
      type: 'account_credited',
      account: 'GACCOUNT',
      asset: 'native',
      amount: '10.5',
    });

    expect(summary).toContain('type=account_credited');
    expect(summary).toContain('actor=GACCOUNT');
    expect(summary).toContain('asset=native');
    expect(summary).toContain('amount=10.5');
  });

  it('matches effects related to an account across common fields', () => {
    expect(
      isEffectRelatedToAccount(
        {
          type: 'trustline_created',
          trustor: 'GTRUSTOR',
        },
        'GTRUSTOR',
      ),
    ).toBe(true);

    expect(
      isEffectRelatedToAccount(
        {
          type: 'trustline_created',
          trustor: 'GTRUSTOR',
        },
        'GOTHER',
      ),
    ).toBe(false);
  });
});

describe('Issue #59: account data entries helpers', () => {
  it('decodes base64 data values', () => {
    const encoded = Buffer.from('hello-world', 'utf-8').toString('base64');
    expect(decodeDataValue(encoded)).toBe('hello-world');
    expect(decodeDataValue(undefined)).toBeNull();
  });

  it('reads a decoded data entry by key', () => {
    const entries = {
      my_key: Buffer.from('value-1', 'utf-8').toString('base64'),
    };

    expect(getDecodedDataEntry(entries, 'my_key')).toBe('value-1');
    expect(getDecodedDataEntry(entries, 'missing')).toBeNull();
  });

  it('estimates minimum balance from subentry count', () => {
    expect(estimateMinimumBalanceXlm(0)).toBe('1.0000000');
    expect(estimateMinimumBalanceXlm(1)).toBe('1.5000000');
  });
});

describe('Issue #60: asset authorization helpers', () => {
  it('summarizes issuer flag values', () => {
    expect(
      getIssuerFlagSummary({
        auth_required: true,
        auth_revocable: true,
        auth_immutable: false,
      }),
    ).toEqual({
      authRequired: true,
      authRevocable: true,
      authImmutable: false,
    });
  });

  it('classifies trustline authorization state', () => {
    expect(
      getTrustlineAuthorizationState(
        [
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USDX',
            asset_issuer: 'GISSUER',
            balance: '0.0000000',
            is_authorized: true,
          },
        ],
        'USDX',
        'GISSUER',
      ),
    ).toBe('AUTHORIZED');

    expect(
      getTrustlineAuthorizationState(
        [
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USDX',
            asset_issuer: 'GISSUER',
            balance: '0.0000000',
            is_authorized: false,
          },
        ],
        'USDX',
        'GISSUER',
      ),
    ).toBe('UNAUTHORIZED');
  });
});

describe('Issue #61: claimable balance inspection helpers', () => {
  it('formats common claim predicates', () => {
    expect(stringifyClaimPredicate({ unconditional: true })).toBe('unconditional');
    expect(stringifyClaimPredicate({ before_relative_time: '3600' })).toBe(
      'before_relative_time(3600)',
    );
    expect(stringifyClaimPredicate({ not: { unconditional: true } })).toBe('not(unconditional)');
  });

  it('extracts claimant destinations', () => {
    expect(
      extractClaimantDestinations({
        id: 'abc',
        asset: 'native',
        amount: '1',
        claimants: [
          { destination: 'GA', predicate: { unconditional: true } },
          { destination: 'GB', predicate: { unconditional: true } },
        ],
      }),
    ).toEqual(['GA', 'GB']);
  });

  it('finds claimable balance id from effects', () => {
    expect(
      findCreatedClaimableBalanceId([
        { type: 'account_credited' },
        { type: 'claimable_balance_created', balance_id: '0000abc' },
      ]),
    ).toBe('0000abc');
  });
});

describe('Runner registration for Issues #57, #59, #60, and #61', () => {
  it('registers all new examples in the runner catalog', () => {
    for (const exampleName of [
      '45-horizon-effects',
      '47-account-data-entries',
      '48-asset-authorization-flags',
      '49-claimable-balance-inspection',
    ]) {
      expect(examples[exampleName]).toBeDefined();
      expect(typeof examples[exampleName].run).toBe('function');
    }
  });
});
