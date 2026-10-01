import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  analyzeCustomSections,
  analyzeGlobals,
  analyzeInstructions,
  analyzeMemoryTables,
  analyzeWasmNames,
  WasmValidationError,
} from '../src/utils/wasm-static-analysis';
import { compareCustomSectionReports } from '../src/examples/245-wasm-custom-sections';
import { compareGlobalReports } from '../src/examples/246-wasm-globals';
import { compareInstructionReports } from '../src/examples/247-wasm-instructions';
import { compareMemoryTableReports } from '../src/examples/244-wasm-memory';
import { compareWasmNameReports } from '../src/examples/253-wasm-names';
import { parseWasmNamesArgs, runWasmNamesCli } from '../src/wasm-names';

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

function nameMap(entries: Array<[number, string]>): number[] {
  return [
    ...u32(entries.length),
    ...entries.flatMap(([index, name]) => [...u32(index), ...str(name)]),
  ];
}

function nameSubsection(id: number, payload: number[]): number[] {
  return [id, ...u32(payload.length), ...payload];
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

function wasmNamesModule(namePayload?: number[], importedFunction = false): Buffer {
  const namedCustomSection =
    namePayload === undefined ? [] : section(0, [...str('name'), ...namePayload]);
  const functionBody = (locals: number) => [0x01, ...u32(locals), 0x7f, 0x0b];
  return Buffer.from([
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    ...namedCustomSection,
    ...section(1, [0x01, 0x60, 0x02, 0x7f, 0x7f, 0x00]),
    ...(importedFunction ? section(2, [0x01, ...str('env'), ...str('callback'), 0x00, 0x00]) : []),
    ...section(3, [0x03, 0x00, 0x00, 0x00]),
    ...section(10, [
      0x03,
      ...u32(functionBody(0).length),
      ...functionBody(0),
      ...u32(functionBody(2).length),
      ...functionBody(2),
      ...u32(functionBody(0).length),
      ...functionBody(0),
    ]),
  ]);
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

  it('maps function and local names while distinguishing missing and explicit empty names', () => {
    const payload = [
      ...nameSubsection(
        1,
        nameMap([
          [0, 'sum'],
          [1, ''],
        ]),
      ),
      ...nameSubsection(2, [
        ...u32(2),
        ...u32(0),
        ...nameMap([[0, 'left']]),
        ...u32(1),
        ...nameMap([
          [0, 'first'],
          [1, 'second'],
          [3, 'third'],
        ]),
      ]),
    ];
    const file = writeWasm(wasmNamesModule(payload));
    const report = analyzeWasmNames(file);

    expect(report.nameSection).toMatchObject({
      present: true,
      count: 1,
      subsections: [
        { id: 1, name: 'function' },
        { id: 2, name: 'local' },
      ],
    });
    expect(report.functions[0]).toMatchObject({
      functionIndex: 0,
      name: 'sum',
      status: 'named',
      expectedLocalCount: 2,
      namedLocalCount: 1,
      unnamedLocalRanges: [{ startIndex: 1, endIndex: 1 }],
    });
    expect(report.functions[1]).toMatchObject({
      functionIndex: 1,
      name: '',
      status: 'explicitly-unnamed',
      expectedLocalCount: 4,
      namedLocalCount: 3,
      unnamedLocalRanges: [{ startIndex: 2, endIndex: 2 }],
    });
    expect(report.functionsWithIncompleteLocalNames).toEqual([0]);
    expect(report.statistics).toMatchObject({
      totalNamedFunctions: 1,
      totalUnnamedFunctions: 2,
      totalFunctionsWithLocalNameMetadata: 2,
      totalNamedLocals: 4,
    });
    expect(analyzeWasmNames(file)).toEqual(report);
  });

  it('recognizes complete local naming metadata and preserves imported function indexes', () => {
    const completePayload = [
      ...nameSubsection(
        1,
        nameMap([
          [0, 'first'],
          [1, 'second'],
        ]),
      ),
      ...nameSubsection(2, [
        ...u32(2),
        ...u32(0),
        ...nameMap([
          [0, 'a'],
          [1, 'b'],
        ]),
        ...u32(1),
        ...nameMap([
          [0, 'a'],
          [1, 'b'],
          [2, 'c'],
          [3, 'd'],
        ]),
      ]),
    ];
    const complete = analyzeWasmNames(writeWasm(wasmNamesModule(completePayload)));
    const importedPayload = nameSubsection(
      1,
      nameMap([
        [0, 'host_callback'],
        [1, 'defined_fn'],
      ]),
    );
    const withImport = analyzeWasmNames(writeWasm(wasmNamesModule(importedPayload, true)));

    expect(complete.functionsWithIncompleteLocalNames).toEqual([]);
    expect(complete.statistics.functionsWithMostNamedLocals).toEqual([
      { functionIndex: 1, name: 'second', count: 4 },
      { functionIndex: 0, name: 'first', count: 2 },
    ]);
    expect(withImport.functions[0]).toMatchObject({
      functionIndex: 0,
      defined: false,
      name: 'host_callback',
    });
    expect(withImport.functions[1]).toMatchObject({
      functionIndex: 1,
      defined: true,
      name: 'defined_fn',
    });
    expect(parseWasmNamesArgs(['before.wasm', '--compare', 'after.wasm', '--json'])).toEqual({
      wasmFile: 'before.wasm',
      compareFile: 'after.wasm',
      json: true,
    });
  });

  it('reports absent name metadata and tolerates malformed name subsections', () => {
    const absent = analyzeWasmNames(writeWasm(wasmNamesModule()));
    const malformed = analyzeWasmNames(writeWasm(wasmNamesModule([0x01, 0x02, 0x01, 0x01])));

    expect(absent.nameSection).toMatchObject({ present: false, count: 0, subsections: [] });
    expect(absent.functions.every((fn) => fn.status === 'unmapped')).toBe(true);
    expect(malformed.nameSection.present).toBe(true);
    expect(malformed.warnings).toEqual([
      expect.stringContaining('Unable to parse name subsection 1'),
    ]);

    const additionalSubsection = analyzeWasmNames(
      writeWasm(wasmNamesModule(nameSubsection(10, [0x01]))),
    );
    expect(additionalSubsection.nameSection.subsections).toEqual([{ id: 10, name: 'field' }]);
    expect(additionalSubsection.warnings).toEqual([]);
  });

  it('compares function and local names by raw WASM indexes', () => {
    const before = writeWasm(
      wasmNamesModule([
        ...nameSubsection(
          1,
          nameMap([
            [0, 'old'],
            [1, 'removed'],
          ]),
        ),
        ...nameSubsection(2, [
          ...u32(1),
          ...u32(0),
          ...nameMap([
            [0, 'before'],
            [1, 'gone'],
          ]),
        ]),
      ]),
    );
    const after = writeWasm(
      wasmNamesModule([
        ...nameSubsection(
          1,
          nameMap([
            [0, 'new'],
            [2, 'added'],
          ]),
        ),
        ...nameSubsection(2, [
          ...u32(1),
          ...u32(0),
          ...nameMap([
            [0, 'after'],
            [2, 'new-local'],
          ]),
        ]),
      ]),
    );
    const comparison = compareWasmNameReports(before, after).comparison;

    expect(comparison.renamedFunctions).toEqual([
      { functionIndex: 0, before: 'old', after: 'new' },
    ]);
    expect(comparison.removedFunctionNames).toEqual([{ functionIndex: 1, name: 'removed' }]);
    expect(comparison.addedFunctionNames).toEqual([{ functionIndex: 2, name: 'added' }]);
    expect(comparison.changedLocalNames).toEqual([
      { functionIndex: 0, localIndex: 0, before: 'before', after: 'after' },
    ]);
    expect(comparison.removedLocalNames).toEqual([
      { functionIndex: 0, localIndex: 1, name: 'gone' },
    ]);
    expect(comparison.addedLocalNames).toEqual([
      { functionIndex: 0, localIndex: 2, name: 'new-local' },
    ]);
  });

  it('provides deterministic JSON output through the offline CLI without instantiating WASM', async () => {
    const file = writeWasm(wasmNamesModule());
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const instantiate = jest.spyOn(WebAssembly, 'instantiate');
    try {
      await expect(runWasmNamesCli([file, '--json'])).resolves.toBe(0);
      expect(JSON.parse(String(log.mock.calls[0][0])).nameSection.present).toBe(false);
      expect(instantiate).not.toHaveBeenCalled();
    } finally {
      instantiate.mockRestore();
      log.mockRestore();
    }
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
