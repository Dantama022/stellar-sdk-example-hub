import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  analyzeStateTransitions,
  analyzeWasmDependencies,
  analyzeWasmFootprint,
  compareWasmCompatibility,
} from '../src/examples/225-wasm-analysis';
import type { EntryObservation, Snapshot } from '../src/examples/197-state-lifecycle';

const wasmHeader = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

function u32(value: number): number[] {
  const bytes: number[] = [];
  do {
    let next = value & 0x7f;
    value >>>= 7;
    if (value !== 0) next |= 0x80;
    bytes.push(next);
  } while (value !== 0);
  return bytes;
}

function text(value: string): number[] {
  const bytes = [...Buffer.from(value, 'utf8')];
  return [...u32(bytes.length), ...bytes];
}

function section(id: number, payload: number[]): number[] {
  return [id, ...u32(payload.length), ...payload];
}

function wasm(options: { parameterType?: number; imports?: Array<{ module: string; name: string }>; exportName?: string; custom?: boolean } = {}): Buffer {
  const imports = options.imports ?? [];
  const parts = [...wasmHeader];
  if (imports.length > 0) {
    parts.push(...section(1, [1, 0x60, 1, options.parameterType ?? 0x7f, 0]));
    const importPayload = [imports.length];
    for (const entry of imports) importPayload.push(...text(entry.module), ...text(entry.name), 0, 0);
    parts.push(...section(2, importPayload));
  }
  if (options.exportName) parts.push(...section(7, [1, ...text(options.exportName), 0, 0]));
  if (options.custom) parts.push(...section(0, [...text('name'), 1, 0x78]));
  return Buffer.from(parts);
}

function writeWasm(bytes: Buffer): string {
  const file = path.join(os.tmpdir(), `wasm-analysis-${Date.now()}-${Math.random()}.wasm`);
  fs.writeFileSync(file, bytes);
  return file;
}

function observation(ledgerKey: string, overrides: Partial<EntryObservation> = {}): EntryObservation {
  return { ledgerKey, contractId: 'C1', durability: 'persistent', valueXdr: 'a', liveUntilLedgerSeq: 20, ...overrides };
}

function snapshot(ledger: number, entries: EntryObservation[]): Snapshot {
  return { ledger, entries };
}

describe('offline WASM analysis', () => {
  it('reports encoded section sizes, total bytes, percentages, and custom sections', () => {
    const file = writeWasm(wasm({ imports: [{ module: 'env', name: 'read' }], exportName: 'read', custom: true }));
    const report = analyzeWasmFootprint(file);
    expect(report.totalBytes).toBe(fs.statSync(file).size);
    expect(report.sectionCount).toBe(4);
    expect(report.sections.map((entry) => entry.name)).toEqual(['type', 'import', 'export', 'custom']);
    expect(report.sections[3].customName).toBe('name');
    expect(report.sections[0].percent).toBe(Number(((report.sections[0].size / report.totalBytes) * 100).toFixed(4)));
    expect(report.aggregates.import.bytes).toBe(report.sections[1].size);
  });

  it('detects import and export signature modifications without instantiating modules', () => {
    const before = writeWasm(wasm({ imports: [{ module: 'env', name: 'run' }], exportName: 'run' }));
    const after = writeWasm(wasm({ imports: [{ module: 'env', name: 'run' }], exportName: 'run', parameterType: 0x7e }));
    const report = compareWasmCompatibility(before, after);
    expect(report.unchanged).toBe(false);
    expect(report.imports.modified).toHaveLength(1);
    expect(report.exports.modified).toHaveLength(1);
  });

  it('reports added and removed exports and treats identical artifacts as unchanged', () => {
    const before = writeWasm(wasm({ imports: [{ module: 'env', name: 'run' }] }));
    const after = writeWasm(wasm({ imports: [{ module: 'env', name: 'run' }], exportName: 'run' }));
    expect(compareWasmCompatibility(before, before).unchanged).toBe(true);
    expect(compareWasmCompatibility(before, after).exports.added.map((entry) => entry.name)).toEqual(['run']);
    expect(compareWasmCompatibility(after, before).exports.removed.map((entry) => entry.name)).toEqual(['run']);
  });

  it('groups dependencies and reports added and removed imports', () => {
    const before = writeWasm(wasm({ imports: [{ module: 'env', name: 'old' }] }));
    const after = writeWasm(wasm({ imports: [{ module: 'env', name: 'new' }] }));
    const report = analyzeWasmDependencies(before, after);
    expect(report.modules[0].module).toBe('env');
    expect(report.countsByType.function).toBe(1);
    expect(report.comparison?.added.map((entry) => entry.name)).toEqual(['new']);
    expect(report.comparison?.removed.map((entry) => entry.name)).toEqual(['old']);
  });

  it('rejects malformed WASM files with a useful error', () => {
    const file = writeWasm(Buffer.from('not wasm'));
    expect(() => analyzeWasmFootprint(file)).toThrow(/Invalid WASM file/);
  });
});

describe('state transition matrix', () => {
  it('reports creation, removal, reappearance, value, TTL, and durability transitions deterministically', () => {
    const snapshots = [
      snapshot(10, [observation('a')]),
      snapshot(11, [observation('a', { valueXdr: 'b', liveUntilLedgerSeq: 25, durability: 'temporary' }), observation('b')]),
      snapshot(12, [observation('a'), observation('b')]),
      snapshot(13, [observation('a')]),
      snapshot(14, [observation('a'), observation('b')]),
    ];
    const report = analyzeStateTransitions(snapshots);
    const types = report.rows.map((row) => row.transitionType);
    expect(types).toContain('created');
    expect(types).toContain('removed');
    expect(types).toContain('reappeared');
    expect(types).toContain('value-changed');
    expect(types).toContain('durability-changed');
    expect(types).toContain('ttl-increased');
    expect(types).toContain('ttl-decreased');
    expect(report).toEqual(analyzeStateTransitions(snapshots));
    expect(analyzeStateTransitions(snapshots, { contractId: 'C1', transitionType: 'reappeared' }).rows).toHaveLength(1);
  });

  it('validates snapshot ordering and minimum-frequency filtering', () => {
    expect(() => analyzeStateTransitions([snapshot(12, []), snapshot(11, [])])).toThrow(/ordering/);
    const result = analyzeStateTransitions([
      snapshot(1, [observation('a'), observation('b')]),
      snapshot(2, []),
    ], { minimumFrequency: 2 });
    expect(result.rows).toHaveLength(0);
  });
});