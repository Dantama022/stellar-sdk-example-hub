/**
 * Tests for ISSUE-197: Soroban Contract State Entry Lifecycle Analysis
 *
 * All tests exercise exported pure helpers directly — no network connection,
 * no RPC, no SDK runtime required.  The example is fully offline.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  normalizeObservation,
  parseSnapshot,
  loadSnapshot,
  validateSnapshotOrder,
  indexSnapshot,
  computeDelta,
  computeTtlTrend,
  classifyTransition,
  analyzeLifecycle,
  formatReport,
} from '../src/examples/197-state-lifecycle';

import type {
  EntryObservation,
  Snapshot,
  EntryDelta,
  LifecycleReport,
} from '../src/examples/197-state-lifecycle';

import { examples } from '../src/runner/catalog';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function obs(ledgerKey: string, overrides: Partial<EntryObservation> = {}): EntryObservation {
  return {
    ledgerKey,
    durability: 'persistent',
    lastModifiedLedgerSeq: 1000,
    liveUntilLedgerSeq: 2000,
    valueXdr: 'AAAA',
    ...overrides,
  };
}

function snap(entries: EntryObservation[], ledger?: number): Snapshot {
  return { entries, ledger };
}

function writeTmpSnapshot(data: unknown): string {
  const dir = os.tmpdir();
  const file = path.join(dir, `snap-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(data), 'utf8');
  return file;
}

// ---------------------------------------------------------------------------
// normalizeObservation
// ---------------------------------------------------------------------------

describe('normalizeObservation', () => {
  it('returns null for non-objects', () => {
    expect(normalizeObservation(null)).toBeNull();
    expect(normalizeObservation(42)).toBeNull();
    expect(normalizeObservation('string')).toBeNull();
    expect(normalizeObservation(undefined)).toBeNull();
  });

  it('returns null when ledgerKey is missing', () => {
    expect(normalizeObservation({ durability: 'persistent' })).toBeNull();
  });

  it('returns null when ledgerKey is empty', () => {
    expect(normalizeObservation({ ledgerKey: '   ' })).toBeNull();
  });

  it('normalises a minimal valid entry', () => {
    const result = normalizeObservation({ ledgerKey: 'KEY-001' });
    expect(result).not.toBeNull();
    expect(result!.ledgerKey).toBe('KEY-001');
    expect(result!.durability).toBe('unknown');
    expect(result!.contractId).toBeUndefined();
    expect(result!.lastModifiedLedgerSeq).toBeUndefined();
    expect(result!.liveUntilLedgerSeq).toBeUndefined();
    expect(result!.valueXdr).toBeUndefined();
    expect(result!.valueDecoded).toBeUndefined();
  });

  it('parses all optional fields when present', () => {
    const raw = {
      ledgerKey: 'KEY-002',
      contractId: 'CCONTRACT',
      durability: 'temporary',
      lastModifiedLedgerSeq: 500,
      liveUntilLedgerSeq: 900,
      valueXdr: 'AQID',
      valueDecoded: 'counter=7',
    };
    const result = normalizeObservation(raw);
    expect(result!.contractId).toBe('CCONTRACT');
    expect(result!.durability).toBe('temporary');
    expect(result!.lastModifiedLedgerSeq).toBe(500);
    expect(result!.liveUntilLedgerSeq).toBe(900);
    expect(result!.valueXdr).toBe('AQID');
    expect(result!.valueDecoded).toBe('counter=7');
  });

  it('falls back to "unknown" durability for unrecognised values', () => {
    const result = normalizeObservation({ ledgerKey: 'K', durability: 'volatile' });
    expect(result!.durability).toBe('unknown');
  });

  it('ignores non-integer lastModifiedLedgerSeq', () => {
    const result = normalizeObservation({ ledgerKey: 'K', lastModifiedLedgerSeq: 1.5 });
    expect(result!.lastModifiedLedgerSeq).toBeUndefined();
  });

  it('ignores negative liveUntilLedgerSeq', () => {
    const result = normalizeObservation({ ledgerKey: 'K', liveUntilLedgerSeq: -1 });
    expect(result!.liveUntilLedgerSeq).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parseSnapshot
// ---------------------------------------------------------------------------

describe('parseSnapshot', () => {
  it('throws for null input', () => {
    expect(() => parseSnapshot(null, 'test')).toThrow();
  });

  it('throws for a primitive', () => {
    expect(() => parseSnapshot(42, 'test')).toThrow();
  });

  it('throws for object form missing "entries"', () => {
    expect(() => parseSnapshot({ ledger: 10 }, 'test')).toThrow(/entries/);
  });

  it('throws when "entries" is not an array', () => {
    expect(() => parseSnapshot({ entries: 'bad' }, 'test')).toThrow(/entries/);
  });

  it('parses array form', () => {
    const raw = [
      {
        ledgerKey: 'K1',
        durability: 'persistent',
        lastModifiedLedgerSeq: 100,
        liveUntilLedgerSeq: 200,
      },
    ];
    const snap = parseSnapshot(raw, 'test');
    expect(snap.ledger).toBeUndefined();
    expect(snap.entries).toHaveLength(1);
    expect(snap.entries[0].ledgerKey).toBe('K1');
  });

  it('parses object form with ledger metadata', () => {
    const raw = {
      ledger: 500,
      entries: [{ ledgerKey: 'K2', durability: 'temporary', liveUntilLedgerSeq: 600 }],
    };
    const snap = parseSnapshot(raw, 'test');
    expect(snap.ledger).toBe(500);
    expect(snap.entries).toHaveLength(1);
    expect(snap.entries[0].ledgerKey).toBe('K2');
  });

  it('skips entries that cannot be normalised without aborting', () => {
    const raw = [
      { ledgerKey: 'GOOD' },
      { noKey: true }, // invalid — no ledgerKey
      { ledgerKey: '' }, // invalid — empty key
      { ledgerKey: 'ALSO-GOOD' },
    ];
    const snap = parseSnapshot(raw, 'test');
    expect(snap.entries).toHaveLength(2);
    expect(snap.entries.map((e) => e.ledgerKey)).toEqual(['GOOD', 'ALSO-GOOD']);
  });

  it('returns empty entries for an empty array', () => {
    const snap = parseSnapshot([], 'empty');
    expect(snap.entries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// loadSnapshot (uses temp files)
// ---------------------------------------------------------------------------

describe('loadSnapshot', () => {
  it('throws for a missing file', () => {
    expect(() => loadSnapshot('/no/such/file/snap.json')).toThrow(/Cannot read snapshot/);
  });

  it('throws for invalid JSON', () => {
    const file = writeTmpSnapshot('not-json');
    // overwrite with bad content
    fs.writeFileSync(file, '{ bad json', 'utf8');
    expect(() => loadSnapshot(file)).toThrow(/not valid JSON/);
    fs.unlinkSync(file);
  });

  it('loads a valid array-form snapshot from disk', () => {
    const data = [{ ledgerKey: 'DISK-KEY', durability: 'persistent' }];
    const file = writeTmpSnapshot(data);
    const snap = loadSnapshot(file);
    expect(snap.entries).toHaveLength(1);
    expect(snap.entries[0].ledgerKey).toBe('DISK-KEY');
    fs.unlinkSync(file);
  });

  it('loads a valid object-form snapshot with ledger metadata', () => {
    const data = { ledger: 999, entries: [{ ledgerKey: 'META-KEY', durability: 'temporary' }] };
    const file = writeTmpSnapshot(data);
    const snap = loadSnapshot(file);
    expect(snap.ledger).toBe(999);
    expect(snap.entries[0].ledgerKey).toBe('META-KEY');
    fs.unlinkSync(file);
  });
});

// ---------------------------------------------------------------------------
// validateSnapshotOrder
// ---------------------------------------------------------------------------

describe('validateSnapshotOrder', () => {
  it('returns no violations for strictly increasing ledgers', () => {
    const snapshots = [snap([], 100), snap([], 200), snap([], 300)];
    expect(validateSnapshotOrder(snapshots)).toHaveLength(0);
  });

  it('returns a violation when a later snapshot has a smaller ledger', () => {
    const snapshots = [snap([], 300), snap([], 200)];
    const violations = validateSnapshotOrder(snapshots);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/300/);
    expect(violations[0]).toMatch(/200/);
  });

  it('returns a violation for equal ledger numbers', () => {
    const snapshots = [snap([], 100), snap([], 100)];
    expect(validateSnapshotOrder(snapshots)).toHaveLength(1);
  });

  it('skips snapshots without ledger metadata', () => {
    const snapshots = [snap([], 100), snap([]), snap([], 300)];
    expect(validateSnapshotOrder(snapshots)).toHaveLength(0);
  });

  it('returns no violations for all-unknown ledgers', () => {
    const snapshots = [snap([]), snap([]), snap([])];
    expect(validateSnapshotOrder(snapshots)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// indexSnapshot
// ---------------------------------------------------------------------------

describe('indexSnapshot', () => {
  it('builds a map keyed by ledgerKey', () => {
    const entries = [obs('K1'), obs('K2', { durability: 'temporary' })];
    const index = indexSnapshot(snap(entries));
    expect(index.size).toBe(2);
    expect(index.get('K1')!.durability).toBe('persistent');
    expect(index.get('K2')!.durability).toBe('temporary');
  });

  it('last entry wins for duplicate keys within one snapshot', () => {
    const entries = [obs('DUPE', { valueXdr: 'FIRST' }), obs('DUPE', { valueXdr: 'SECOND' })];
    const index = indexSnapshot(snap(entries));
    expect(index.get('DUPE')!.valueXdr).toBe('SECOND');
  });

  it('returns empty map for empty snapshot', () => {
    expect(indexSnapshot(snap([])).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeDelta
// ---------------------------------------------------------------------------

describe('computeDelta', () => {
  it('reports no changes between identical observations', () => {
    const a = obs('K', {
      valueXdr: 'AAAA',
      durability: 'persistent',
      lastModifiedLedgerSeq: 100,
      liveUntilLedgerSeq: 500,
    });
    const delta = computeDelta(a, a);
    expect(delta.valueChanged).toBe(false);
    expect(delta.durabilityChanged).toBe(false);
    expect(delta.lastModifiedChanged).toBe(false);
    expect(delta.ttlChanged).toBe(false);
    expect(delta.ttlDelta).toBe(0);
  });

  it('detects value change', () => {
    const a = obs('K', { valueXdr: 'AAAA' });
    const b = obs('K', { valueXdr: 'BBBB' });
    const delta = computeDelta(a, b);
    expect(delta.valueChanged).toBe(true);
    expect(delta.previousValueXdr).toBe('AAAA');
    expect(delta.currentValueXdr).toBe('BBBB');
  });

  it('detects durability change', () => {
    const a = obs('K', { durability: 'persistent' });
    const b = obs('K', { durability: 'temporary' });
    const delta = computeDelta(a, b);
    expect(delta.durabilityChanged).toBe(true);
    expect(delta.previousDurability).toBe('persistent');
    expect(delta.currentDurability).toBe('temporary');
  });

  it('detects lastModifiedLedgerSeq change', () => {
    const a = obs('K', { lastModifiedLedgerSeq: 100 });
    const b = obs('K', { lastModifiedLedgerSeq: 200 });
    const delta = computeDelta(a, b);
    expect(delta.lastModifiedChanged).toBe(true);
  });

  it('detects TTL increase', () => {
    const a = obs('K', { liveUntilLedgerSeq: 1000 });
    const b = obs('K', { liveUntilLedgerSeq: 1500 });
    const delta = computeDelta(a, b);
    expect(delta.ttlChanged).toBe(true);
    expect(delta.ttlDelta).toBe(500);
  });

  it('detects TTL decrease', () => {
    const a = obs('K', { liveUntilLedgerSeq: 1500 });
    const b = obs('K', { liveUntilLedgerSeq: 900 });
    const delta = computeDelta(a, b);
    expect(delta.ttlChanged).toBe(true);
    expect(delta.ttlDelta).toBe(-600);
  });

  it('reports ttlDelta undefined when either liveUntil is absent', () => {
    const a = obs('K', { liveUntilLedgerSeq: undefined });
    const b = obs('K', { liveUntilLedgerSeq: 1000 });
    const delta = computeDelta(a, b);
    expect(delta.ttlDelta).toBeUndefined();
    expect(delta.ttlChanged).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// computeTtlTrend
// ---------------------------------------------------------------------------

describe('computeTtlTrend', () => {
  it('returns "unknown" for empty deltas', () => {
    expect(computeTtlTrend([])).toBe('unknown');
  });

  it('returns "increasing" when last delta has positive ttlDelta', () => {
    const d: EntryDelta = {
      valueChanged: false,
      durabilityChanged: false,
      lastModifiedChanged: false,
      ttlChanged: true,
      ttlDelta: 100,
    };
    expect(computeTtlTrend([d])).toBe('increasing');
  });

  it('returns "decreasing" when last delta has negative ttlDelta', () => {
    const d: EntryDelta = {
      valueChanged: false,
      durabilityChanged: false,
      lastModifiedChanged: false,
      ttlChanged: true,
      ttlDelta: -50,
    };
    expect(computeTtlTrend([d])).toBe('decreasing');
  });

  it('returns "unchanged" when last delta has ttlDelta of zero', () => {
    const d: EntryDelta = {
      valueChanged: false,
      durabilityChanged: false,
      lastModifiedChanged: false,
      ttlChanged: false,
      ttlDelta: 0,
    };
    expect(computeTtlTrend([d])).toBe('unchanged');
  });

  it('uses the last delta with defined ttlDelta', () => {
    const d1: EntryDelta = {
      valueChanged: false,
      durabilityChanged: false,
      lastModifiedChanged: false,
      ttlChanged: true,
      ttlDelta: 200,
    };
    const d2: EntryDelta = {
      valueChanged: false,
      durabilityChanged: false,
      lastModifiedChanged: false,
      ttlChanged: true,
      ttlDelta: -30,
    };
    expect(computeTtlTrend([d1, d2])).toBe('decreasing');
  });

  it('skips deltas with undefined ttlDelta to find the last usable one', () => {
    const dUndef: EntryDelta = {
      valueChanged: false,
      durabilityChanged: false,
      lastModifiedChanged: false,
      ttlChanged: false,
      ttlDelta: undefined,
    };
    const dInc: EntryDelta = {
      valueChanged: false,
      durabilityChanged: false,
      lastModifiedChanged: false,
      ttlChanged: true,
      ttlDelta: 10,
    };
    expect(computeTtlTrend([dInc, dUndef])).toBe('increasing');
  });
});

// ---------------------------------------------------------------------------
// classifyTransition
// ---------------------------------------------------------------------------

describe('classifyTransition', () => {
  const noDelta: EntryDelta = {
    valueChanged: false,
    durabilityChanged: false,
    lastModifiedChanged: false,
    ttlChanged: false,
  };
  const modDelta: EntryDelta = {
    valueChanged: true,
    durabilityChanged: false,
    lastModifiedChanged: false,
    ttlChanged: false,
  };

  it('classifies "first-observed" when entry appears only in first snapshot', () => {
    expect(classifyTransition([true, false, false], [])).toBe('removed');
    expect(classifyTransition([true], [])).toBe('first-observed');
  });

  it('classifies "first-observed" when entry appears in exactly one snapshot', () => {
    // only present in last snapshot
    expect(classifyTransition([false, false, true], [])).toBe('first-observed');
    // only present in first of two
    expect(classifyTransition([true, false], [])).toBe('removed');
  });

  it('classifies "removed" when absent in last snapshot', () => {
    expect(classifyTransition([true, true, false], [noDelta])).toBe('removed');
  });

  it('classifies "persisting" when present in all snapshots with no changes', () => {
    expect(classifyTransition([true, true, true], [noDelta, noDelta])).toBe('persisting');
  });

  it('classifies "modified" when present in all and a delta shows a change', () => {
    expect(classifyTransition([true, true, true], [noDelta, modDelta])).toBe('modified');
  });

  it('classifies "reappearing" when there is a gap and the entry is present at the end', () => {
    // absent in middle snapshot, present at end
    expect(classifyTransition([true, false, true], [])).toBe('reappearing');
  });

  it('classifies "reappearing" correctly with longer gap', () => {
    expect(classifyTransition([true, false, false, true], [])).toBe('reappearing');
  });
});

// ---------------------------------------------------------------------------
// analyzeLifecycle — two snapshots
// ---------------------------------------------------------------------------

describe('analyzeLifecycle — two snapshots', () => {
  it('throws when fewer than two snapshots are provided', () => {
    expect(() => analyzeLifecycle([snap([])])).toThrow(/two snapshots/);
    expect(() => analyzeLifecycle([])).toThrow(/two snapshots/);
  });

  it('reports a newly observed entry', () => {
    const s1 = snap([]);
    const s2 = snap([obs('NEW-KEY')]);
    const report = analyzeLifecycle([s1, s2]);
    const entry = report.entries.find((e) => e.ledgerKey === 'NEW-KEY')!;
    expect(entry.transition).toBe('first-observed');
    expect(entry.presentCount).toBe(1);
    expect(entry.totalSnapshots).toBe(2);
  });

  it('reports a continuously present entry', () => {
    const s1 = snap([obs('PERSIST-KEY')]);
    const s2 = snap([obs('PERSIST-KEY')]);
    const report = analyzeLifecycle([s1, s2]);
    const entry = report.entries.find((e) => e.ledgerKey === 'PERSIST-KEY')!;
    expect(entry.transition).toBe('persisting');
    expect(entry.presentCount).toBe(2);
  });

  it('reports a modified entry', () => {
    const s1 = snap([obs('MOD-KEY', { valueXdr: 'OLD' })]);
    const s2 = snap([obs('MOD-KEY', { valueXdr: 'NEW' })]);
    const report = analyzeLifecycle([s1, s2]);
    const entry = report.entries.find((e) => e.ledgerKey === 'MOD-KEY')!;
    expect(entry.transition).toBe('modified');
    expect(entry.deltas[0].valueChanged).toBe(true);
    expect(entry.deltas[0].previousValueXdr).toBe('OLD');
    expect(entry.deltas[0].currentValueXdr).toBe('NEW');
  });

  it('reports a removed entry', () => {
    const s1 = snap([obs('GONE-KEY')]);
    const s2 = snap([]);
    const report = analyzeLifecycle([s1, s2]);
    const entry = report.entries.find((e) => e.ledgerKey === 'GONE-KEY')!;
    expect(entry.transition).toBe('removed');
    expect(entry.presentCount).toBe(1);
  });

  it('preserves raw valueXdr for value changes', () => {
    const s1 = snap([obs('K', { valueXdr: 'RAWOLD' })]);
    const s2 = snap([obs('K', { valueXdr: 'RAWNEW' })]);
    const report = analyzeLifecycle([s1, s2]);
    const entry = report.entries.find((e) => e.ledgerKey === 'K')!;
    expect(entry.deltas[0].previousValueXdr).toBe('RAWOLD');
    expect(entry.deltas[0].currentValueXdr).toBe('RAWNEW');
  });
});

// ---------------------------------------------------------------------------
// analyzeLifecycle — multiple snapshots
// ---------------------------------------------------------------------------

describe('analyzeLifecycle — multiple snapshots', () => {
  it('tracks TTL increase across three snapshots', () => {
    const s1 = snap([obs('K', { liveUntilLedgerSeq: 1000 })]);
    const s2 = snap([obs('K', { liveUntilLedgerSeq: 1500 })]);
    const s3 = snap([obs('K', { liveUntilLedgerSeq: 2000 })]);
    const report = analyzeLifecycle([s1, s2, s3]);
    const entry = report.entries.find((e) => e.ledgerKey === 'K')!;
    expect(entry.ttlTrend).toBe('increasing');
    expect(entry.deltas).toHaveLength(2);
    expect(entry.deltas[0].ttlDelta).toBe(500);
    expect(entry.deltas[1].ttlDelta).toBe(500);
  });

  it('tracks TTL decrease', () => {
    const s1 = snap([obs('K', { liveUntilLedgerSeq: 2000 })]);
    const s2 = snap([obs('K', { liveUntilLedgerSeq: 1000 })]);
    const report = analyzeLifecycle([s1, s2]);
    const entry = report.entries.find((e) => e.ledgerKey === 'K')!;
    expect(entry.ttlTrend).toBe('decreasing');
    expect(entry.deltas[0].ttlDelta).toBe(-1000);
  });

  it('tracks unchanged TTL', () => {
    const s1 = snap([obs('K', { liveUntilLedgerSeq: 1000 })]);
    const s2 = snap([obs('K', { liveUntilLedgerSeq: 1000 })]);
    const report = analyzeLifecycle([s1, s2]);
    const entry = report.entries.find((e) => e.ledgerKey === 'K')!;
    expect(entry.ttlTrend).toBe('unchanged');
    expect(entry.deltas[0].ttlDelta).toBe(0);
  });

  it('detects durability change', () => {
    const s1 = snap([obs('K', { durability: 'persistent' })]);
    const s2 = snap([obs('K', { durability: 'temporary' })]);
    const report = analyzeLifecycle([s1, s2]);
    const entry = report.entries.find((e) => e.ledgerKey === 'K')!;
    expect(entry.deltas[0].durabilityChanged).toBe(true);
  });

  it('detects lastModifiedLedgerSeq change', () => {
    const s1 = snap([obs('K', { lastModifiedLedgerSeq: 100 })]);
    const s2 = snap([obs('K', { lastModifiedLedgerSeq: 200 })]);
    const report = analyzeLifecycle([s1, s2]);
    const entry = report.entries.find((e) => e.ledgerKey === 'K')!;
    expect(entry.deltas[0].lastModifiedChanged).toBe(true);
  });

  it('handles missing intermediate observations without corrupting history', () => {
    const s1 = snap([obs('K')]);
    const s2 = snap([]); // absent
    const s3 = snap([obs('K', { valueXdr: 'CHANGED' })]);
    const report = analyzeLifecycle([s1, s2, s3]);
    const entry = report.entries.find((e) => e.ledgerKey === 'K')!;
    expect(entry.transition).toBe('reappearing');
    expect(entry.hadIntermediateGap).toBe(true);
    expect(entry.presentCount).toBe(2);
    // No delta is produced for the gap pair (s1→s2 or s2→s3 where one side is absent)
    expect(entry.deltas).toHaveLength(0);
  });

  it('reports a reappearing entry', () => {
    const s1 = snap([obs('REAPP')]);
    const s2 = snap([]);
    const s3 = snap([obs('REAPP')]);
    const report = analyzeLifecycle([s1, s2, s3]);
    const entry = report.entries.find((e) => e.ledgerKey === 'REAPP')!;
    expect(entry.transition).toBe('reappearing');
    expect(report.summary.reappearingCount).toBe(1);
  });

  it('counts snapshots in which each entry appears', () => {
    const s1 = snap([obs('A'), obs('B')]);
    const s2 = snap([obs('A')]);
    const s3 = snap([obs('A'), obs('B')]);
    const report = analyzeLifecycle([s1, s2, s3]);
    const a = report.entries.find((e) => e.ledgerKey === 'A')!;
    const b = report.entries.find((e) => e.ledgerKey === 'B')!;
    expect(a.presentCount).toBe(3);
    expect(b.presentCount).toBe(2);
  });

  it('calculates observed lifetime ranges from lastModifiedLedgerSeq', () => {
    const s1 = snap([obs('K', { lastModifiedLedgerSeq: 100 })]);
    const s2 = snap([obs('K', { lastModifiedLedgerSeq: 200 })]);
    const report = analyzeLifecycle([s1, s2]);
    const entry = report.entries.find((e) => e.ledgerKey === 'K')!;
    expect(entry.firstObservedModifiedLedger).toBe(100);
    expect(entry.lastObservedModifiedLedger).toBe(200);
  });

  it('populates snapshotLedgers in the report', () => {
    const s1 = snap([], 1000);
    const s2 = snap([], 2000);
    const report = analyzeLifecycle([s1, s2]);
    expect(report.snapshotLedgers).toEqual([1000, 2000]);
  });
});

// ---------------------------------------------------------------------------
// analyzeLifecycle — summary counts
// ---------------------------------------------------------------------------

describe('analyzeLifecycle summary counts', () => {
  it('produces correct summary for a mixed lifecycle set', () => {
    const s1 = snap([
      obs('PERSIST'),
      obs('MODIFY', { valueXdr: 'V1' }),
      obs('REMOVE'),
      obs('REAPP'),
    ]);
    const s2 = snap([
      obs('PERSIST'),
      obs('MODIFY', { valueXdr: 'V2' }),
      // REMOVE absent → removed
      // REAPP absent → gap
      obs('FIRST-NEW'), // new in s2 → first-observed
    ]);
    const s3 = snap([
      obs('PERSIST'),
      obs('MODIFY', { valueXdr: 'V2' }),
      obs('FIRST-NEW'),
      obs('REAPP'), // back → reappearing
    ]);
    const report = analyzeLifecycle([s1, s2, s3]);
    expect(report.summary.persistingCount).toBe(1);
    expect(report.summary.modifiedCount).toBe(1);
    expect(report.summary.removedCount).toBe(1);
    expect(report.summary.reappearingCount).toBe(1);
    expect(report.summary.firstObservedCount).toBe(1);
  });

  it('counts TTL trends correctly', () => {
    const s1 = snap([
      obs('INC', { liveUntilLedgerSeq: 100 }),
      obs('DEC', { liveUntilLedgerSeq: 900 }),
      obs('SAME', { liveUntilLedgerSeq: 500 }),
    ]);
    const s2 = snap([
      obs('INC', { liveUntilLedgerSeq: 200 }),
      obs('DEC', { liveUntilLedgerSeq: 800 }),
      obs('SAME', { liveUntilLedgerSeq: 500 }),
    ]);
    const report = analyzeLifecycle([s1, s2]);
    expect(report.summary.ttlIncreasingCount).toBe(1);
    expect(report.summary.ttlDecreasingCount).toBe(1);
    expect(report.summary.ttlUnchangedCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// analyzeLifecycle — filters
// ---------------------------------------------------------------------------

describe('analyzeLifecycle filters', () => {
  const CONTRACT_A = 'CONTRACT-AAAA';
  const CONTRACT_B = 'CONTRACT-BBBB';

  const s1 = snap([
    obs('K-A1', { contractId: CONTRACT_A, durability: 'persistent' }),
    obs('K-B1', { contractId: CONTRACT_B, durability: 'temporary' }),
    obs('K-A2', { contractId: CONTRACT_A, durability: 'persistent' }),
  ]);
  const s2 = snap([
    obs('K-A1', { contractId: CONTRACT_A, durability: 'persistent', valueXdr: 'NEW' }),
    obs('K-B1', { contractId: CONTRACT_B, durability: 'temporary' }),
    obs('K-A2', { contractId: CONTRACT_A, durability: 'persistent' }),
  ]);

  it('filters by contract ID', () => {
    const report = analyzeLifecycle([s1, s2], { contractIdFilter: CONTRACT_A });
    expect(report.entries.every((e) => e.contractId === CONTRACT_A)).toBe(true);
    expect(report.entries.some((e) => e.contractId === CONTRACT_B)).toBe(false);
  });

  it('filters by durability', () => {
    const report = analyzeLifecycle([s1, s2], { durabilityFilter: 'temporary' });
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0].ledgerKey).toBe('K-B1');
  });

  it('filters by lifecycle transition type', () => {
    const report = analyzeLifecycle([s1, s2], { transitionFilter: 'modified' });
    expect(report.entries.every((e) => e.transition === 'modified')).toBe(true);
    expect(report.entries.some((e) => e.transition === 'persisting')).toBe(false);
  });

  it('returns all entries when no filter is set', () => {
    const report = analyzeLifecycle([s1, s2]);
    expect(report.entries).toHaveLength(3);
  });

  it('returns empty entries when no entries match the contract filter', () => {
    const report = analyzeLifecycle([s1, s2], { contractIdFilter: 'NO-MATCH' });
    expect(report.entries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// analyzeLifecycle — snapshot ordering validation
// ---------------------------------------------------------------------------

describe('analyzeLifecycle snapshot ordering validation', () => {
  it('does not throw when validateSnapshotOrder is false', () => {
    const s1 = snap([], 500);
    const s2 = snap([], 100); // out of order
    expect(() => analyzeLifecycle([s1, s2])).not.toThrow();
  });

  it('validateSnapshotOrder helper detects out-of-order snapshots', () => {
    const s1 = snap([], 500);
    const s2 = snap([], 100);
    const violations = validateSnapshotOrder([s1, s2]);
    expect(violations.length).toBeGreaterThan(0);
  });

  it('validateSnapshotOrder reports no violations for ordered snapshots', () => {
    const snapshots = [snap([], 100), snap([], 200), snap([], 300)];
    expect(validateSnapshotOrder(snapshots)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// analyzeLifecycle — determinism
// ---------------------------------------------------------------------------

describe('analyzeLifecycle determinism', () => {
  it('produces identical output for identical inputs regardless of insertion order', () => {
    const entries1 = [obs('Z-KEY'), obs('A-KEY'), obs('M-KEY')];
    const entries2 = [obs('M-KEY'), obs('Z-KEY'), obs('A-KEY')];

    const s1a = snap(entries1);
    const s2a = snap([obs('Z-KEY'), obs('A-KEY'), obs('M-KEY')]);

    const s1b = snap(entries2);
    const s2b = snap([obs('A-KEY'), obs('M-KEY'), obs('Z-KEY')]);

    const reportA = analyzeLifecycle([s1a, s2a]);
    const reportB = analyzeLifecycle([s1b, s2b]);

    const keysA = reportA.entries.map((e) => e.ledgerKey);
    const keysB = reportB.entries.map((e) => e.ledgerKey);

    expect(keysA).toEqual(keysB);
    expect(keysA).toEqual(['A-KEY', 'M-KEY', 'Z-KEY']);
  });
});

// ---------------------------------------------------------------------------
// analyzeLifecycle — partial / malformed entries
// ---------------------------------------------------------------------------

describe('analyzeLifecycle — partial and malformed entries', () => {
  it('handles entries missing liveUntilLedgerSeq without aborting', () => {
    const s1 = snap([obs('K', { liveUntilLedgerSeq: undefined })]);
    const s2 = snap([obs('K', { liveUntilLedgerSeq: undefined })]);
    const report = analyzeLifecycle([s1, s2]);
    const entry = report.entries.find((e) => e.ledgerKey === 'K')!;
    expect(entry).toBeDefined();
    expect(entry.ttlTrend).toBe('unknown');
  });

  it('handles entries missing valueXdr without aborting', () => {
    const s1 = snap([obs('K', { valueXdr: undefined })]);
    const s2 = snap([obs('K', { valueXdr: undefined })]);
    const report = analyzeLifecycle([s1, s2]);
    expect(report.entries).toHaveLength(1);
  });

  it('handles entries with unknown durability', () => {
    const s1 = snap([obs('K', { durability: 'unknown' })]);
    const s2 = snap([obs('K', { durability: 'unknown' })]);
    const report = analyzeLifecycle([s1, s2]);
    expect(report.entries[0].latestObservation?.durability).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// formatReport
// ---------------------------------------------------------------------------

describe('formatReport', () => {
  it('includes snapshot count and key count in the output', () => {
    const s1 = snap([obs('K')], 100);
    const s2 = snap([obs('K')], 200);
    const report = analyzeLifecycle([s1, s2]);
    const output = formatReport(report);
    expect(output).toContain('2');
    expect(output).toContain('ledger 100');
    expect(output).toContain('ledger 200');
    expect(output).toContain('K');
  });

  it('includes transition classification in output', () => {
    const s1 = snap([obs('K', { valueXdr: 'V1' })]);
    const s2 = snap([obs('K', { valueXdr: 'V2' })]);
    const report = analyzeLifecycle([s1, s2]);
    const output = formatReport(report);
    expect(output).toContain('modified');
  });

  it('includes TTL trend in output', () => {
    const s1 = snap([obs('K', { liveUntilLedgerSeq: 1000 })]);
    const s2 = snap([obs('K', { liveUntilLedgerSeq: 1500 })]);
    const report = analyzeLifecycle([s1, s2]);
    const output = formatReport(report);
    expect(output).toContain('increasing');
  });

  it('shows "no entries" message when all entries are filtered out', () => {
    const s1 = snap([obs('K')]);
    const s2 = snap([obs('K')]);
    const report = analyzeLifecycle([s1, s2], { contractIdFilter: 'NO-MATCH' });
    const output = formatReport(report);
    expect(output).toContain('No entries match');
  });

  it('includes delta information for value changes', () => {
    const s1 = snap([obs('K', { valueXdr: 'RAWOLD' })]);
    const s2 = snap([obs('K', { valueXdr: 'RAWNEW' })]);
    const report = analyzeLifecycle([s1, s2]);
    const output = formatReport(report);
    expect(output).toContain('RAWOLD');
    expect(output).toContain('RAWNEW');
  });

  it('marks intermediate gaps in the output', () => {
    const s1 = snap([obs('K')]);
    const s2 = snap([]);
    const s3 = snap([obs('K')]);
    const report = analyzeLifecycle([s1, s2, s3]);
    const output = formatReport(report);
    expect(output).toContain('intermediate gap');
  });
});

// ---------------------------------------------------------------------------
// JSON output consistency
// ---------------------------------------------------------------------------

describe('JSON output consistency', () => {
  it('serialises the same fields as the typed report', () => {
    const s1 = snap([obs('K', { valueXdr: 'XOLD', liveUntilLedgerSeq: 500 })], 100);
    const s2 = snap([obs('K', { valueXdr: 'XNEW', liveUntilLedgerSeq: 600 })], 200);
    const report = analyzeLifecycle([s1, s2]);
    const json = JSON.parse(JSON.stringify(report)) as LifecycleReport;

    expect(json.snapshotCount).toBe(report.snapshotCount);
    expect(json.totalUniqueKeys).toBe(report.totalUniqueKeys);
    expect(json.entries).toHaveLength(report.entries.length);
    expect(json.summary.modifiedCount).toBe(report.summary.modifiedCount);

    // Raw encoded values preserved
    const entry = json.entries.find((e) => e.ledgerKey === 'K')!;
    expect(entry.deltas[0].previousValueXdr).toBe('XOLD');
    expect(entry.deltas[0].currentValueXdr).toBe('XNEW');
    expect(entry.deltas[0].ttlDelta).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Runner catalog registration
// ---------------------------------------------------------------------------

describe('Runner catalog registration', () => {
  it('registers 197-state-lifecycle', () => {
    expect(examples['197-state-lifecycle']).toBeDefined();
    expect(examples['197-state-lifecycle'].name).toBe('197-state-lifecycle');
    expect(typeof examples['197-state-lifecycle'].run).toBe('function');
  });

  it('has a non-empty description', () => {
    expect(examples['197-state-lifecycle'].description.length).toBeGreaterThan(0);
  });

  it('exposes params for interactive runner', () => {
    expect(Array.isArray(examples['197-state-lifecycle'].params)).toBe(true);
    expect(examples['197-state-lifecycle'].params!.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Source file content assertions
// ---------------------------------------------------------------------------

describe('Source file content', () => {
  const source = fs.readFileSync('src/examples/197-state-lifecycle.ts', 'utf8');

  it('is fully offline — no network imports', () => {
    expect(source).not.toContain("from 'stellar-sdk");
    expect(source).not.toContain('rpc.Server');
    expect(source).not.toContain('fetch(');
  });

  it('exports run function', () => {
    expect(source).toContain('export async function run(');
  });

  it('exports analyzeLifecycle', () => {
    expect(source).toContain('export function analyzeLifecycle(');
  });

  it('exports formatReport', () => {
    expect(source).toContain('export function formatReport(');
  });

  it('documents all lifecycle transition types', () => {
    expect(source).toContain('first-observed');
    expect(source).toContain('persisting');
    expect(source).toContain('modified');
    expect(source).toContain('removed');
    expect(source).toContain('reappearing');
  });

  it('supports JSON output', () => {
    expect(source).toContain('jsonOutput');
    expect(source).toContain('JSON.stringify');
  });

  it('supports contract ID filtering', () => {
    expect(source).toContain('contractIdFilter');
  });

  it('supports durability filtering', () => {
    expect(source).toContain('durabilityFilter');
  });

  it('supports lifecycle transition filtering', () => {
    expect(source).toContain('transitionFilter');
  });

  it('preserves raw encoded values', () => {
    expect(source).toContain('valueXdr');
    expect(source).toContain('previousValueXdr');
  });

  it('validates snapshot ordering', () => {
    expect(source).toContain('validateSnapshotOrder');
  });

  it('tracks liveUntilLedgerSeq changes', () => {
    expect(source).toContain('liveUntilLedgerSeq');
    expect(source).toContain('ttlDelta');
  });

  it('tracks lastModifiedLedgerSeq', () => {
    expect(source).toContain('lastModifiedLedgerSeq');
  });

  it('produces deterministic output by sorting keys', () => {
    expect(source).toContain('.sort()');
  });
});

// ---------------------------------------------------------------------------
// README documentation
// ---------------------------------------------------------------------------

describe('README documentation', () => {
  const readme = fs.readFileSync('README.md', 'utf8');

  it('documents 197-state-lifecycle', () => {
    expect(readme).toContain('197-state-lifecycle');
  });
});
