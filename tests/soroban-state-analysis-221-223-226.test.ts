import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { nativeToScVal } from '@stellar/stellar-sdk';
import {
  analyzeStructure,
  inferSchema,
  normalizeSnapshot,
} from '../src/utils/soroban-state-analysis';
import { buildStructureReport } from '../src/examples/221-state-structure';
import { buildSchemaReport } from '../src/examples/222-state-schema';
import { buildConsistencyReport } from '../src/examples/223-state-check';
import { mergeSnapshots } from '../src/examples/226-state-merge';

function xdr(value: unknown): string {
  return nativeToScVal(value as never).toXDR('base64');
}
function entry(key: string, value: unknown, overrides: Record<string, unknown> = {}) {
  return {
    ledgerKey: key,
    contractId: 'C' + 'A'.repeat(55),
    durability: 'persistent',
    lastModifiedLedgerSeq: '100',
    liveUntilLedgerSeq: '200',
    valueXdr: xdr(value),
    ...overrides,
  };
}
function temp(raw: unknown): string {
  const file = path.join(os.tmpdir(), `state-${Date.now()}-${Math.random()}.json`);
  fs.writeFileSync(file, JSON.stringify(raw), 'utf8');
  return file;
}

describe('ISSUE-221 state structure', () => {
  test('scalar/vector/map traversal', () => {
    expect(analyzeStructure(1).scalar).toBe(true);
    const a = analyzeStructure([[1, 2], []]);
    expect(a.vectorSizes).toEqual([2, 2, 0]);
    expect(a.emptyVectors).toBe(1);
    expect(a.depth).toBe(2);
  });
  test('deterministic report and thresholds', () => {
    const file = temp({ entries: [entry('B', [1, 2]), entry('A', { x: [1], y: {} })] });
    const r = buildStructureReport(file, { collectionThreshold: 2, depthThreshold: 1 });
    expect(r.decodedEntries).toBe(2);
    expect(r.entries.map((x) => x.ledgerKey)).toEqual(['A', 'B']);
    expect(r.largeCollections.length).toBeGreaterThan(0);
    fs.unlinkSync(file);
  });
});

describe('ISSUE-222 state schema', () => {
  test('optional fields and conflicts', () => {
    const s = inferSchema([{ a: 1, b: true }, { a: 'x' }]);
    expect(s.fields?.b.optional).toBe(true);
    expect(s.fields?.a.conflicts).toEqual(['integer', 'string']);
  });
  test('marks output inferred', () => {
    const file = temp({ entries: [entry('A', { a: 1 }), entry('B', { a: 2 })] });
    const r = buildSchemaReport(file);
    expect(r.authoritative).toBe(false);
    expect(r.basis).toMatch(/observed/i);
    fs.unlinkSync(file);
  });
});

describe('ISSUE-223 state check', () => {
  test('valid snapshot has no structural or ttl errors', () => {
    const file = temp({ ledger: '200', entries: [entry('A', 1)] });
    const r = buildConsistencyReport(file);
    expect(r.counts['structural-error']).toBe(0);
    expect(r.counts['ttl-inconsistency']).toBe(0);
    fs.unlinkSync(file);
  });
  test('detects duplicate and ttl inconsistency', () => {
    const file = temp({
      ledger: '200',
      entries: [
        entry('A', 1, { lastModifiedLedgerSeq: '150', liveUntilLedgerSeq: '120' }),
        entry('A', 2),
      ],
    });
    const r = buildConsistencyReport(file);
    expect(r.counts['conflicting-observation']).toBeGreaterThan(0);
    expect(r.counts['ttl-inconsistency']).toBeGreaterThan(0);
    fs.unlinkSync(file);
  });
});

describe('ISSUE-226 state merge', () => {
  test('deduplicates identical entries', () => {
    const a = normalizeSnapshot({ ledger: '100', entries: [entry('A', 1)] }),
      b = normalizeSnapshot({ ledger: '101', entries: [entry('A', 1)] });
    const r = mergeSnapshots([a, b], { conflict: 'error' });
    expect(r.report.deduplicatedEntries).toBe(1);
    expect(r.snapshot.entries).toHaveLength(1);
  });
  test('error strategy rejects conflict', () => {
    const a = normalizeSnapshot({ entries: [entry('A', 1)] }),
      b = normalizeSnapshot({ entries: [entry('A', 2)] });
    expect(() => mergeSnapshots([a, b], { conflict: 'error' })).toThrow(/conflict/i);
  });
  test('first/latest strategies deterministic', () => {
    const a = normalizeSnapshot({ entries: [entry('A', 1, { lastModifiedLedgerSeq: '100' })] }),
      b = normalizeSnapshot({ entries: [entry('A', 2, { lastModifiedLedgerSeq: '200' })] });
    expect(
      mergeSnapshots([a, b], { conflict: 'first' }).snapshot.entries[0].lastModifiedLedgerSeq,
    ).toBe('100');
    expect(
      mergeSnapshots([a, b], { conflict: 'latest' }).snapshot.entries[0].lastModifiedLedgerSeq,
    ).toBe('200');
  });
  test('does not mutate inputs', () => {
    const a = normalizeSnapshot({ entries: [entry('A', 1)] }),
      b = normalizeSnapshot({ entries: [entry('B', 2)] });
    const before = JSON.stringify([a, b]);
    mergeSnapshots([a, b]);
    expect(JSON.stringify([a, b])).toBe(before);
  });
});
