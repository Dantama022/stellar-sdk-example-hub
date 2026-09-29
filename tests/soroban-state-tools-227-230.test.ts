import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { nativeToScVal, StrKey } from '@stellar/stellar-sdk';
import {
  parseJsonPreservingLargeIntegers,
  parseSnapshot,
  stableStringify,
} from '../src/utils/soroban-state-snapshot';
import { normalizeSnapshot } from '../src/examples/227-state-normalize';
import { validateRawSnapshot } from '../src/examples/228-state-validate';
import { buildStats } from '../src/examples/229-state-stats';
import { analyzeHotspots } from '../src/examples/230-state-hotspots';

function xdr(value: unknown): string {
  return nativeToScVal(value as any).toXDR('base64');
}

function entry(key: string, value: unknown, overrides: Record<string, unknown> = {}) {
  return {
    ledgerKey: key,
    contractId: StrKey.encodeContract(Buffer.alloc(32, 1)),
    durability: 'persistent',
    lastModifiedLedgerSeq: '100',
    liveUntilLedgerSeq: '200',
    valueXdr: xdr(value),
    ...overrides,
  };
}

describe('ISSUE-227 snapshot normalization', () => {
  test('normalizes deterministically and preserves large integers', () => {
    const raw = parseJsonPreservingLargeIntegers(
      '{"entries":[{"ledgerKey":"K","durability":"temporary","liveUntilLedgerSeq":900719925474099312345}],"ledger":900719925474099312344}',
    );
    const normalized = normalizeSnapshot(raw).snapshot;
    expect(normalized.ledger).toBe('900719925474099312344');
    expect(normalized.entries[0].liveUntilLedgerSeq).toBe('900719925474099312345');
    expect(stableStringify(normalized)).toBe(stableStringify(parseSnapshot(normalized)));
  });

  test('detects duplicate normalized keys', () => {
    expect(() => normalizeSnapshot({ entries: [{ ledgerKey: 'K' }, { ledgerKey: 'K' }] })).toThrow(
      /duplicate/i,
    );
  });
});

describe('ISSUE-228 snapshot validation', () => {
  test('accepts a complete snapshot', () => {
    const report = validateRawSnapshot({
      version: 1,
      ledger: '100',
      entries: [entry('K', 1)],
    });
    expect(report.summary.errors).toBe(0);
  });

  test('strict mode fails warnings', () => {
    const report = validateRawSnapshot({ entries: [] }, true);
    expect(report.valid).toBe(false);
    expect(report.summary.warnings).toBeGreaterThan(0);
  });

  test('detects invalid ttl relationships and duplicates', () => {
    const report = validateRawSnapshot({
      version: 1,
      ledger: '100',
      entries: [
        entry('K', 1, { lastModifiedLedgerSeq: '200', liveUntilLedgerSeq: '100' }),
        entry('K', 2),
      ],
    });
    expect(report.diagnostics.some((d) => d.code === 'entry.ttl.relationship')).toBe(true);
    expect(report.diagnostics.some((d) => d.code === 'entry.duplicate')).toBe(true);
  });
});

describe('ISSUE-229 state statistics', () => {
  test('calculates counts, sizes, ttl and deterministic top-N', () => {
    const entries = parseSnapshot({
      entries: [entry('B', [1, 2, 3]), entry('A', 1, { durability: 'temporary' })],
    }).entries;
    const report = buildStats(entries, {
      top: 1,
      referenceLedger: '150',
      ttlThreshold: '60',
    });
    expect(report.totalEntries).toBe(2);
    expect(report.countsByDurability.persistent).toBe(1);
    expect(report.countsByDurability.temporary).toBe(1);
    expect(report.ttl.entriesWithTtl).toBe(2);
    expect(report.ttl.approachingExpiration).toEqual(['A', 'B']);
    expect(report.largestEncodedValues).toHaveLength(1);
  });
});

describe('ISSUE-230 state hotspots', () => {
  test('ranks by encoded size, collection size, depth and ttl proximity', () => {
    const entries = parseSnapshot({
      entries: [
        entry('A', 1, { liveUntilLedgerSeq: '170' }),
        entry('B', [1, 2, 3], { liveUntilLedgerSeq: '180' }),
        entry('C', [[1, 2], [3]], { liveUntilLedgerSeq: '160' }),
      ],
    }).entries;

    expect(analyzeHotspots(entries, { by: 'collection', top: 1 }).results[0].ledgerKey).toBe('C');
    expect(analyzeHotspots(entries, { by: 'depth', top: 1 }).results[0].ledgerKey).toBe('C');
    expect(
      analyzeHotspots(entries, { by: 'ttl', top: 1, referenceLedger: '150' }).results[0].ledgerKey,
    ).toBe('C');
    expect(analyzeHotspots(entries, { by: 'size', top: 2 }).results).toHaveLength(2);
  });

  test('thresholds and filters work', () => {
    const entries = parseSnapshot({
      entries: [
        entry('A', [1], { durability: 'temporary' }),
        entry('B', [1, 2, 3], { durability: 'persistent' }),
      ],
    }).entries;
    const report = analyzeHotspots(entries, {
      by: 'collection',
      durability: 'persistent',
      minCollection: 2,
    });
    expect(report.results.map((r) => r.ledgerKey)).toEqual(['B']);
  });
});

describe('input immutability', () => {
  test('analysis does not mutate input files', () => {
    const file = path.join(os.tmpdir(), `state-tools-${Date.now()}.json`);
    const original = JSON.stringify({ version: 1, entries: [entry('A', [1, 2])] });
    fs.writeFileSync(file, original, 'utf8');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const snapshot = parseSnapshot(raw);
    buildStats(snapshot.entries);
    analyzeHotspots(snapshot.entries);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    fs.unlinkSync(file);
  });
});
