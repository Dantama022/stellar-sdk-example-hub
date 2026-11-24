import {
  buildAuditReport,
  extractSep31Payment,
  findAmountDiscrepancies,
  formatAmount,
  formatTextReport,
  parseAmount,
  toJson,
  verifyOnChain,
} from '../src/examples/410-sep-31-payment-reconciliation-auditor';

const completed = {
  id: 'sep31-1',
  status: 'completed',
  amount_in: '100.0000000',
  amount_out: '95.0000000',
  asset_in: 'USD:GISSUER',
  asset_out: 'EUR:GISSUER',
  quote: { amount_in: '100.0000000', amount_out: '95.0000000' },
  fee: '2.0000000',
  stellar_transaction_id: 'a'.repeat(64),
  external_transaction_id: 'ext-1',
};

describe('Issue #410: SEP-31 reconciliation auditor', () => {
  it('uses decimal-safe arithmetic', () => {
    expect(formatAmount(parseAmount('0.0000001') as bigint)).toBe('0.0000001');
    expect(parseAmount('1.00000001')).not.toBe(parseAmount('1.00000002'));
    expect(parseAmount('not-a-number')).toBeNull();
  });

  it('reconciles a completed payment with matching records', () => {
    const payment = extractSep31Payment(completed);
    const onChain = verifyOnChain(payment, {
      successful: true,
      operations: [{ type: 'payment', asset: 'USD:GISSUER', amount: '100.0000000' }],
    });
    const report = buildAuditReport('https://anchor.example', payment, onChain);
    expect(findAmountDiscrepancies(payment)).toHaveLength(0);
    expect(onChain.status).toBe('verified');
    expect(report.reconciliationStatus).toBe('matched');
  });

  it('detects sending and receiving amount mismatches', () => {
    const payment = extractSep31Payment({
      ...completed,
      amount_in: '99.0000000',
      amount_out: '94.0000000',
    });
    expect(findAmountDiscrepancies(payment).map((item) => item.field)).toEqual([
      'sending amount',
      'receiving amount',
    ]);
  });

  it('detects an exchange-rate discrepancy', () => {
    const payment = extractSep31Payment({ ...completed, exchange_rate: '2.0000000' });
    expect(findAmountDiscrepancies(payment).some((item) => item.field === 'exchange rate')).toBe(true);
  });

  it('categorizes fixed and percentage fees and flags missing fees', () => {
    expect(
      extractSep31Payment({
        ...completed,
        fee_details: { fixed: '1.0000000', percentage: '2.5' },
      }).fees.percentageFee,
    ).toBe('2.5');
    expect(extractSep31Payment(completed).fees.fixedFee).toBeNull();
    expect(extractSep31Payment({ ...completed, fee: undefined }).fees.complete).toBe(false);
    expect(extractSep31Payment({ ...completed, fee: undefined }).warnings.join(' ')).toMatch(/fee/);
  });

  it('handles pending status and missing on-chain references', () => {
    const pending = extractSep31Payment({ ...completed, status: 'pending', stellar_transaction_id: undefined });
    expect(verifyOnChain(pending, null).status).toBe('no-hash');
    expect(buildAuditReport('anchor', pending, verifyOnChain(pending, null)).reconciliationStatus).toBe(
      'pending',
    );
    const noTx = extractSep31Payment(completed);
    expect(buildAuditReport('anchor', noTx, verifyOnChain(noTx, null)).reconciliationStatus).toBe(
      'incomplete',
    );
  });

  it('detects on-chain asset and amount mismatches and reports limitations', () => {
    const payment = extractSep31Payment(completed);
    expect(
      verifyOnChain(payment, { operations: [{ type: 'payment', asset: 'XLM', amount: '1' }] }).status,
    ).toBe('mismatch');
    expect(
      verifyOnChain(payment, { successful: false, operations: [] }).status,
    ).toBe('mismatch');
    const report = buildAuditReport('anchor', payment, verifyOnChain(payment, null));
    expect(report.limitations.join(' ')).toMatch(/external bank payout/);
    expect(formatTextReport(report)).toContain('Reconciliation status');
    expect(JSON.parse(toJson(report)).payment.transactionId).toBe('sep31-1');
  });
});
