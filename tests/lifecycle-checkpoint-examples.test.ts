import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
} from '@stellar/stellar-sdk';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { amount, asset } from '../src/utils/example-input';
import { loadCheckpoint, saveCheckpoint, scan, retryRead } from '../src/utils/reliable-scan';
import { eventFilter, decodeValue } from '../src/examples/254-contract-event-checkpointing';
import { validateChange } from '../src/examples/255-asset-trustline-lifecycle';
import { paymentOperation, Route } from '../src/examples/256-path-payment-preparation';

const issuer = Keypair.random().publicKey();
const destination = Keypair.random().publicKey();
const contract = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

describe('issues 405–408', () => {
  test('empty pages terminate without advancing an absent cursor', async () => {
    const save = jest.fn();
    const process = jest.fn();
    await scan({
      checkpoint: { version: 1, scope: 'empty' },
      fetch: async () => ({ records: [] }),
      identity: () => '',
      process,
      save,
      maxPages: 2,
    });
    expect(save).not.toHaveBeenCalled();
    expect(process).not.toHaveBeenCalled();
  });
  test('malformed payloads and stuck cursors fail closed', async () => {
    const save = jest.fn();
    const base = {
      checkpoint: { version: 1 as const, scope: 'bad', cursor: 'old' },
      identity: (s: string) => s,
      process: async () => undefined,
      save,
      maxPages: 2,
    };
    await expect(
      scan({ ...base, fetch: async () => ({ records: [''], cursor: 'next' }) }),
    ).rejects.toThrow('identifier');
    await expect(
      scan({ ...base, fetch: async () => ({ records: ['a'], cursor: 'old' }) }),
    ).rejects.toThrow('advance');
    expect(save).not.toHaveBeenCalled();
  });
  test('a save failure stops subsequent retrieval', async () => {
    const fetch = jest.fn().mockResolvedValue({ records: ['a'], cursor: 'new' });
    await expect(
      scan({
        checkpoint: { version: 1, scope: 'save' },
        fetch,
        identity: (s: string) => s,
        process: async () => undefined,
        save: async () => {
          throw new Error('disk full');
        },
        maxPages: 2,
      }),
    ).rejects.toThrow('disk full');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  test('validates assets and exact seven-decimal amounts', () => {
    expect(asset(`USD:${issuer}`).getIssuer()).toBe(issuer);
    expect(asset('native').isNative()).toBe(true);
    for (const invalid of ['USD', 'USD:bad', `TOO_LONG_ASSET:${issuer}`])
      expect(() => asset(invalid)).toThrow();
    for (const invalid of ['0', '-1', 'NaN', '1e2', '0.00000001', '922337203686'])
      expect(() => amount(invalid)).toThrow();
    expect(amount('0.0000001')).toBe('0.0000001');
  });
  test('validates contract filters and safely decodes generic values', () => {
    expect(eventFilter(contract, 'transfer').topics).toHaveLength(1);
    expect(() => eventFilter(issuer)).toThrow();
    expect(() => eventFilter(contract, 'bad topic')).toThrow();
    expect(() => eventFilter(contract, undefined, 'diagnostic')).toThrow();
    expect(decodeValue(nativeToScVal(123n, { type: 'i128' }))).toBe('123');
    expect(decodeValue(nativeToScVal('transfer', { type: 'symbol' }))).toBe('transfer');
    expect(decodeValue(undefined)).toEqual({ undecodable: true });
    expect(decodeValue({})).toEqual({ undecodable: true });
  });
  test('trustline creation, updates and removal enforce balances and liabilities', () => {
    expect(validateChange('create', '20')).toBe('20');
    expect(() => validateChange('update', '20')).toThrow('No matching');
    expect(() => validateChange('remove', '', { balance: '1', limit: '20' })).toThrow('Resolve');
    expect(() =>
      validateChange('remove', '', { balance: '0', limit: '20', selling_liabilities: '1' }),
    ).toThrow('Resolve');
    expect(validateChange('remove', '', { balance: '0', limit: '20' })).toBe('0');
    expect(() => validateChange('update', '2', { balance: '3', limit: '20' })).toThrow('below');
    const op = Operation.changeTrust({
      asset: asset(`USD:${issuer}`),
      limit: validateChange('create', '20'),
    });
    const tx = new TransactionBuilder(new Account(destination, '1'), {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(op)
      .setTimeout(180)
      .build();
    expect(tx.operations[0]).toMatchObject({ type: 'changeTrust', limit: '20.0000000' });
    expect(tx.signatures).toHaveLength(0);
  });
  test('builds strict send and receive operations with separate execution bounds', () => {
    const target = asset(`USD:${issuer}`);
    const route: Route = {
      source_asset_type: 'native',
      source_amount: '10',
      destination_asset_type: 'credit_alphanum4',
      destination_asset_code: 'USD',
      destination_asset_issuer: issuer,
      destination_amount: '20',
      path: [],
    };
    for (const mode of ['send', 'receive']) {
      const op = paymentOperation(
        mode,
        destination,
        Asset.native(),
        target,
        mode === 'send' ? '10' : '20',
        mode === 'send' ? '19' : '11',
        route,
      );
      const tx = new TransactionBuilder(new Account(issuer, '1'), {
        fee: '100',
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(op)
        .setTimeout(180)
        .build();
      expect(tx.operations[0]).toMatchObject(
        mode === 'send'
          ? { type: 'pathPaymentStrictSend', destMin: '19.0000000' }
          : { type: 'pathPaymentStrictReceive', sendMax: '11.0000000' },
      );
    }
    expect(() =>
      paymentOperation('send', destination, Asset.native(), target, '10', '21', route),
    ).toThrow();
    expect(() =>
      paymentOperation('receive', destination, Asset.native(), target, '20', '9', route),
    ).toThrow();
    expect(() =>
      paymentOperation('send', destination, Asset.native(), target, '10', '19', {
        ...route,
        path: undefined,
      } as unknown as Route),
    ).toThrow('Malformed');
  });
  test('pagination deduplicates stable identifiers, including a short final page', async () => {
    const fetch = jest
      .fn()
      .mockResolvedValueOnce({ records: ['a', 'a', 'b'], cursor: '2' })
      .mockResolvedValueOnce({ records: ['b', 'c'], cursor: '3' })
      .mockResolvedValueOnce({ records: [] });
    const process = jest.fn();
    const save = jest.fn();
    await scan({
      checkpoint: { version: 1, scope: 'test' },
      fetch,
      identity: (s: string) => s,
      process,
      save,
      maxPages: 10,
    });
    expect(process.mock.calls.flat()).toEqual(['a', 'b', 'c']);
    expect(fetch.mock.calls).toEqual([[undefined], ['2'], ['3']]);
    expect(save).toHaveBeenCalledTimes(2);
  });
  test('processing and retrieval failures preserve checkpoint', async () => {
    const checkpoint = { version: 1 as const, scope: 'test', cursor: 'old' };
    const save = jest.fn();
    await expect(
      scan({
        checkpoint,
        fetch: async () => ({ records: ['a', 'b'], cursor: 'new' }),
        identity: (s) => s,
        process: async (s) => {
          if (s === 'b') throw new Error('processing');
        },
        save,
        maxPages: 1,
      }),
    ).rejects.toThrow('processing');
    expect(save).not.toHaveBeenCalled();
    expect(checkpoint.cursor).toBe('old');
    const read = jest
      .fn()
      .mockRejectedValueOnce({ response: { status: 429 } })
      .mockResolvedValue('recovered');
    expect(await retryRead(read, async () => undefined)).toBe('recovered');
    await expect(
      retryRead(async () => {
        throw new Error('invalid filters');
      }),
    ).rejects.toThrow('preserved');
  });
  test('checkpoint persistence, scope mismatch and resume with newer records', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stellar-checkpoint-'));
    const file = path.join(dir, 'checkpoint.json');
    try {
      expect(await loadCheckpoint(file, 'test')).toEqual({ version: 1, scope: 'test' });
      await saveCheckpoint(file, { version: 1, scope: 'test', cursor: '2' });
      const checkpoint = await loadCheckpoint(file, 'test');
      const fetch = jest
        .fn()
        .mockResolvedValueOnce({ records: ['new'], cursor: '3' })
        .mockResolvedValueOnce({ records: [] });
      await scan({
        checkpoint,
        fetch,
        identity: (s: string) => s,
        process: async () => undefined,
        save: (c) => saveCheckpoint(file, c),
        maxPages: 3,
      });
      expect(fetch.mock.calls[0]).toEqual(['2']);
      expect((await loadCheckpoint(file, 'test')).cursor).toBe('3');
      await expect(loadCheckpoint(file, 'other')).rejects.toThrow('Invalid checkpoint');
      await fs.writeFile(file, '{broken');
      await expect(loadCheckpoint(file, 'test')).rejects.toThrow('Invalid checkpoint');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
