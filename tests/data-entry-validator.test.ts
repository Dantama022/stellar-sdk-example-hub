import { Account } from '../examples/_shared/horizon-readonly';
import { decodeData, inspectDataProposal, validateDataInput } from '../examples/account-data/data-entry-validator';
import { validateAccountData } from '../examples/account-data/data-entry-inspector';

const id = 'GABMKJM6I25XI4K7U6XWMULOUQIQ27BCTMLS6BYYSOWKTBUXVRJSXHYQ';
const account: Account = { account_id: id, data: { existing: 'MQ==' },
  balances: [{ asset_type: 'native', balance: '3' }], subentry_count: 1, num_sponsoring: 0, num_sponsored: 0 };

describe('ISSUE-396 ManageData validator', () => {
  test('validates byte lengths rather than JS characters', () => {
    expect(validateDataInput('é'.repeat(32), '🐱'.repeat(16)).valid).toBe(true);
    expect(validateDataInput('é'.repeat(33), 'ok').valid).toBe(false);
    expect(validateDataInput('key', '🐱'.repeat(17)).errors).toContain('Value cannot exceed 64 encoded bytes');
  });
  test('accepts exactly 64 bytes and an empty value', () => {
    expect(validateDataInput('k'.repeat(64), '').valid).toBe(true);
    expect(validateDataInput('k'.repeat(65), '').valid).toBe(false);
    expect(validateDataInput('', 'value').valid).toBe(false);
  });
  test('supports byte arrays, strict hex/base64 and removal', () => {
    expect(decodeData({ encoding: 'hex', data: '00ff' })).toEqual(Buffer.from([0, 255]));
    expect(decodeData({ encoding: 'base64', data: 'AP8=' })).toEqual(Buffer.from([0, 255]));
    expect(validateDataInput('key', Uint8Array.from([1, 2])).valueBytes).toBe(2);
    expect(validateDataInput('key').removal).toBe(true);
    expect(validateDataInput('key', { encoding: 'hex', data: 'z' }).valid).toBe(false);
    expect(validateDataInput('key', { encoding: 'base64', data: '$$' }).valid).toBe(false);
  });
  test('distinguishes creation, update and removal', () => {
    expect(inspectDataProposal({ accountId: id, key: 'new', value: 'new' }, account, '5000000').operation).toBe('create');
    expect(inspectDataProposal({ accountId: id, key: 'existing', value: 'x' }, account).operation).toBe('update');
    expect(inspectDataProposal({ accountId: id, key: 'existing' }, account).operation).toBe('remove');
    expect(inspectDataProposal({ accountId: id, key: 'absent' }, account).localValid).toBe(false);
  });
  test('missing account and missing data metadata are reported', () => {
    expect(inspectDataProposal({ accountId: id, key: 'a', value: 'b' }, null).localValid).toBe(false);
    expect(inspectDataProposal({ accountId: id, key: 'a', value: 'b' }, { ...account, data: undefined }).warnings)
      .toEqual(expect.arrayContaining([expect.stringContaining('missing')]));
  });
  test('network fetch failure is explicit and never submits transactions', async () => {
    const fetcher = jest.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch;
    await expect(validateAccountData({ accountId: id, key: 'a', value: 'b' }, 'testnet', '5000000', fetcher))
      .rejects.toThrow('Horizon network failure');
  });
});
