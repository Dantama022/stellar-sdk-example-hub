import { Keypair } from '@stellar/stellar-sdk';
import { buildAudit } from '../examples/account-data/data-entry-audit';
import { decodeBase64, normalizeEffect, retrieveCurrentData, retrieveDataHistory, DataChange } from '../examples/account-data/data-entry-history';
import { HttpClient } from '../examples/_analysis/core';

const account = Keypair.random().publicKey();
const base = { account, key: 'app', ledger: 10, transactionHash: 'a'.repeat(64), timestamp: '2026-01-01T00:00:00Z' };
const changes: DataChange[] = [
  { ...base, id: '1', type: 'create', valueBase64: 'b25l', valueUtf8: 'one' },
  { ...base, id: '2', type: 'update', ledger: 11, valueBase64: 'dHdv', valueUtf8: 'two' },
  { ...base, id: '3', type: 'remove', ledger: 12, valueBase64: null, valueUtf8: null },
];

describe('account data audit #573', () => {
  it('reconstructs chronologically from a known empty snapshot', () => {
    const report = buildAudit({ account, network: 'testnet', start: 10, end: 12,
      initialState: {}, history: { complete: true, changes: [...changes].reverse(), warnings: [] },
      current: { accountId: account, entries: {}, observedAt: '2026-01-01T00:00:00Z' }, });
    expect(report.counts).toEqual({ examined: 3, created: 1, updated: 1, removed: 1 });
    expect(report.timeline[1].previousValueBase64).toBe('b25l');
    expect(report.timeline[2].previousValueBase64).toBe('dHdv');
    expect(report.reconstructed).toEqual({});
    expect(report.currentComparison).toBe('matches');
    expect(report.complete).toBe(true);
  });
  it('filters without altering reconstructed state and handles duplicate records', () => {
    const report = buildAudit({ account, network: 'testnet', start: 10, end: 12,
      history: { complete: false, changes: [changes[0], changes[0], changes[1], changes[2]], warnings: ['history pruned'] },
      filter: { type: 'update', key: 'app', transactionHash: 'a'.repeat(64), start: 11, end: 12 } });
    expect(report.timeline).toHaveLength(1);
    expect(report.counts.updated).toBe(1);
    expect(report.complete).toBe(false);
    expect(report.currentComparison).toBe('inconclusive');
  });
  it('decodes binary safely and rejects malformed base64', () => {
    expect(decodeBase64('AAE=').utf8).toBe('\0\u0001');
    expect(decodeBase64('/w==').utf8).toBeNull();
    expect(() => decodeBase64('%%%')).toThrow();
    expect(normalizeEffect({ id: '100', account, type: 'data_removed', name: 'app' }, 22)?.type).toBe('remove');
    expect(normalizeEffect({ id: '100', account, type: 'account_created', name: 'app' })).toBeNull();
  });
  it('retrieves current data and historical effects with operation and transaction metadata', async () => {
    const effect = { id: '100', account, name: 'app', type: 'data_created', value: 'b25l', created_at: '2026-01-01T00:00:00Z', _links: { operation: { href: 'https://mock/operations/1' } } };
    const get = jest.fn(async (url: string) => {
      if (url.endsWith(`/accounts/${account}`)) return { data: { app: 'b25l' } };
      if (url.includes('/effects')) return { _embedded: { records: [effect] } };
      if (url.endsWith('/operations/1')) return { transaction_hash: 'b'.repeat(64) };
      if (url.endsWith('/transactions/' + 'b'.repeat(64))) return { ledger: 11, created_at: effect.created_at };
      throw new Error('unknown URL');
    });
    const client = { get } as HttpClient;
    const current = await retrieveCurrentData('testnet', account, client);
    const history = await retrieveDataHistory({ network: 'testnet', account, start: 10, end: 12 }, client);
    expect(current.entries.app.utf8).toBe('one');
    expect(history.changes[0]).toMatchObject({ ledger: 11, type: 'create', transactionHash: 'b'.repeat(64) });
    expect(history.complete).toBe(false); // Historical completeness is never inferred from a Horizon page.
  });
  it('reports missing metadata, missing accounts and network failures explicitly', async () => {
    const effect = { id: '2', account, name: 'app', type: 'data_updated', value: 'dHdv' };
    const history = await retrieveDataHistory({ network: 'testnet', account, start: 10, end: 11 },
      { get: async <T>() => ({ _embedded: { records: [effect] } } as T) });
    expect(history.changes).toHaveLength(0);
    expect(history.warnings.join(' ')).toMatch(/ledger sequence unavailable/);
    await expect(retrieveCurrentData('testnet', account, { get: async () => { throw new Error('404'); } })).rejects.toThrow('404');
  });
});
