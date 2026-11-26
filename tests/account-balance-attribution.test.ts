import { attributeMovements, analyzeAccountBalances } from '../examples/balance-analysis/account-balance-attribution';
import { ActivityOperation, classifyOperation } from '../examples/balance-analysis/operation-classification';
const id = 'GABMKJM6I25XI4K7U6XWMULOUQIQ27BCTMLS6BYYSOWKTBUXVRJSXHYQ';
const other = 'GCVLWV5B3L3YE6DSCCMHLCK7QIB365NYOLQLW3ZKHI5XINNMRLJ6YHVX';
const op = (overrides: Partial<ActivityOperation>): ActivityOperation => ({
  id: '1', type: 'payment', transaction_hash: 'hash1', ledger: 10, transaction_successful: true,
  from: other, to: id, asset_type: 'native', amount: '1.2345678', ...overrides,
});

describe('ISSUE-395 balance attribution', () => {
  test('tracks incoming and outgoing XLM and fees separately', () => {
    const result = attributeMovements(id, [op({}), op({ id: '2', transaction_hash: 'hash2', from: id, to: other, amount: '0.25' })],
      [{ hash: 'hash1', source_account: other, successful: true, fee_charged: '100', ledger: 10 },
        { hash: 'hash2', source_account: id, successful: true, fee_charged: '200', ledger: 11 }]);
    expect(result.byAsset).toContainEqual({ asset: 'XLM', incoming: '1.2345678', outgoing: '0.25', net: '0.9845678' });
    expect(result.transactionFeesXlm).toBe('0.00002');
  });
  test('distinguishes issued assets by issuer and handles path source/destination assets', () => {
    const issued = op({ id: 'asset', asset_type: 'credit_alphanum4', asset_code: 'USD', asset_issuer: other, amount: '2' });
    const path = op({ id: 'path', type: 'path_payment_strict_send', from: id, to: id,
      source_amount: '3', source_asset_type: 'native', asset_type: 'credit_alphanum4',
      asset_code: 'USD', asset_issuer: other, amount: '4' });
    const result = attributeMovements(id, [issued, path], []);
    expect(result.byAsset).toEqual(expect.arrayContaining([
      { asset: `USD:${other}`, incoming: '6', outgoing: '0', net: '6' },
      { asset: 'XLM', incoming: '0', outgoing: '3', net: '-3' },
    ]));
  });
  test('classifies reserves and offers as opaque rather than payments', () => {
    expect(classifyOperation(op({ type: 'change_trust' }), id).movements).toHaveLength(0);
    expect(classifyOperation(op({ type: 'manage_sell_offer' }), id).notes[0]).toContain('liabilities');
    expect(classifyOperation(op({ type: 'account_merge' }), id).notes[0]).toContain('exact amount');
  });
  test('reports liquidity pool reserves and shares from available operation fields', () => {
    const result = classifyOperation(op({ type: 'liquidity_pool_deposit', source_account: id,
      liquidity_pool_id: 'pool1', reserves_deposited: [{ asset: 'native', amount: '1' }], shares_received: '2' }), id);
    expect(result.movements.map(m => [m.asset, m.direction])).toEqual([['XLM', 'outgoing'], ['POOL:pool1', 'incoming']]);
  });
  test('ignores failed operations and duplicate IDs and warns on incomplete fee metadata', () => {
    const result = attributeMovements(id, [op({}), op({}), op({ id: 'failed', transaction_successful: false })],
      [{ hash: 'hash1', source_account: id, successful: true }]);
    expect(result.analysedOperations).toBe(2);
    expect(result.movements).toHaveLength(1);
    expect(result.warnings.join(' ')).toMatch(/Duplicate|invalid fee/);
  });
  test('handles invalid range, malformed amounts, and unknown operations', () => {
    expect(() => attributeMovements(id, [], [], { fromLedger: 4, toLedger: 3 })).toThrow();
    expect(classifyOperation(op({ amount: '0.00000001' }), id).notes).toEqual(expect.arrayContaining([expect.stringContaining('malformed')]));
    expect(classifyOperation(op({ type: 'invoke_host_function' }), id).notes[0]).toContain('Unsupported');
  });
  test('network failure produces a useful error', async () => {
    const fetcher = jest.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch;
    await expect(analyzeAccountBalances(id, 'testnet', {}, fetcher)).rejects.toThrow('Horizon network failure');
  });
});
