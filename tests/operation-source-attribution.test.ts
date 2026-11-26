import { attributeTransaction, TransactionRecord, OperationRecord } from '../examples/transaction-attribution/operation-source-attribution';

const tx: TransactionRecord = {
  hash: 'a'.repeat(64), source_account: 'TX_SOURCE', fee_charged: '300',
  operation_count: 2, successful: true, ledger: 123,
};
const ops: OperationRecord[] = [
  { type: 'payment', to: 'DEST', asset_type: 'native', amount: '4' },
  { type: 'change_trust', source_account: 'OTHER' },
];

describe('operation source and fee attribution (#580)', () => {
  it('distinguishes inherited and explicit sources, fees and non-transfers', () => {
    const result = attributeTransaction(tx, ops, {
      sources: [null, 'OTHER'], feeSource: 'FEE_PAYER', innerSource: 'TX_SOURCE', feeBump: true,
    });
    expect(result.feePayingAccount).toBe('FEE_PAYER');
    expect(result.feeChargedStroops).toBe('300');
    expect(result.operations.map((op) => op.sourceStatus)).toEqual(['inherited', 'explicit']);
    expect(result.operations.map((op) => op.effectiveSource)).toEqual(['TX_SOURCE', 'OTHER']);
    expect(result.assetTransfers).toHaveLength(1);
    expect(result.nonTransfers).toHaveLength(1);
    expect(result.operations[1].amount).toBeNull();
  });
  it('does not assert explicitness when envelope XDR is absent', () => {
    const result = attributeTransaction(tx, ops);
    expect(result.operations[1].sourceStatus).toBe('unverified');
    expect(result.warnings.join(' ')).toMatch(/envelope/i);
  });
  it('flags failed transactions and unsupported operation types', () => {
    const result = attributeTransaction({ ...tx, successful: false, operation_count: 1 },
      [{ type: 'unknown_op' }]);
    expect(result.operations[0].applied).toBe(false);
    expect(result.warnings.join(' ')).toMatch(/failed/i);
    expect(result.warnings.join(' ')).toMatch(/unsupported/i);
  });
  it('rejects corrupt fees and inconsistent envelope operation counts', () => {
    expect(() => attributeTransaction({ ...tx, fee_charged: '1.2' }, ops)).toThrow(/fee/i);
    expect(() => attributeTransaction(tx, ops, {
      sources: [null], feeSource: 'FEE', innerSource: 'TX_SOURCE', feeBump: false,
    })).toThrow(/count/i);
  });
});
