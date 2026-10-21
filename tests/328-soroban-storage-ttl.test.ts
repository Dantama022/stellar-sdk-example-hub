import { Account, Keypair, Networks } from '@stellar/stellar-sdk';
import { assessTtl, buildTtlTransaction, inspectEntries, instanceKey, prepareTtlTransaction, submitTtlTransaction, validateTtlConfig } from '../src/examples/328-soroban-storage-ttl';

const id = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const cfg = { contractId: id, rpcUrl: 'https://soroban-testnet.stellar.org', passphrase: Networks.TESTNET, threshold: 10 };
test('classifies live, near-expiry and missing entries using ledger sequences', () => {
  expect(assessTtl(100, 150, 10).state).toBe('healthy');
  expect(assessTtl(100, 105, 10).state).toBe('expiring-soon');
  expect(assessTtl(100, undefined, 10, false).state).toBe('not-found-or-archived');
  expect(assessTtl(100, undefined, 10).state).toBe('ttl-unavailable');
});
test('validates contract, URL and threshold', () => {
  expect(validateTtlConfig(cfg)).toEqual(cfg);
  expect(() => validateTtlConfig({ ...cfg, contractId: 'invalid' })).toThrow('contract');
  expect(() => validateTtlConfig({ ...cfg, rpcUrl: 'ftp://host' })).toThrow('HTTPS');
  expect(() => validateTtlConfig({ ...cfg, threshold: -1 })).toThrow('threshold');
});
test('read-only lookup distinguishes missing and malformed responses from RPC failure', async () => {
  const key = instanceKey(id);
  const fake = { getLatestLedger: jest.fn(async () => ({ sequence: 100 })), getLedgerEntries: jest.fn(async () => ({ entries: [] as Array<{liveUntilLedgerSeq?: number}> })) };
  expect((await inspectEntries(fake, [key], 10))[0].state).toBe('not-found-or-archived');
  fake.getLedgerEntries.mockRejectedValueOnce(new Error('token=secret'));
  await expect(inspectEntries(fake, [key], 10)).rejects.toThrow('inspection failed');
  await expect(inspectEntries(fake, [], 10)).rejects.toThrow('At least one');
});
test('builds separate unsigned extension and restoration operations', () => {
  const acct = new Account(Keypair.random().publicKey(), '0');
  const keys = [instanceKey(id)];
  expect(buildTtlTransaction(acct, Networks.TESTNET, keys, 'extend', 1000).operations[0].type).toBe('extendFootprintTtl');
  expect(buildTtlTransaction(acct, Networks.TESTNET, keys, 'restore').operations[0].type).toBe('restoreFootprint');
  expect(() => buildTtlTransaction(acct, Networks.TESTNET, keys, 'extend', 0)).toThrow('extendTo');
});
test('preflight and submission fail closed without opt-in or matching payer', async () => {
  const signer = Keypair.random();
  const tx = buildTtlTransaction(new Account(signer.publicKey(), '0'), Networks.TESTNET, [instanceKey(id)], 'restore');
  const send = jest.fn();
  await expect(submitTtlTransaction({sendTransaction: send} as never, tx, signer, false)).rejects.toThrow('opt-in');
  expect(send).not.toHaveBeenCalled();
  await expect(submitTtlTransaction({sendTransaction: send} as never, tx, Keypair.random(), true)).rejects.toThrow('does not match');
  await expect(prepareTtlTransaction({prepareTransaction: async () => { throw new Error('secret'); }} as never, tx)).rejects.toThrow('preparation failed');
});
