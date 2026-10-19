import { Asset, Networks, xdr } from '@stellar/stellar-sdk';
import { decodeLedgerEntryXdr, describeData, getConfig, inspect, makeKeys } from '../src/examples/334-soroban-ledger-entry-inspector';
const id = Asset.native().contractId(Networks.TESTNET);

test('config and ledger keys validate inputs', () => {
  expect(getConfig({ STELLAR_NETWORK: 'testnet', CONTRACT_ID: id }).contractId).toBe(id);
  expect(makeKeys(id, ['COUNTER'])).toHaveLength(3);
  expect(() => getConfig({ STELLAR_NETWORK: 'invalid' })).toThrow('STELLAR_NETWORK');
  expect(() => getConfig({ STELLAR_NETWORK: 'mainnet' })).toThrow('SOROBAN_RPC_URL');
  expect(() => makeKeys('invalid', [])).toThrow('Invalid contract');
});

test('empty RPC results mean missing, not failed', async () => {
  const server = { getLedgerEntries: jest.fn(async () => ({ entries: [], latestLedger: 200 })) };
  const rows = await inspect(server as any, id, ['COUNTER']);
  expect(rows).toHaveLength(3);
  expect(rows.every(r => r.status === 'missing')).toBe(true);
});

test('mock RPC reports a known entry without assuming a contract schema', async () => {
  const key = makeKeys(id, [])[0];
  const val = { contractData: () => ({ val: () => xdr.ScVal.scvU32(7) }) } as unknown as xdr.LedgerEntryData;
  const server = { getLedgerEntries: jest.fn(async () => ({ entries: [{ key, val, lastModifiedLedgerSeq: 10 }], latestLedger: 12 })) };
  const rows = await inspect(server as any, id, []);
  expect(rows[0].details).toContain('7');
  expect(rows[0].lastModifiedLedgerSeq).toBe(10);
  expect(describeData(val)).toContain('scvU32');
});

test('malformed XDR and malformed response fail cleanly', async () => {
  expect(() => decodeLedgerEntryXdr('***')).toThrow('base64');
  expect(() => decodeLedgerEntryXdr('AAAA')).toThrow('malformed XDR');
  await expect(inspect({ getLedgerEntries: jest.fn(async () => ({ nope: true })) } as any, id, [])).rejects.toThrow('malformed');
});

test('RPC failure and timeout are distinct from missing entries', async () => {
  await expect(inspect({ getLedgerEntries: jest.fn(async () => { throw Error('secret-token'); }) } as any, id, []))
    .rejects.toThrow('Soroban RPC lookup failed');
  await expect(inspect({ getLedgerEntries: jest.fn(() => new Promise(() => undefined)) } as any, id, [], 2))
    .rejects.toThrow('timed out');
});
