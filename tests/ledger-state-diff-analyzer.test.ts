import { captureCurrent, changedFields, compareSnapshots, normalized } from '../examples/ledger-state-diff-analyzer/analyzer';
import type { Snapshot } from '../examples/ledger-state-diff-analyzer/types';
const a = (entries: Snapshot['entries'], ledger = 100): Snapshot => ({ ledger, observedAt: '2026-11-01T00:00:00Z', source: 'fixture', entries });
const present = (id: string, value: unknown, type = 'account') => ({ id, value, status: 'present' as const, type });
const absent = (id: string) => ({ id, status: 'absent' as const, type: 'unknown' });

test('normalization ignores object key order and whitespace-only serialization changes', () => {
  expect(normalized({ b: 2, a: { y: 1, x: 2 } })).toEqual(normalized({ a: { x: 2, y: 1 }, b: 2 }));
  expect(changedFields({ b: 2, a: 1 }, { a: 1, b: 2 })).toHaveLength(0);
});

test('reports exact modified nested paths and preserves entry types', () => {
  const report = compareSnapshots(a([present('acct', { balance: '1.0000000', flags: { required: false } }),
    present('contract-data', { value: 5 }, 'contractData')]),
  a([present('acct', { flags: { required: true }, balance: '1.0000000' }),
    present('contract-data', { value: 5 }, 'contractData')], 120));
  expect(report.counts).toMatchObject({ modified: 1, unchanged: 1 });
  expect(report.entries.find(e => e.id === 'acct')?.fields).toEqual([{
    path: '$.value.flags.required', before: false, after: true,
  }]);
});

test('distinguishes observed addition and removal from unavailable historical data', () => {
  const before = a([absent('new'), present('old', { q: 1 }),
    { id: 'history', type: 'trustline', status: 'unavailable' }]);
  const after = a([present('new', { q: 2 }), absent('old'), present('history', { q: 1 })], 120);
  const report = compareSnapshots(before, after);
  expect(report.counts).toMatchObject({ added: 1, removed: 1, inconclusive: 1 });
  expect(report.entries.find(e => e.id === 'history')?.status).toBe('inconclusive');
});

test('missing fields are field modifications, not deleted entries', () => {
  const report = compareSnapshots(a([present('offer', { price: 5, sponsor: 'G' }, 'offer')]),
    a([present('offer', { price: 5 }, 'offer')], 125));
  expect(report.entries[0].status).toBe('modified');
  expect(report.entries[0].fields[0].path).toBe('$.value.sponsor');
});

test('duplicate identifiers are reported and each ID compared only once', () => {
  const report = compareSnapshots(a([present('x', { n: 1 }), present('x', { n: 2 })]), a([present('x', { n: 1 })]));
  expect(report.entries).toHaveLength(1);
  expect(report.warnings.join(' ')).toMatch(/Duplicate/);
});

test('malformed snapshots are rejected and missing snapshot entries remain inconclusive', () => {
  const report = compareSnapshots(a([present('x', { n: 1 })]), a([]));
  expect(report.entries[0].status).toBe('inconclusive');
  expect(() => compareSnapshots(a([{ id: 'bad', type: 'account', status: 'oops' as 'present' }]), a([]))).toThrow(/Malformed/);
});

test('invalid ledger-key XDR is rejected before making an RPC request', async () => {
  const fetcher = jest.fn() as unknown as typeof fetch;
  await expect(captureCurrent({ rpcUrl: 'https://soroban-testnet.stellar.org', keys: ['wrong'], fetcher })).rejects.toThrow(/ledger-key/);
  expect(fetcher).not.toHaveBeenCalled();
});

test('snapshot report serializes to JSON', () => {
  const report = compareSnapshots(a([present('code', { xdr: 'AA==' }, 'contractCode')]),
    a([present('code', { xdr: 'BB==' }, 'contractCode')], 200));
  expect(JSON.parse(JSON.stringify(report)).entries[0].status).toBe('modified');
});
