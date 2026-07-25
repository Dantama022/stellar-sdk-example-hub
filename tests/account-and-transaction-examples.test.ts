import { Horizon } from '@stellar/stellar-sdk';

import { getThresholdSnapshot, verifyThresholds } from '../src/examples/39-account-thresholds';

import {
  calculateReserveImpact,
  extractSponsorshipRelationships,
  getAccountSponsorshipSummary,
} from '../src/examples/41-sponsored-reserve-inspection';

import {
  getTransactionResultCode,
  nextSequenceNumber,
  verifySequenceNumber,
} from '../src/examples/42-account-sequence-numbers';

import {
  createTransactionSummary,
  getHorizonStatusCode,
  getLedgerSequence,
  isHorizonNotFoundError,
  isValidTransactionHash,
  retrieveTransactionByHash,
} from '../src/examples/46-transaction-detail-inspection';

import { examples } from '../src/runner/catalog';

function createAccountResponse(overrides: Record<string, unknown> = {}): Horizon.AccountResponse {
  return {
    account_id: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    sequence: '123',
    sequenceNumber: () => '123',
    subentry_count: 0,
    thresholds: {
      low_threshold: 0,
      med_threshold: 0,
      high_threshold: 0,
    },
    signers: [
      {
        key: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
        weight: 1,
      },
    ],
    balances: [],
    data_attr: {},
    num_sponsoring: 0,
    num_sponsored: 0,
    ...overrides,
  } as unknown as Horizon.AccountResponse;
}

describe('Issue #51: account threshold configuration helpers', () => {
  it('extracts the master weight and threshold values', () => {
    const account = createAccountResponse({
      thresholds: {
        low_threshold: 1,
        med_threshold: 2,
        high_threshold: 3,
      },
      signers: [
        {
          key: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
          weight: 3,
        },
        {
          key: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBR5',
          weight: 1,
        },
      ],
    });

    expect(getThresholdSnapshot(account)).toEqual({
      masterWeight: 3,
      lowThreshold: 1,
      mediumThreshold: 2,
      highThreshold: 3,
    });
  });

  it('verifies an expected threshold configuration', () => {
    const account = createAccountResponse({
      thresholds: {
        low_threshold: 1,
        med_threshold: 2,
        high_threshold: 3,
      },
      signers: [
        {
          key: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
          weight: 3,
        },
      ],
    });

    expect(() =>
      verifyThresholds(account, {
        masterWeight: 3,
        lowThreshold: 1,
        mediumThreshold: 2,
        highThreshold: 3,
      }),
    ).not.toThrow();
  });

  it('throws when Horizon returns unexpected threshold values', () => {
    const account = createAccountResponse();

    expect(() =>
      verifyThresholds(account, {
        masterWeight: 3,
        lowThreshold: 1,
        mediumThreshold: 2,
        highThreshold: 3,
      }),
    ).toThrow('Threshold verification failed');
  });
});

describe('Issue #53: sponsored reserve inspection helpers', () => {
  it('reads sponsoring and sponsored account fields', () => {
    const account = createAccountResponse({
      sponsor: 'GSPONSORAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABC',
      num_sponsoring: 2,
      num_sponsored: 3,
      subentry_count: 1,
    });

    expect(getAccountSponsorshipSummary(account)).toEqual({
      accountId: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      accountEntrySponsor: 'GSPONSORAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABC',
      sponsoringReserveUnits: 2,
      sponsoredReserveUnits: 3,
      subentryCount: 1,
    });
  });

  it('extracts account and data sponsorship relationships', () => {
    const relationships = extractSponsorshipRelationships([
      {
        type: 'account_sponsorship_created',
        account: 'GSPONSORED',
        sponsor: 'GSPONSOR',
      },
      {
        type: 'data_sponsorship_created',
        account: 'GSPONSORED',
        sponsor: 'GSPONSOR',
      },
      {
        type: 'account_credited',
        account: 'GSPONSORED',
      },
    ]);

    expect(relationships).toEqual([
      {
        entryType: 'account',
        sponsoredAccount: 'GSPONSORED',
        sponsorAccount: 'GSPONSOR',
      },
      {
        entryType: 'data',
        sponsoredAccount: 'GSPONSORED',
        sponsorAccount: 'GSPONSOR',
      },
    ]);
  });

  it('calculates the sponsor reserve responsibility', () => {
    const sponsorAccount = createAccountResponse({
      num_sponsoring: 3,
      num_sponsored: 0,
      subentry_count: 0,
    });

    expect(calculateReserveImpact(sponsorAccount, 5_000_000)).toEqual({
      baseReserveStroops: 5_000_000,
      baseReserveXlm: '0.5000000',
      sponsoringReserveUnits: 3,
      sponsoredReserveUnits: 0,
      outgoingReserveResponsibilityXlm: '1.5000000',
      incomingReserveReliefXlm: '0.0000000',
      minimumBalanceWithoutIncomingSponsorshipXlm: '2.5000000',
      effectiveMinimumBalanceXlm: '2.5000000',
    });
  });

  it('calculates the reserve relief received by a sponsored account', () => {
    const sponsoredAccount = createAccountResponse({
      num_sponsoring: 0,
      num_sponsored: 3,
      subentry_count: 1,
    });

    expect(calculateReserveImpact(sponsoredAccount, 5_000_000)).toEqual({
      baseReserveStroops: 5_000_000,
      baseReserveXlm: '0.5000000',
      sponsoringReserveUnits: 0,
      sponsoredReserveUnits: 3,
      outgoingReserveResponsibilityXlm: '0.0000000',
      incomingReserveReliefXlm: '1.5000000',
      minimumBalanceWithoutIncomingSponsorshipXlm: '1.5000000',
      effectiveMinimumBalanceXlm: '0.0000000',
    });
  });

  it('handles accounts with no sponsorship entries', () => {
    const account = createAccountResponse();

    expect(getAccountSponsorshipSummary(account)).toEqual({
      accountId: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      accountEntrySponsor: null,
      sponsoringReserveUnits: 0,
      sponsoredReserveUnits: 0,
      subentryCount: 0,
    });
  });
});

describe('Issue #54: account sequence-number helpers', () => {
  it('increments large 64-bit sequence values without precision loss', () => {
    expect(nextSequenceNumber('9007199254740993')).toBe('9007199254740994');
  });

  it('rejects invalid sequence values', () => {
    expect(() => nextSequenceNumber('not-a-sequence')).toThrow('Invalid Stellar sequence number');
  });

  it('extracts tx_bad_seq from a Horizon submission error', () => {
    const error = {
      response: {
        data: {
          extras: {
            result_codes: {
              transaction: 'tx_bad_seq',
            },
          },
        },
      },
    };

    expect(getTransactionResultCode(error)).toBe('tx_bad_seq');
  });

  it('returns null when no Horizon result code is present', () => {
    expect(getTransactionResultCode(new Error('Network error'))).toBeNull();
  });

  it('verifies expected sequence-number progression', () => {
    expect(() =>
      verifySequenceNumber('Submitted transaction', '16251881370157059', '16251881370157059'),
    ).not.toThrow();
  });

  it('throws when sequence numbers differ', () => {
    expect(() =>
      verifySequenceNumber('Submitted transaction', '16251881370157058', '16251881370157059'),
    ).toThrow('sequence verification failed');
  });
});

describe('Issue #58: Horizon transaction inspection helpers', () => {
  const validHash = '7cd17c0c11ea81580d7dc8f716e9d47d864a0da7e498280e306b1ab7c49f4777';

  it('validates transaction hash formatting', () => {
    expect(isValidTransactionHash(validHash)).toBe(true);
    expect(isValidTransactionHash(validHash.toUpperCase())).toBe(true);
    expect(isValidTransactionHash('not-a-valid-hash')).toBe(false);
    expect(isValidTransactionHash('0'.repeat(63))).toBe(false);
  });

  it('uses ledger_attr when the SDK replaces ledger with a link function', () => {
    expect(
      getLedgerSequence({
        id: validHash,
        hash: validHash,
        successful: true,
        ledger: async () => undefined,
        ledger_attr: 3_783_939,
        created_at: '2026-07-25T00:04:04Z',
        source_account: 'GC2YULMK7POTJWGSAJFKEXN4W5W6P7IHOVU3L3D647LBIBRY5NHPFNAT',
        source_account_sequence: '16251881370157059',
        fee_charged: '100',
        max_fee: '100',
        operation_count: 1,
        memo_type: 'none',
        envelope_xdr: 'envelope',
        result_xdr: 'result',
      }),
    ).toBe(3_783_939);
  });

  it('formats successful transaction metadata without a memo', () => {
    const summary = createTransactionSummary({
      id: validHash,
      hash: validHash,
      successful: true,
      ledger: 3_783_939,
      created_at: '2026-07-25T00:04:04Z',
      source_account: 'GC2YULMK7POTJWGSAJFKEXN4W5W6P7IHOVU3L3D647LBIBRY5NHPFNAT',
      source_account_sequence: '16251881370157059',
      fee_charged: '100',
      max_fee: '100',
      operation_count: 1,
      memo_type: 'none',
      envelope_xdr: 'invalid-test-envelope',
      result_xdr: 'invalid-test-result',
    });

    expect(summary).toMatchObject({
      hash: validHash,
      ledger: 3_783_939,
      sourceSequence: '16251881370157059',
      feeCharged: '100',
      maximumFee: '100',
      operationCount: 1,
      successful: true,
      statusLabel: 'SUCCESS',
      resultCode: 'tx_success',
      memoType: 'none',
      memoValue: null,
    });
  });

  it('formats failed transaction metadata and preserves its memo', () => {
    const summary = createTransactionSummary({
      id: validHash,
      hash: validHash,
      successful: false,
      ledger: 3_783_940,
      created_at: '2026-07-25T00:05:00Z',
      source_account: 'GC2YULMK7POTJWGSAJFKEXN4W5W6P7IHOVU3L3D647LBIBRY5NHPFNAT',
      source_account_sequence: '16251881370157060',
      fee_charged: 100,
      max_fee: 100,
      operation_count: 2,
      memo_type: 'text',
      memo: 'Audit reference',
      envelope_xdr: 'invalid-test-envelope',
      result_xdr: 'invalid-test-result',
    });

    expect(summary).toMatchObject({
      successful: false,
      statusLabel: 'FAILED',
      resultCode: 'tx_failed',
      memoType: 'text',
      memoValue: 'Audit reference',
    });
  });

  it('rejects a missing transaction hash before calling Horizon', async () => {
    const server = {} as Horizon.Server;

    await expect(retrieveTransactionByHash(server, '')).rejects.toThrow(
      'A transaction hash is required',
    );
  });

  it('rejects an invalid transaction hash before calling Horizon', async () => {
    const server = {} as Horizon.Server;

    await expect(retrieveTransactionByHash(server, 'invalid')).rejects.toThrow(
      'A Stellar transaction hash must contain exactly 64 hexadecimal characters',
    );
  });

  it('reports an unknown transaction hash clearly', async () => {
    const call = jest.fn().mockRejectedValue(
      Object.assign(new Error('Resource Missing'), {
        name: 'NotFoundError',
      }),
    );

    const server = {
      transactions: () => ({
        transaction: () => ({
          call,
        }),
      }),
    } as unknown as Horizon.Server;

    await expect(retrieveTransactionByHash(server, '0'.repeat(64))).rejects.toThrow(
      'was not found on the connected Horizon network',
    );

    expect(call).toHaveBeenCalledTimes(1);
  });

  it('extracts Horizon status codes from response errors', () => {
    expect(
      getHorizonStatusCode({
        response: {
          status: 404,
        },
      }),
    ).toBe(404);
  });

  it('identifies Stellar SDK NotFoundError values', () => {
    const error = Object.assign(new Error('Missing'), {
      name: 'NotFoundError',
    });

    expect(isHorizonNotFoundError(error)).toBe(true);
  });
});

describe('Runner registration for Issues #51, #53, #54, and #58', () => {
  const expectedExamples = [
    '39-account-thresholds',
    '41-sponsored-reserve-inspection',
    '42-account-sequence-numbers',
    '46-transaction-detail-inspection',
  ];

  it.each(expectedExamples)('registers %s in the runner catalog', (exampleName) => {
    expect(examples[exampleName]).toBeDefined();
    expect(typeof examples[exampleName].run).toBe('function');
  });

  it('registers the transaction-hash interactive prompt', () => {
    expect(examples['46-transaction-detail-inspection'].params).toEqual([
      {
        type: 'input',
        name: 'transactionHash',
        message: 'Enter a transaction hash, or leave blank to inspect the latest transaction:',
      },
    ]);
  });
});
