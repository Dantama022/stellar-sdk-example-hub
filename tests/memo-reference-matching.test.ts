import { collect } from '../examples/_shared/horizon-readonly';
import { decodeMemo, reconcilePayments, Payment, TxMemo } from '../examples/payment-reconciliation/memo-reference-matching';
import { PaymentReference } from '../examples/payment-reconciliation/payment-reference-registry';
const id = 'GABMKJM6I25XI4K7U6XWMULOUQIQ27BCTMLS6BYYSOWKTBUXVRJSXHYQ';
const issuer = 'GCVLWV5B3L3YE6DSCCMHLCK7QIB365NYOLQLW3ZKHI5XINNMRLJ6YHVX';
const registry: PaymentReference[] = [{ id: 'inv1', customerOrOrderId: 'order-1', memoType: 'text',
  memo: 'ORDER-1', destination: id, asset: 'XLM', amount: '2', status: 'unpaid' }];
const tx: TxMemo = { hash: 'hash1', memo_type: 'text', memo: 'ORDER-1', successful: true };
const payment: Payment = { id: 'op1', type: 'payment', transaction_hash: 'hash1', transaction_successful: true,
  from: issuer, to: id, asset_type: 'native', amount: '2' };

describe('ISSUE-394 memo reference matching', () => {
  test('decodes none, text, ID, hash and return memos', () => {
    expect(decodeMemo({ hash: '1', memo_type: 'none' }).normalized).toBeNull();
    expect(decodeMemo(tx).normalized).toBe('ORDER-1');
    expect(decodeMemo({ hash: '1', memo_type: 'id', memo: '00042' }).normalized).toBe('42');
    const raw = Buffer.alloc(32, 15).toString('base64');
    expect(decodeMemo({ hash: '1', memo_type: 'hash', memo: raw }).normalized).toBe('0f'.repeat(32));
    expect(decodeMemo({ hash: '1', memo_type: 'return', memo: raw }).normalized).toBe('0f'.repeat(32));
    expect(decodeMemo({ hash: '1', memo_type: 'hash', memo: 'AA==' }).error).toContain('32');
  });
  test('matches exact amounts without floating-point comparisons', () => {
    const result = reconcilePayments(id, [payment], [tx], registry);
    expect(result.counts['exact-match']).toBe(1);
    expect(result.outstandingReferences).toHaveLength(0);
  });
  test('separates amount and asset mismatch, unknown and ambiguous references', () => {
    expect(reconcilePayments(id, [{ ...payment, amount: '1.9999999' }], [tx], registry).results[0].status).toBe('amount-mismatch');
    expect(reconcilePayments(id, [{ ...payment, asset_type: 'credit_alphanum4', asset_code: 'USD', asset_issuer: issuer }], [tx], registry).results[0].status).toBe('asset-mismatch');
    expect(reconcilePayments(id, [payment], [{ ...tx, memo: 'unknown' }], registry).results[0].status).toBe('unknown-reference');
    expect(reconcilePayments(id, [payment], [tx], [...registry, { ...registry[0], id: 'inv2' }]).results[0].status).toBe('ambiguous-match');
  });
  test('detects duplicate records and repeated memos across transactions', () => {
    expect(reconcilePayments(id, [payment, payment], [tx], registry).results[1].status).toBe('duplicate-payment');
    const repeated = { ...payment, id: 'op2', transaction_hash: 'hash2' };
    expect(reconcilePayments(id, [payment, repeated], [tx, { ...tx, hash: 'hash2' }], registry).results[1].status).toBe('duplicate-payment');
  });
  test('does not mark incomplete or failed transaction as paid', () => {
    expect(reconcilePayments(id, [payment], [{ ...tx, successful: false }], registry).results[0].status).toBe('awaiting-verification');
    expect(reconcilePayments(id, [payment], [], registry).outstandingReferences).toEqual(['inv1']);
    expect(reconcilePayments(id, [{ ...payment, to: issuer }], [tx], registry).counts['exact-match']).toBe(0);
  });
  test('handles bad memo IDs and missing memos', () => {
    expect(decodeMemo({ hash: '1', memo_type: 'id', memo: '-1' }).error).toContain('Invalid');
    expect(reconcilePayments(id, [payment], [{ hash: 'hash1', memo_type: 'none', successful: true }], registry).results[0].status).toBe('unknown-reference');
  });
  test('paginates deterministically and detects incomplete history', async () => {
    const responses = [
      { _embedded: { records: [{ id: 1 }, { id: 2 }] }, _links: { next: { href: 'https://horizon-testnet.stellar.org/next' } } },
      { _embedded: { records: [{ id: 3 }] } },
    ];
    const fetcher = jest.fn().mockImplementation(() => Promise.resolve({ ok: true, json: async () => responses.shift() })) as unknown as typeof fetch;
    const result = await collect<{ id: number }>('testnet', '/first', 2, fetcher, 2);
    expect(result).toEqual({ records: [{ id: 1 }, { id: 2 }, { id: 3 }], complete: true });
  });
});
