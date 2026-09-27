import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  analyzeCustomSections,
  analyzeGlobals,
  analyzeInstructions,
  analyzeMemoryTables,
  WasmValidationError,
} from '../src/utils/wasm-static-analysis';
import { compareCustomSectionReports } from '../src/examples/245-wasm-custom-sections';
import { compareGlobalReports } from '../src/examples/246-wasm-globals';
import { compareInstructionReports } from '../src/examples/247-wasm-instructions';
import { compareMemoryTableReports } from '../src/examples/244-wasm-memory';

function u32(value: number): number[] {
  const bytes: number[] = [];
  let current = value >>> 0;
  do {
    let byte = current & 0x7f;
    current >>>= 7;
    if (current !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (current !== 0);
  return bytes;
}

function str(value: string): number[] {
  const bytes = Buffer.from(value, 'utf8');
  return [...u32(bytes.length), ...bytes];
}

function section(id: number, payload: number[]): number[] {
  return [id, ...u32(payload.length), ...payload];
}

function fixture(
  options: { memoryInitial?: number; customPayload?: number[]; globalMutable?: boolean } = {},
): Buffer {
  const memoryInitial = options.memoryInitial ?? 1;
  const customPayload = options.customPayload ?? [1, 2, 3];
  const globalMutable = options.globalMutable ?? false;
  return Buffer.from([
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    ...section(0, [...str('meta'), ...customPayload]),
    ...section(1, [0x01, 0x60, 0x00, 0x00]),
    ...section(2, [
      0x03,
      ...str('env'),
      ...str('memory'),
      0x02,
      0x01,
      0x02,
      0x04,
      ...str('env'),
      ...str('table'),
      0x01,
      0x70,
      0x00,
      0x01,
      ...str('env'),
      ...str('global'),
      0x03,
      0x7f,
      0x01,
    ]),
    ...section(3, [0x01, 0x00]),
    ...section(4, [0x01, 0x70, 0x01, 0x01, 0x02]),
    ...section(5, [0x01, 0x01, ...u32(memoryInitial), 0x03]),
    ...section(6, [0x01, 0x7f, globalMutable ? 0x01 : 0x00, 0x41, 0x2a, 0x0b]),
    ...section(10, [0x01, 0x07, 0x00, 0x41, 0x01, 0x41, 0x02, 0x6a, 0x0b]),
  ]);
}

function writeWasm(buffer: Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wasm-analysis-'));
  const file = path.join(dir, 'fixture.wasm');
  fs.writeFileSync(file, buffer);
  return file;
}

describe('WASM static analysis examples', () => {
  it('parses imported and defined memories and tables deterministically', () => {
    const file = writeWasm(fixture());
    const report = analyzeMemoryTables(file);

    expect(report.statistics.memoryCount).toBe(2);
    expect(report.statistics.importedMemoryCount).toBe(1);
    expect(report.memories[0]).toMatchObject({
      index: 0,
      source: 'imported',
      limits: { initial: 2, maximum: 4 },
    });
    expect(report.memories[1]).toMatchObject({
      index: 1,
      source: 'defined',
      limits: { initial: 1, maximum: 3 },
    });
    expect(report.statistics.tableCount).toBe(2);
    expect(report.tables[0]).toMatchObject({
      index: 0,
      source: 'imported',
      elementType: 'funcref',
    });
    expect(analyzeMemoryTables(file)).toEqual(report);
  });

  it('detects memory and table comparison changes', () => {
    const before = writeWasm(fixture({ memoryInitial: 1 }));
    const after = writeWasm(fixture({ memoryInitial: 2 }));
    const comparison = compareMemoryTableReports(before, after).comparison;

    expect(comparison.memories.changed).toHaveLength(1);
    expect(comparison.memories.changed[0].changes).toContain('initial_limit');
    expect(comparison.tables.unchanged).toHaveLength(2);
  });

  it('parses custom sections and detects payload changes', () => {
    const before = writeWasm(fixture({ customPayload: [1] }));
    const after = writeWasm(fixture({ customPayload: [2, 3] }));
    const report = analyzeCustomSections(before);

    expect(report.sections[0]).toMatchObject({ name: 'meta', payloadSize: 1 });
    expect(report.statistics.totalCustomSectionSize).toBe(1);
    expect(compareCustomSectionReports(before, after).comparison.changed[0].changes).toEqual([
      'payload_size',
      'payload_hash',
    ]);
  });

  it('parses imported and defined globals and detects mutability changes', () => {
    const before = writeWasm(fixture({ globalMutable: false }));
    const after = writeWasm(fixture({ globalMutable: true }));
    const report = analyzeGlobals(before);

    expect(report.statistics.totalGlobalCount).toBe(2);
    expect(report.globals[0]).toMatchObject({
      source: 'imported',
      valueType: 'i32',
      mutable: true,
    });
    expect(report.globals[1]).toMatchObject({
      source: 'defined',
      valueType: 'i32',
      mutable: false,
      initExpression: 'i32.const 42',
    });
    expect(compareGlobalReports(before, after).comparison.changed[0].changes).toContain(
      'mutability',
    );
  });

  it('calculates instruction statistics without executing code', () => {
    const before = writeWasm(fixture());
    const after = writeWasm(fixture());
    const report = analyzeInstructions(before);

    expect(report.totalDefinedFunctions).toBe(1);
    expect(report.totalInstructionCount).toBe(4);
    expect(report.instructionFrequencies['i32.const']).toBe(2);
    expect(report.instructionFrequencies['i32.add']).toBe(1);
    expect(report.largestFunctions[0].instructionCount).toBe(4);
    expect(compareInstructionReports(before, after).comparison.instructionCountDelta).toBe(0);
  });

  it('throws clear validation errors for malformed WASM', () => {
    const file = writeWasm(Buffer.from('not wasm'));
    expect(() => analyzeMemoryTables(file)).toThrow(WasmValidationError);
    expect(() => analyzeMemoryTables(file)).toThrow(/missing WebAssembly magic header/);
  });
});
