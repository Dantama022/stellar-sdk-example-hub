import { Horizon } from '@stellar/stellar-sdk';

import {
  attachLedgerSequences,
  determinePaymentDirection,
  fetchPaymentRecords,
  findAccountFromPayment,
  formatPaymentAsset,
  formatPaymentHistoryReport,
  normalizePaymentLimit,
  parsePaymentRecord,
  summarizePayments,
  type ParsedPayment,
  type RawPaymentRecord,
} from '../src/examples/62-payment-history';

const INSPECTED_ACCOUNT = 'GINSPECTEDACCOUNT';
const OTHER_ACCOUNT = 'GOTHERACCOUNT';
const THIRD_ACCOUNT = 'GTHIRDACCOUNT';

describe('Example 62: Horizon payment history helpers', () => {
  describe('normalizePaymentLimit', () => {
    it('uses the default for missing or invalid values', () => {
      expect(normalizePaymentLimit()).toBe(10);
      expect(normalizePaymentLimit('not-a-number')).toBe(10);
    });

    it('clamps limits to the Horizon range', () => {
      expect(normalizePaymentLimit(0)).toBe(1);
      expect(normalizePaymentLimit(-20)).toBe(1);
      expect(normalizePaymentLimit(25)).toBe(25);
      expect(normalizePaymentLimit('40')).toBe(40);
      expect(normalizePaymentLimit(500)).toBe(200);
    });
  });

  describe('formatPaymentAsset', () => {
    it('formats native XLM', () => {
      expect(formatPaymentAsset('native')).toBe('XLM (native)');
      expect(formatPaymentAsset()).toBe('XLM (native)');
    });

    it('formats an issued asset with its issuer', () => {
      expect(formatPaymentAsset('credit_alphanum4', 'USDC', 'GISSUERACCOUNT')).toBe(
        'USDC:GISSUERACCOUNT',
      );
    });
  });

  describe('determinePaymentDirection', () => {
    it('identifies incoming payments', () => {
      expect(determinePaymentDirection(INSPECTED_ACCOUNT, OTHER_ACCOUNT, INSPECTED_ACCOUNT)).toBe(
        'incoming',
      );
    });

    it('identifies outgoing payments', () => {
      expect(determinePaymentDirection(INSPECTED_ACCOUNT, INSPECTED_ACCOUNT, OTHER_ACCOUNT)).toBe(
        'outgoing',
      );
    });

    it('identifies self-payments', () => {
      expect(
        determinePaymentDirection(INSPECTED_ACCOUNT, INSPECTED_ACCOUNT, INSPECTED_ACCOUNT),
      ).toBe('self');
    });

    it('identifies records related through another supported shape', () => {
      expect(determinePaymentDirection(INSPECTED_ACCOUNT, OTHER_ACCOUNT, THIRD_ACCOUNT)).toBe(
        'related',
      );
    });
  });

  describe('parsePaymentRecord', () => {
    it('parses an incoming native XLM payment', () => {
      const record: RawPaymentRecord = {
        id: '1001',
        type: 'payment',
        from: OTHER_ACCOUNT,
        to: INSPECTED_ACCOUNT,
        amount: '12.3400000',
        asset_type: 'native',
        transaction_hash: 'a'.repeat(64),
        created_at: '2026-07-29T12:00:00Z',
        ledger: 123456,
      };

      expect(parsePaymentRecord(record, INSPECTED_ACCOUNT)).toEqual({
        operationId: '1001',
        operationType: 'payment',
        direction: 'incoming',
        amount: '12.3400000',
        asset: 'XLM (native)',
        sourceAccount: OTHER_ACCOUNT,
        destinationAccount: INSPECTED_ACCOUNT,
        counterparty: OTHER_ACCOUNT,
        transactionHash: 'a'.repeat(64),
        ledgerSequence: 123456,
        createdAt: '2026-07-29T12:00:00Z',
      });
    });

    it('parses an outgoing issued-asset payment', () => {
      const record: RawPaymentRecord = {
        paging_token: '1002',
        type: 'payment',
        from: INSPECTED_ACCOUNT,
        to: OTHER_ACCOUNT,
        amount: '25.0000000',
        asset_type: 'credit_alphanum4',
        asset_code: 'USDC',
        asset_issuer: 'GISSUERACCOUNT',
        transaction_hash: 'b'.repeat(64),
        created_at: '2026-07-29T13:00:00Z',
      };

      const payment = parsePaymentRecord(record, INSPECTED_ACCOUNT);

      expect(payment.direction).toBe('outgoing');
      expect(payment.amount).toBe('25.0000000');
      expect(payment.asset).toBe('USDC:GISSUERACCOUNT');
      expect(payment.counterparty).toBe(OTHER_ACCOUNT);
    });

    it('parses account creation as an incoming XLM payment', () => {
      const record: RawPaymentRecord = {
        id: '1003',
        type: 'create_account',
        funder: OTHER_ACCOUNT,
        account: INSPECTED_ACCOUNT,
        starting_balance: '10.0000000',
        transaction_hash: 'c'.repeat(64),
      };

      const payment = parsePaymentRecord(record, INSPECTED_ACCOUNT);

      expect(payment.direction).toBe('incoming');
      expect(payment.amount).toBe('10.0000000');
      expect(payment.asset).toBe('XLM (native)');
      expect(payment.sourceAccount).toBe(OTHER_ACCOUNT);
      expect(payment.destinationAccount).toBe(INSPECTED_ACCOUNT);
    });

    it('uses the destination amount and asset for path payments', () => {
      const record: RawPaymentRecord = {
        id: '1004',
        type: 'path_payment_strict_send',
        from: INSPECTED_ACCOUNT,
        to: OTHER_ACCOUNT,
        source_amount: '50.0000000',
        source_asset_type: 'native',
        destination_amount: '9.5000000',
        destination_asset_type: 'credit_alphanum4',
        destination_asset_code: 'EURC',
        destination_asset_issuer: 'GEURCISSUER',
      };

      const payment = parsePaymentRecord(record, INSPECTED_ACCOUNT);

      expect(payment.direction).toBe('outgoing');
      expect(payment.amount).toBe('9.5000000');
      expect(payment.asset).toBe('EURC:GEURCISSUER');
    });

    it('handles account-merge records without inventing an amount', () => {
      const record: RawPaymentRecord = {
        id: '1005',
        type: 'account_merge',
        source_account: INSPECTED_ACCOUNT,
        into: OTHER_ACCOUNT,
      };

      const payment = parsePaymentRecord(record, INSPECTED_ACCOUNT);

      expect(payment.direction).toBe('outgoing');
      expect(payment.amount).toBeNull();
      expect(payment.asset).toBe('XLM (native)');
    });
  });

  describe('summarizePayments', () => {
    it('summarizes directions and assets', () => {
      const payments: ParsedPayment[] = [
        {
          operationId: '1',
          operationType: 'payment',
          direction: 'incoming',
          amount: '1.0000000',
          asset: 'XLM (native)',
          sourceAccount: OTHER_ACCOUNT,
          destinationAccount: INSPECTED_ACCOUNT,
          counterparty: OTHER_ACCOUNT,
          transactionHash: 'a',
          createdAt: '2026-01-01T00:00:00Z',
        },
        {
          operationId: '2',
          operationType: 'payment',
          direction: 'outgoing',
          amount: '2.0000000',
          asset: 'USDC:GISSUER',
          sourceAccount: INSPECTED_ACCOUNT,
          destinationAccount: OTHER_ACCOUNT,
          counterparty: OTHER_ACCOUNT,
          transactionHash: 'b',
          createdAt: '2026-01-02T00:00:00Z',
        },
        {
          operationId: '3',
          operationType: 'payment',
          direction: 'incoming',
          amount: '3.0000000',
          asset: 'XLM (native)',
          sourceAccount: THIRD_ACCOUNT,
          destinationAccount: INSPECTED_ACCOUNT,
          counterparty: THIRD_ACCOUNT,
          transactionHash: 'c',
          createdAt: '2026-01-03T00:00:00Z',
        },
      ];

      expect(summarizePayments(payments)).toEqual({
        totalPayments: 3,
        incomingPayments: 2,
        outgoingPayments: 1,
        selfPayments: 0,
        relatedPayments: 0,
        paymentsByAsset: {
          'XLM (native)': 2,
          'USDC:GISSUER': 1,
        },
      });
    });
  });

  describe('fetchPaymentRecords', () => {
    it('queries the account payment endpoint with descending order and limit', async () => {
      const call = jest.fn().mockResolvedValue({
        records: [
          {
            id: 'payment-1',
            type: 'payment',
          },
        ],
      });

      const limit = jest.fn().mockReturnValue({
        call,
      });

      const order = jest.fn().mockReturnValue({
        limit,
      });

      const forAccount = jest.fn().mockReturnValue({
        order,
      });

      const payments = jest.fn().mockReturnValue({
        forAccount,
      });

      const server = {
        payments,
      } as unknown as Horizon.Server;

      const records = await fetchPaymentRecords(server, INSPECTED_ACCOUNT, 25);

      expect(payments).toHaveBeenCalledTimes(1);
      expect(forAccount).toHaveBeenCalledWith(INSPECTED_ACCOUNT);
      expect(order).toHaveBeenCalledWith('desc');
      expect(limit).toHaveBeenCalledWith(25);
      expect(call).toHaveBeenCalledTimes(1);
      expect(records).toHaveLength(1);
      expect(records[0].id).toBe('payment-1');
    });
  });

  describe('attachLedgerSequences', () => {
    it('resolves and reuses ledger sequences by transaction hash', async () => {
      const transaction = jest.fn().mockImplementation((hash: string) => ({
        call: jest.fn().mockResolvedValue({
          ledger: hash === 'hash-one' ? 101 : 202,
        }),
      }));

      const transactions = jest.fn().mockReturnValue({
        transaction,
      });

      const server = {
        transactions,
      } as unknown as Horizon.Server;

      const payments: ParsedPayment[] = [
        {
          operationId: '1',
          operationType: 'payment',
          direction: 'incoming',
          amount: '1.0000000',
          asset: 'XLM (native)',
          sourceAccount: OTHER_ACCOUNT,
          destinationAccount: INSPECTED_ACCOUNT,
          counterparty: OTHER_ACCOUNT,
          transactionHash: 'hash-one',
          createdAt: '2026-01-01T00:00:00Z',
        },
        {
          operationId: '2',
          operationType: 'payment',
          direction: 'outgoing',
          amount: '2.0000000',
          asset: 'XLM (native)',
          sourceAccount: INSPECTED_ACCOUNT,
          destinationAccount: OTHER_ACCOUNT,
          counterparty: OTHER_ACCOUNT,
          transactionHash: 'hash-one',
          createdAt: '2026-01-02T00:00:00Z',
        },
        {
          operationId: '3',
          operationType: 'payment',
          direction: 'incoming',
          amount: '3.0000000',
          asset: 'XLM (native)',
          sourceAccount: THIRD_ACCOUNT,
          destinationAccount: INSPECTED_ACCOUNT,
          counterparty: THIRD_ACCOUNT,
          transactionHash: 'hash-two',
          createdAt: '2026-01-03T00:00:00Z',
        },
      ];

      const result = await attachLedgerSequences(server, payments, 2);

      expect(transaction).toHaveBeenCalledTimes(2);
      expect(transaction).toHaveBeenCalledWith('hash-one');
      expect(transaction).toHaveBeenCalledWith('hash-two');
      expect(result.map((payment) => payment.ledgerSequence)).toEqual([101, 101, 202]);
    });
  });

  describe('formatPaymentHistoryReport', () => {
    it('handles an empty payment history gracefully', () => {
      const report = formatPaymentHistoryReport(INSPECTED_ACCOUNT, 10, []);

      expect(report).toContain('Records Found:  0');
      expect(report).toContain('No payment history was found for this account.');
      expect(report).toContain('valid empty result');
      expect(report).toContain('Payment records are narrower than generic operations');
    });

    it('formats payment amounts, directions, counterparties, and references', () => {
      const payment: ParsedPayment = {
        operationId: '1001',
        operationType: 'payment',
        direction: 'incoming',
        amount: '12.3400000',
        asset: 'XLM (native)',
        sourceAccount: OTHER_ACCOUNT,
        destinationAccount: INSPECTED_ACCOUNT,
        counterparty: OTHER_ACCOUNT,
        transactionHash: 'a'.repeat(64),
        ledgerSequence: 123456,
        createdAt: '2026-07-29T12:00:00Z',
      };

      const report = formatPaymentHistoryReport(INSPECTED_ACCOUNT, 10, [payment]);

      expect(report).toContain('Direction:        INCOMING');
      expect(report).toContain('Amount:           12.3400000 XLM (native)');
      expect(report).toContain(`Source:           ${OTHER_ACCOUNT}`);
      expect(report).toContain(`Counterparty:     ${OTHER_ACCOUNT}`);
      expect(report).toContain(`Transaction Hash: ${'a'.repeat(64)}`);
      expect(report).toContain('Ledger Sequence:  123456');
      expect(report).toContain('2026-07-29T12:00:00Z');
    });
  });

  describe('findAccountFromPayment', () => {
    it('prefers the destination account from a recent payment', () => {
      expect(
        findAccountFromPayment({
          from: OTHER_ACCOUNT,
          to: INSPECTED_ACCOUNT,
          source_account: OTHER_ACCOUNT,
        }),
      ).toBe(INSPECTED_ACCOUNT);
    });

    it('returns undefined for a missing record', () => {
      expect(findAccountFromPayment(undefined)).toBeUndefined();
    });
  });
});
