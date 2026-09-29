import fs from 'fs';
import os from 'os';
import path from 'path';
import { nativeToScVal } from '@stellar/stellar-sdk';
import { buildStateSummary } from '../src/examples/217-state-summary';
import { queryStateKey } from '../src/examples/218-state-key';
import { searchStateValues } from '../src/examples/219-state-search';
import { analyzeStateTypes } from '../src/examples/220-state-types';
import { parseStateSnapshot } from '../src/utils/soroban-state-snapshot';

function tmpSnapshot(data: unknown): string {
  const file = path.join(
    os.tmpdir(),
    `state-inspection-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  fs.writeFileSync(file, JSON.stringify(data), 'utf8');
  return file;
}

function scval(value: unknown): string {
  return nativeToScVal(value as any).toXDR('base64');
}

describe('ISSUE-217 state-summary', () => {
  it('calculates entry, durability, ScVal and TTL statistics deterministically', () => {
    const file = tmpSnapshot({
      ledger: '9007199254740993000',
      entries: [
        {
          ledgerKey: 'B',
          contractId: 'CB',
          durability: 'temporary',
          lastModifiedLedgerSeq: '9007199254740992990',
          liveUntilLedgerSeq: '9007199254740993050',
          valueXdr: scval('hello'),
        },
        {
          ledgerKey: 'A',
          contractId: 'CA',
          durability: 'persistent',
          lastModifiedLedgerSeq: '9007199254740992980',
          liveUntilLedgerSeq: '9007199254741993000',
          valueXdr: scval(true),
        },
      ],
    });

    const report = buildStateSummary(file, {
      ttlWarningThreshold: 100n,
      longTtlThreshold: 500_000n,
    });

    expect(report.totalEntries).toBe(2);
    expect(report.entriesWithTtl).toBe(2);
    expect(report.countsByDurability).toEqual({ persistent: 1, temporary: 1 });
    expect(report.ttl.approachingExpiration).toHaveLength(1);
    expect(report.ttl.unusuallyLong).toHaveLength(1);
    expect(report.referenceLedger).toBe('9007199254740993000');
    expect(report.entries.map((entry) => entry.ledgerKey)).toEqual(['A', 'B']);
    fs.unlinkSync(file);
  });

  it('supports contract and durability filtering', () => {
    const file = tmpSnapshot({
      entries: [
        { ledgerKey: 'A', contractId: 'C1', durability: 'persistent', valueXdr: scval(1) },
        { ledgerKey: 'B', contractId: 'C2', durability: 'temporary', valueXdr: scval(2) },
      ],
    });
    const report = buildStateSummary(file, { contractId: 'C2', durability: 'temporary' });
    expect(report.totalEntries).toBe(1);
    expect(report.entries[0].ledgerKey).toBe('B');
    fs.unlinkSync(file);
  });
});

describe('ISSUE-218 state-key', () => {
  it('finds encoded/stable ledger keys and reports TTL', () => {
    const file = tmpSnapshot({
      ledger: 100,
      entries: [
        {
          ledgerKey: 'ENCODED-KEY',
          contractId: 'C1',
          durability: 'persistent',
          keyDecoded: 'counter',
          valueDecoded: 7,
          liveUntilLedgerSeq: 150,
        },
      ],
    });
    const report = queryStateKey(file, 'ENCODED-KEY', { raw: true });
    expect(report.found).toBe(true);
    expect(report.matchCount).toBe(1);
    expect(report.matches[0].remainingTtl).toBe('50');
    expect(report.matches[0].raw?.ledgerKey).toBe('ENCODED-KEY');
    fs.unlinkSync(file);
  });

  it('finds decoded keys and handles missing and duplicate keys', () => {
    const file = tmpSnapshot({
      entries: [
        { ledgerKey: 'K1', contractId: 'C1', durability: 'persistent', keyDecoded: 'owner' },
        { ledgerKey: 'K2', contractId: 'C2', durability: 'persistent', keyDecoded: 'owner' },
      ],
    });
    expect(queryStateKey(file, 'owner').ambiguous).toBe(true);
    expect(queryStateKey(file, 'missing').found).toBe(false);
    expect(queryStateKey(file, 'owner', { contractId: 'C1' }).matchCount).toBe(1);
    fs.unlinkSync(file);
  });
});

describe('ISSUE-219 state-search', () => {
  it('searches exact values and case-insensitive strings', () => {
    const file = tmpSnapshot({
      entries: [
        { ledgerKey: 'A', contractId: 'C1', durability: 'persistent', valueXdr: scval('Alice') },
        { ledgerKey: 'B', contractId: 'C1', durability: 'persistent', valueXdr: scval(true) },
      ],
    });
    expect(searchStateValues(file, 'alice', { ignoreCase: true }).matchCount).toBe(1);
    expect(searchStateValues(file, 'true').matchCount).toBe(1);
    expect(searchStateValues(file, 'missing').matchCount).toBe(0);
    fs.unlinkSync(file);
  });

  it('recursively searches nested vectors and reports paths', () => {
    const nested = nativeToScVal(['outer', ['needle', 4]] as any).toXDR('base64');
    const file = tmpSnapshot({
      entries: [
        { ledgerKey: 'NESTED', contractId: 'C1', durability: 'temporary', valueXdr: nested },
      ],
    });
    const report = searchStateValues(file, 'needle');
    expect(report.matchCount).toBe(1);
    expect(report.matches[0].path).toContain('[1]');
    fs.unlinkSync(file);
  });

  it('reports undecodable values without terminating', () => {
    const file = tmpSnapshot({
      entries: [
        { ledgerKey: 'BAD', durability: 'persistent', valueXdr: 'not-xdr' },
        { ledgerKey: 'GOOD', durability: 'persistent', valueXdr: scval('ok') },
      ],
    });
    const report = searchStateValues(file, 'ok');
    expect(report.matchCount).toBe(1);
    expect(report.undecodable.some((entry) => entry.ledgerKey === 'BAD')).toBe(true);
    fs.unlinkSync(file);
  });
});

describe('ISSUE-220 state-types', () => {
  it('counts top-level and nested ScVal types and nesting depth', () => {
    const file = tmpSnapshot({
      entries: [
        { ledgerKey: 'A', durability: 'persistent', valueXdr: scval('hello') },
        { ledgerKey: 'B', durability: 'temporary', valueXdr: scval([true, ['nested']]) },
      ],
    });
    const report = analyzeStateTypes(file);
    expect(report.totalEntries).toBe(2);
    expect(report.topLevelTotal).toBe(2);
    expect(report.nestedTotal).toBeGreaterThan(0);
    expect(report.maximumNestingDepth).toBeGreaterThanOrEqual(2);
    expect(report.topLevelTypes.reduce((sum, row) => sum + row.count, 0)).toBe(2);
    fs.unlinkSync(file);
  });

  it('honors recursion depth and filters', () => {
    const file = tmpSnapshot({
      entries: [
        { ledgerKey: 'A', contractId: 'C1', durability: 'persistent', valueXdr: scval([[['x']]]) },
        { ledgerKey: 'B', contractId: 'C2', durability: 'temporary', valueXdr: scval('skip') },
      ],
    });
    const report = analyzeStateTypes(file, {
      contractId: 'C1',
      durability: 'persistent',
      maxDepth: 1,
    });
    expect(report.totalEntries).toBe(1);
    expect(report.maximumNestingDepth).toBe(1);
    fs.unlinkSync(file);
  });

  it('reports malformed and empty snapshots cleanly', () => {
    expect(parseStateSnapshot([], 'empty').entries).toEqual([]);
    expect(() => parseStateSnapshot({ nope: [] }, 'bad')).toThrow(/entries/);
  });
});
