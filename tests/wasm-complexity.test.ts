import fs from 'fs';
import os from 'os';
import path from 'path';

import { runInspectorCli } from '../src/stellar-api-inspector';
import {
  analyzeComplexity,
  compareComplexity,
  COMPLEXITY_WEIGHTS,
} from '../src/utils/wasm-complexity';
import { WasmValidationError } from '../src/utils/wasm-static-analysis';

function u32(value: number): number[] {
  const result: number[] = [];
  let current = value >>> 0;
  do {
    let byte = current & 0x7f;
    current >>>= 7;
    if (current !== 0) byte |= 0x80;
    result.push(byte);
  } while (current !== 0);
  return result;
}

function text(value: string): number[] {
  const bytes = Buffer.from(value);
  return [...u32(bytes.length), ...bytes];
}

function section(id: number, payload: number[]): number[] {
  return [id, ...u32(payload.length), ...payload];
}

function moduleWithBody(
  instructions: number[],
  includeFinalEnd = true,
  localCount = 1,
  exportName?: string,
): Buffer {
  const expression = [...instructions, ...(includeFinalEnd ? [0x0b] : [])];
  const body = [0x01, ...u32(localCount), 0x7f, ...expression];
  return Buffer.from([
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    ...section(1, [0x01, 0x60, 0x00, 0x00]),
    ...section(2, [0x01, ...text('env'), ...text('host'), 0x00, 0x00]),
    ...section(3, [0x01, 0x00]),
    ...section(5, [0x01, 0x00, 0x01]),
    ...(exportName ? section(7, [0x01, ...text(exportName), 0x00, 0x01]) : []),
    ...section(10, [0x01, ...u32(body.length), ...body]),
  ]);
}

function moduleWithFunctions(
  bodies: number[][],
  exportsByDefinedIndex: Record<number, string> = {},
): Buffer {
  const encodedBodies = bodies.map((instructions) => {
    const body = [0x00, ...instructions, 0x0b];
    return [...u32(body.length), ...body];
  });
  const exportEntries = Object.entries(exportsByDefinedIndex)
    .map(([definedIndex, name]) => [...text(name), 0x00, ...u32(Number(definedIndex))])
    .flat();
  return Buffer.from([
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    ...section(1, [0x01, 0x60, 0x00, 0x00]),
    ...section(3, [...u32(bodies.length), ...bodies.map(() => 0x00)]),
    ...(exportEntries.length > 0
      ? section(7, [Object.keys(exportsByDefinedIndex).length, ...exportEntries])
      : []),
    ...section(10, [...u32(bodies.length), ...encodedBodies.flat()]),
  ]);
}

function writeWasm(buffer: Buffer): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wasm-complexity-'));
  const file = path.join(directory, 'fixture.wasm');
  fs.writeFileSync(file, buffer);
  return file;
}

const COMPLEX_INSTRUCTIONS = [
  0x02,
  0x40, // block
  0x20,
  0x00, // local.get 0
  0x28,
  0x02,
  0x00, // i32.load align=2 offset=0
  0x10,
  0x00, // call imported function 0
  0x0d,
  0x00, // br_if 0
  0x0b, // end block
];

describe('offline WASM function complexity analysis', () => {
  it('calculates every per-function metric and the documented deterministic score', () => {
    const file = writeWasm(moduleWithBody(COMPLEX_INSTRUCTIONS));
    const report = analyzeComplexity(file);

    expect(report.scoring).toEqual(COMPLEXITY_WEIGHTS);
    expect(report.statistics).toMatchObject({
      importedFunctionCount: 1,
      definedFunctionCount: 1,
      totalInstructionCount: 7,
      totalCodeBodySize: 16,
      totalControlFlowCount: 3,
      totalBranchCount: 1,
      totalCallCount: 1,
      totalMemoryOperationCount: 1,
      totalLocalAccessCount: 1,
      totalComplexityScore: 21,
    });
    expect(report.functions[0]).toMatchObject({
      functionIndex: 1,
      definedFunctionIndex: 0,
      complexityScore: 21,
    });
    expect(analyzeComplexity(file)).toEqual(report);
  });

  it('highlights all configured thresholds deterministically', () => {
    const file = writeWasm(moduleWithBody(COMPLEX_INSTRUCTIONS));
    const report = analyzeComplexity(file, {
      score: 21,
      branchCount: 1,
      memoryOperationCount: 2,
    });

    expect(report.functions[0].highlighted).toBe(true);
    expect(report.functions[0].exceededThresholds).toEqual(['score', 'branchCount']);
    expect(report.statistics.highlightedFunctionCount).toBe(1);
  });

  it('reports increased and decreased per-function and aggregate metrics', () => {
    const simpler = writeWasm(moduleWithBody([0x01], true, 1, 'run'));
    const complex = writeWasm(moduleWithBody(COMPLEX_INSTRUCTIONS, true, 1, 'run'));

    const increase = compareComplexity(simpler, complex);
    expect(increase.comparison.increased[0]).toMatchObject({
      functionIndex: 1,
      instructionCount: 5,
      complexityScore: 17,
    });
    expect(increase.comparison.aggregateDelta.complexityScore).toBe(17);
    expect(compareComplexity(complex, simpler).comparison.decreased[0].complexityScore).toBe(-17);
    expect(compareComplexity(complex, complex).comparison.unchanged).toEqual([1]);
  });

  it('reports component changes even when the weighted score is unchanged', () => {
    const canonical = writeWasm(moduleWithBody([0x20, 0x00, 0x1a], true, 1, 'run'));
    const largerLocalsDeclaration = writeWasm(moduleWithBody([0x20, 0x00, 0x1a], true, 128, 'run'));

    const comparison = compareComplexity(canonical, largerLocalsDeclaration).comparison;
    expect(comparison.increased).toEqual([]);
    expect(comparison.decreased).toEqual([]);
    expect(comparison.changed).toHaveLength(1);
    expect(comparison.changed[0]).toMatchObject({ complexityScore: 0, bodySize: 1 });
  });

  it('does not create false per-function changes when a function is inserted in the middle', () => {
    const a = [0x01];
    const b = [0x02, 0x40, 0x0b];
    const inserted = [0x41, 0x00, 0x1a];
    const before = writeWasm(moduleWithFunctions([a, b]));
    const after = writeWasm(moduleWithFunctions([a, inserted, b]));

    const comparison = compareComplexity(before, after).comparison;
    expect(comparison.increased).toEqual([]);
    expect(comparison.decreased).toEqual([]);
    expect(comparison.changed).toEqual([]);
    expect(comparison.added).toHaveLength(1);
    expect(comparison.added[0].definedFunctionIndex).toBe(1);
    expect(comparison.removed).toEqual([]);
    expect(comparison.unchanged).toEqual([0, 2]);
  });

  it('classifies a removed function without shifting the remaining identities', () => {
    const a = [0x01];
    const removedBody = [0x41, 0x00, 0x1a];
    const b = [0x03, 0x40, 0x0b];
    const before = writeWasm(moduleWithFunctions([a, removedBody, b]));
    const after = writeWasm(moduleWithFunctions([a, b]));

    const comparison = compareComplexity(before, after).comparison;
    expect(comparison.increased).toEqual([]);
    expect(comparison.decreased).toEqual([]);
    expect(comparison.changed).toEqual([]);
    expect(comparison.added).toEqual([]);
    expect(comparison.removed).toHaveLength(1);
    expect(comparison.removed[0].definedFunctionIndex).toBe(1);
    expect(comparison.unchanged).toEqual([0, 1]);
  });

  it('matches reordered unchanged functions by fingerprint rather than ordinal', () => {
    const a = [0x01];
    const b = [0x02, 0x40, 0x0b];
    const c = [0x41, 0x00, 0x1a];
    const before = writeWasm(moduleWithFunctions([a, b, c]));
    const after = writeWasm(moduleWithFunctions([c, a, b]));

    const comparison = compareComplexity(before, after).comparison;
    expect(comparison.increased).toEqual([]);
    expect(comparison.decreased).toEqual([]);
    expect(comparison.changed).toEqual([]);
    expect(comparison.added).toEqual([]);
    expect(comparison.removed).toEqual([]);
    expect(comparison.unchanged).toEqual([0, 1, 2]);
  });

  it('tracks a real complexity change by stable export name', () => {
    const before = writeWasm(moduleWithFunctions([[0x01]], { 0: 'run' }));
    const after = writeWasm(moduleWithFunctions([[0x02, 0x40, 0x0b]], { 0: 'run' }));

    const comparison = compareComplexity(before, after).comparison;
    expect(comparison.increased).toHaveLength(1);
    expect(comparison.increased[0].complexityScore).toBeGreaterThan(0);
    expect(comparison.added).toEqual([]);
    expect(comparison.removed).toEqual([]);
  });

  it('tracks a changed unexported function when its type match is unambiguous', () => {
    const before = writeWasm(moduleWithFunctions([[0x01]]));
    const after = writeWasm(moduleWithFunctions([[0x02, 0x40, 0x0b]]));

    const comparison = compareComplexity(before, after).comparison;
    expect(comparison.increased).toHaveLength(1);
    expect(comparison.increased[0].functionIndex).toBe(0);
    expect(comparison.added).toEqual([]);
    expect(comparison.removed).toEqual([]);
  });

  it('does not guess identity for changed unexported functions that only share a type', () => {
    const before = writeWasm(moduleWithFunctions([[0x01], [0x01]]));
    const after = writeWasm(
      moduleWithFunctions([
        [0x02, 0x40, 0x0b],
        [0x03, 0x40, 0x0b],
      ]),
    );

    const comparison = compareComplexity(before, after).comparison;
    expect(comparison.increased).toEqual([]);
    expect(comparison.decreased).toEqual([]);
    expect(comparison.changed).toEqual([]);
    expect(comparison.added.map((fn) => fn.functionIndex)).toEqual([0, 1]);
    expect(comparison.removed.map((fn) => fn.functionIndex)).toEqual([0, 1]);
  });

  it('keeps comparison JSON ordering deterministic', () => {
    const before = writeWasm(moduleWithFunctions([[0x01], [0x02, 0x40, 0x0b]]));
    const after = writeWasm(moduleWithFunctions([[0x41, 0x00, 0x1a], [0x01], [0x02, 0x40, 0x0b]]));

    const first = compareComplexity(before, after);
    const second = compareComplexity(before, after);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.comparison.added.map((fn) => fn.functionIndex)).toEqual([0]);
  });

  it('reports identical duplicate functions as unchanged rather than added and removed', () => {
    const duplicate = [0x01];
    const file = writeWasm(moduleWithFunctions([duplicate, duplicate, duplicate]));

    const comparison = compareComplexity(file, file).comparison;
    expect(comparison.increased).toEqual([]);
    expect(comparison.decreased).toEqual([]);
    expect(comparison.changed).toEqual([]);
    expect(comparison.added).toEqual([]);
    expect(comparison.removed).toEqual([]);
    expect(comparison.unchanged).toEqual([0, 1, 2]);
  });

  it('pairs duplicate groups deterministically and leaves only the count difference unmatched', () => {
    const duplicate = [0x01];
    const other = [0x02, 0x40, 0x0b];
    const fewer = writeWasm(moduleWithFunctions([duplicate, other, duplicate]));
    const more = writeWasm(moduleWithFunctions([duplicate, duplicate, other, duplicate]));

    const added = compareComplexity(fewer, more).comparison;
    expect(added.increased).toEqual([]);
    expect(added.decreased).toEqual([]);
    expect(added.changed).toEqual([]);
    expect(added.added).toHaveLength(1);
    expect(added.added[0].functionIndex).toBe(3);
    expect(added.removed).toEqual([]);
    expect(added.unchanged).toEqual([0, 1, 2]);

    const removed = compareComplexity(more, fewer).comparison;
    expect(removed.increased).toEqual([]);
    expect(removed.decreased).toEqual([]);
    expect(removed.changed).toEqual([]);
    expect(removed.added).toEqual([]);
    expect(removed.removed).toHaveLength(1);
    expect(removed.removed[0].functionIndex).toBe(3);
    expect(removed.unchanged).toEqual([0, 1, 2]);
  });

  it('handles a large valid module without spreading all function scores into Math.max', () => {
    const count = 70_000;
    const body = [0x01];
    const file = writeWasm(moduleWithFunctions(Array.from({ length: count }, () => body)));

    const report = analyzeComplexity(file);
    expect(report.statistics.definedFunctionCount).toBe(count);
    expect(report.statistics.maximumComplexityScore).toBe(4);
    expect(report.statistics.totalComplexityScore).toBe(count * 4);
  });

  it('compares duplicate-heavy modules without false changes', () => {
    const count = 10_000;
    const duplicate = [0x01];
    const before = writeWasm(moduleWithFunctions(Array.from({ length: count }, () => duplicate)));
    const after = writeWasm(
      moduleWithFunctions(Array.from({ length: count + 1 }, () => duplicate)),
    );

    const comparison = compareComplexity(before, after).comparison;
    expect(comparison.increased).toEqual([]);
    expect(comparison.decreased).toEqual([]);
    expect(comparison.changed).toEqual([]);
    expect(comparison.unchanged).toHaveLength(count);
    expect(comparison.added).toHaveLength(1);
    expect(comparison.removed).toEqual([]);
  });

  it('rejects malformed function bodies and unsupported instructions clearly', () => {
    const missingEnd = writeWasm(moduleWithBody([0x01], false));
    const unsupportedSimd = writeWasm(moduleWithBody([0xfd, 0x00]));
    const invalidLocalIndex = writeWasm(moduleWithBody([0x20, 0x01]));

    expect(() => analyzeComplexity(missingEnd)).toThrow(WasmValidationError);
    expect(() => analyzeComplexity(missingEnd)).toThrow(/missing its final end/);
    expect(() => analyzeComplexity(unsupportedSimd)).toThrow(/Unsupported prefixed instruction/);
    expect(() => analyzeComplexity(invalidLocalIndex)).toThrow(WasmValidationError);
    expect(() => analyzeComplexity(invalidLocalIndex)).toThrow(/structural validation failed/);
  });

  it('exposes JSON output through the wasm-complexity CLI without executing code', async () => {
    const file = writeWasm(moduleWithBody(COMPLEX_INSTRUCTIONS));
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const instantiate = jest.spyOn(WebAssembly, 'instantiate');
    try {
      await expect(
        runInspectorCli(['wasm-complexity', file, '--json', '--threshold', '20']),
      ).resolves.toBe(0);
      const parsed = JSON.parse(String(log.mock.calls[0][0]));
      expect(parsed.functions[0]).toMatchObject({ complexityScore: 21, highlighted: true });
      expect(instantiate).not.toHaveBeenCalled();
    } finally {
      instantiate.mockRestore();
      log.mockRestore();
    }
  });

  it('supports an explicit comparison file independently of option order', async () => {
    const before = writeWasm(moduleWithBody([0x01]));
    const after = writeWasm(moduleWithBody(COMPLEX_INSTRUCTIONS));
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await expect(
        runInspectorCli(['wasm-complexity', '--compare', after, before, '--json']),
      ).resolves.toBe(0);
      const parsed = JSON.parse(String(log.mock.calls[0][0]));
      expect(parsed.before.file).toBe(before);
      expect(parsed.after.file).toBe(after);
      expect(parsed.comparison.aggregateDelta.complexityScore).toBe(17);
    } finally {
      log.mockRestore();
    }
  });

  it('rejects invalid thresholds and unreadable files with clear validation errors', () => {
    const file = writeWasm(moduleWithBody([0x01]));

    expect(() => analyzeComplexity(file, { score: -1 })).toThrow(/non-negative number/);
    expect(() => analyzeComplexity(`${file}.missing`)).toThrow(/Unable to read WASM file/);
  });

  it('rejects an empty CLI threshold value', async () => {
    const file = writeWasm(moduleWithBody([0x01]));
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(runInspectorCli(['wasm-complexity', file, '--threshold='])).resolves.toBe(1);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('requires a non-negative number'));
    } finally {
      error.mockRestore();
    }
  });
});
