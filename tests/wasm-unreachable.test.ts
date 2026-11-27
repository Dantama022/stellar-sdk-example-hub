/**
 * tests/wasm-unreachable.test.ts
 *
 * Unit tests for the offline WASM unreachable-path analysis (ISSUE-273).
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  WasmUnreachableValidationError,
  analyzeWasmUnreachable,
  compareUnreachableReports,
} from '../src/utils/wasm-unreachable';
import {
  compareUnreachableFiles,
  parseUnreachableArgs,
  run,
  toCsv,
} from '../src/examples/273-wasm-unreachable';

// ---------------------------------------------------------------------------
// Binary building helpers
// ---------------------------------------------------------------------------

function u32le(value: number): number[] {
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

function sleb32(value: number): number[] {
  const bytes: number[] = [];
  let current = value | 0;
  let more = true;
  while (more) {
    let byte = current & 0x7f;
    current >>= 7;
    const signBit = (byte & 0x40) !== 0;
    more = !((current === 0 && !signBit) || (current === -1 && signBit));
    if (more) byte |= 0x80;
    bytes.push(byte);
  }
  return bytes;
}

function section(id: number, payload: number[]): number[] {
  return [id, ...u32le(payload.length), ...payload];
}

const WASM_HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

function encodeString(value: string): number[] {
  const bytes = Buffer.from(value, 'utf8');
  return [...u32le(bytes.length), ...bytes];
}

function buildWasm(
  bodies: number[][],
  options: {
    exports?: Map<number, string>;
    start?: number;
  } = {},
): Buffer {
  const typeCount = bodies.length;
  const sections: number[] = [
    ...WASM_HEADER,
    ...section(1, [typeCount, ...bodies.flatMap(() => [0x60, 0x00, 0x00])]),
    ...section(3, [typeCount, ...new Array(typeCount).fill(0x00)]),
  ];

  if (options.exports && options.exports.size > 0) {
    const payload: number[] = [options.exports.size];
    for (const [index, name] of options.exports) {
      payload.push(...encodeString(name), 0x00, ...u32le(index));
    }
    sections.push(...section(7, payload));
  }

  if (options.start !== undefined) {
    sections.push(...section(8, u32le(options.start)));
  }

  const codePayload: number[] = [typeCount];
  for (const body of bodies) {
    const full = [0x00, ...body, 0x0b];
    codePayload.push(...u32le(full.length), ...full);
  }
  sections.push(...section(10, codePayload));

  return Buffer.from(sections);
}

function tmpFile(buf: Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wasm-unreachable-'));
  const file = path.join(dir, 'test.wasm');
  fs.writeFileSync(file, buf);
  return file;
}

function singleFn(code: number[]): string {
  return tmpFile(buildWasm([code]));
}

// ---------------------------------------------------------------------------
// Opcodes and helpers
// ---------------------------------------------------------------------------

const NOP = 0x01;
const UNREACHABLE = 0x00;
const BLOCK = 0x02;
const LOOP = 0x03;
const IF = 0x04;
const ELSE = 0x05;
const END = 0x0b;
const BR = 0x0c;
const BR_IF = 0x0d;
const BR_TABLE = 0x0e;
const RETURN = 0x0f;
const CALL = 0x10;
const EMPTY_BLOCK_TYPE = 0x40;
const DROP = 0x1a;
const I32_CONST = 0x41;

function i32Const(value: number): number[] {
  return [I32_CONST, ...sleb32(value)];
}

function br(depth: number): number[] {
  return [BR, ...u32le(depth)];
}

function brIf(depth: number): number[] {
  return [BR_IF, ...u32le(depth)];
}

function brTable(depths: number[], defaultDepth: number): number[] {
  return [BR_TABLE, ...u32le(depths.length), ...depths.flatMap(u32le), ...u32le(defaultDepth)];
}

function call(index: number): number[] {
  return [CALL, ...u32le(index)];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('wasm-unreachable', () => {
  describe('basic reachability', () => {
    it('reports no unreachable code for a straight-line function', () => {
      const file = singleFn([...i32Const(1), DROP]);
      const report = analyzeWasmUnreachable(file);
      const summary = report.functions[0];

      expect(summary.totalInstructions).toBeGreaterThan(0);
      expect(summary.unreachableInstructions).toBe(0);
      expect(summary.hasUnreachableCode).toBe(false);
      expect(report.unreachableRanges).toHaveLength(0);
      expect(report.statistics.unreachableCodePercentage).toBe(0);
    });

    it('detects code after an unconditional branch', () => {
      const file = singleFn([BLOCK, EMPTY_BLOCK_TYPE, ...br(0), NOP, END]);
      const report = analyzeWasmUnreachable(file);

      expect(report.statistics.totalUnreachableInstructions).toBeGreaterThan(0);
      const unreachable = report.unreachableInstructions.find(
        (instruction) => instruction.opcode === 'nop',
      );
      expect(unreachable).toBeDefined();
      expect(unreachable?.reason).toBe('unconditional-branch');
      expect(unreachable?.functionIndex).toBe(0);
      expect(typeof unreachable?.blockIndex).toBe('number');
    });

    it('detects code after a return', () => {
      const file = singleFn([RETURN, NOP]);
      const report = analyzeWasmUnreachable(file);
      const unreachable = report.unreachableInstructions.find(
        (instruction) => instruction.opcode === 'nop',
      );

      expect(unreachable?.reason).toBe('return');
      expect(report.unreachableRanges.length).toBeGreaterThan(0);
    });

    it('detects code after an unreachable/trap instruction', () => {
      const file = singleFn([UNREACHABLE, NOP]);
      const report = analyzeWasmUnreachable(file);
      const unreachable = report.unreachableInstructions.find(
        (instruction) => instruction.opcode === 'nop',
      );

      expect(unreachable?.reason).toBe('unreachable-trap');
    });

    it('detects unreachable code inside nested blocks', () => {
      const file = singleFn([
        BLOCK,
        EMPTY_BLOCK_TYPE,
        BLOCK,
        EMPTY_BLOCK_TYPE,
        ...br(1),
        NOP,
        END,
        NOP,
        END,
        NOP,
      ]);
      const report = analyzeWasmUnreachable(file);

      expect(report.statistics.totalUnreachableInstructions).toBeGreaterThan(0);
      expect(report.unreachableRanges.length).toBeGreaterThan(0);
      expect(report.functions[0].hasUnreachableCode).toBe(true);
    });

    it('detects unreachable code in a loop after an unconditional back-edge', () => {
      const file = singleFn([LOOP, EMPTY_BLOCK_TYPE, ...br(0), NOP, END]);
      const report = analyzeWasmUnreachable(file);
      const unreachable = report.unreachableInstructions.find(
        (instruction) => instruction.opcode === 'nop',
      );

      expect(unreachable).toBeDefined();
      expect(unreachable?.reason).toBe('unconditional-branch');
    });

    it('handles branch-table control flow', () => {
      const file = singleFn([BLOCK, EMPTY_BLOCK_TYPE, ...brTable([0], 0), NOP, END]);
      const report = analyzeWasmUnreachable(file);
      const unreachable = report.unreachableInstructions.find(
        (instruction) => instruction.opcode === 'nop',
      );

      expect(unreachable?.reason).toBe('unconditional-branch');
    });

    it('reports partially unreachable instruction ranges', () => {
      const file = singleFn([RETURN, NOP, NOP]);
      const report = analyzeWasmUnreachable(file);
      const range = report.unreachableRanges[0];

      expect(range.startInstructionIndex).toBeGreaterThan(0);
      expect(range.endInstructionIndex).toBeGreaterThanOrEqual(range.startInstructionIndex);
      expect(range.instructionCount).toBeGreaterThan(0);
      expect(range.startOffset).toBeLessThan(range.endOffset);
    });

    it('detects multiple unreachable regions in one function', () => {
      const file = singleFn([BLOCK, EMPTY_BLOCK_TYPE, ...br(0), NOP, END, RETURN, NOP]);
      const report = analyzeWasmUnreachable(file);

      expect(report.unreachableRanges.length).toBeGreaterThanOrEqual(2);
      expect(report.functions[0].unreachableBlocks).toBeGreaterThanOrEqual(2);
    });

    it('preserves the reachable path through conditional branches', () => {
      const file = singleFn([BLOCK, EMPTY_BLOCK_TYPE, ...i32Const(1), ...brIf(0), NOP, END]);
      const report = analyzeWasmUnreachable(file);

      expect(report.statistics.totalUnreachableInstructions).toBe(0);
      expect(report.functions[0].unreachableBlocks).toBe(0);
    });

    it('preserves reachable paths through if/else', () => {
      const file = singleFn([...i32Const(1), IF, EMPTY_BLOCK_TYPE, NOP, ELSE, NOP, END, NOP]);
      const report = analyzeWasmUnreachable(file);

      expect(report.statistics.totalUnreachableInstructions).toBe(0);
    });
  });

  describe('module-level reachability', () => {
    it('identifies entirely unreachable functions when exports exist', () => {
      const file = tmpFile(buildWasm([[NOP], [NOP]], { exports: new Map([[0, 'main']]) }));
      const report = analyzeWasmUnreachable(file);

      expect(report.statistics.entirelyUnreachableFunctions).toContain(1);
      const fn1 = report.functions.find((summary) => summary.functionIndex === 1);
      expect(fn1?.moduleReachable).toBe(false);
      expect(fn1?.entirelyUnreachable).toBe(true);
    });

    it('treats all functions as roots when no exports are present', () => {
      const file = tmpFile(buildWasm([[NOP], [NOP]]));
      const report = analyzeWasmUnreachable(file);

      expect(report.statistics.entirelyUnreachableFunctions).toHaveLength(0);
    });

    it('follows direct calls from an exported root', () => {
      const file = tmpFile(
        buildWasm([[NOP], [NOP], [...call(1), NOP]], {
          exports: new Map([[2, 'entry']]),
        }),
      );
      const report = analyzeWasmUnreachable(file);

      expect(report.statistics.entirelyUnreachableFunctions).not.toContain(1);
      expect(report.statistics.entirelyUnreachableFunctions).toContain(0);
    });
  });

  describe('statistics and output formats', () => {
    it('calculates per-function and aggregate statistics', () => {
      const file = tmpFile(buildWasm([[RETURN, NOP], [NOP]]));
      const report = analyzeWasmUnreachable(file);
      const fn0 = report.functions.find((summary) => summary.functionIndex === 0);

      expect(fn0?.unreachableInstructions).toBeGreaterThan(0);
      expect(fn0?.unreachablePercentage).toBeGreaterThan(0);
      expect(report.statistics.functionsContainingUnreachableRegions).toBe(1);
      expect(report.statistics.largestUnreachableRegion?.functionIndex).toBe(0);
    });

    it('produces valid JSON through run()', async () => {
      const file = singleFn([RETURN, NOP]);
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (message: string) => logs.push(message);
      try {
        await run({ wasmFile: file, json: true });
      } finally {
        console.log = originalLog;
      }
      const parsed = JSON.parse(logs.join(''));
      expect(parsed.valid).toBe(true);
      expect(parsed.unreachableRanges.length).toBeGreaterThan(0);
      expect(parsed.statistics.totalUnreachableInstructions).toBeGreaterThan(0);
    });

    it('produces CSV with one row per unreachable range', () => {
      const file = singleFn([RETURN, NOP]);
      const report = analyzeWasmUnreachable(file);
      const lines = toCsv(report.unreachableRanges).split('\n');

      expect(lines[0]).toBe(
        'functionIndex,blockIndex,startInstructionIndex,endInstructionIndex,startOffset,endOffset,instructionCount,reason',
      );
      expect(lines.length).toBe(report.unreachableRanges.length + 1);
      expect(lines[1]).toContain('return');
    });

    it('produces only a CSV header when there are no unreachable ranges', () => {
      const file = singleFn([NOP]);
      const report = analyzeWasmUnreachable(file);
      expect(toCsv(report.unreachableRanges).split('\n')).toHaveLength(1);
    });

    it('prints human-readable output by default', async () => {
      const file = singleFn([RETURN, NOP]);
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (message: string) => logs.push(message);
      try {
        await run({ wasmFile: file });
      } finally {
        console.log = originalLog;
      }
      expect(logs.join('\n')).toContain('WASM Unreachable Path Analysis');
    });

    it('throws a usage error when no file is provided', async () => {
      await expect(run({})).rejects.toThrow(/Usage/);
    });

    it('parses CLI arguments', () => {
      expect(parseUnreachableArgs(['a.wasm', 'b.wasm', '--json', '--csv'])).toEqual({
        wasmFile: 'a.wasm',
        compareFile: 'b.wasm',
        json: true,
        csv: true,
      });
      expect(() => parseUnreachableArgs(['a.wasm', 'b.wasm', 'c.wasm'])).toThrow(/Usage/);
    });
  });

  describe('two-artifact comparison', () => {
    it('detects newly unreachable regions and functions with new unreachable code', () => {
      const before = singleFn([NOP]);
      const after = singleFn([RETURN, NOP]);
      const result = compareUnreachableFiles(before, after);

      expect(result.comparison.newlyUnreachableRegions.length).toBeGreaterThan(0);
      expect(result.comparison.functionsWithNewUnreachableCode).toContain(0);
      expect(result.comparison.totalUnreachableInstructionDelta).toBeGreaterThan(0);
    });

    it('detects regions that became reachable', () => {
      const before = singleFn([RETURN, NOP]);
      const after = singleFn([NOP]);
      const result = compareUnreachableReports(before, after);

      expect(result.comparison.regionsThatBecameReachable.length).toBeGreaterThan(0);
      expect(result.comparison.totalUnreachableInstructionDelta).toBeLessThan(0);
    });

    it('reports no changes for identical artifacts', () => {
      const file = singleFn([RETURN, NOP]);
      const result = compareUnreachableReports(file, file);

      expect(result.comparison.newlyUnreachableRegions).toHaveLength(0);
      expect(result.comparison.regionsThatBecameReachable).toHaveLength(0);
      expect(result.comparison.changedRangeBoundaries).toHaveLength(0);
      expect(result.comparison.functionsWithNewUnreachableCode).toHaveLength(0);
    });
  });

  describe('robustness', () => {
    it('throws WasmUnreachableValidationError for malformed magic bytes', () => {
      const file = tmpFile(Buffer.from([0x00, 0x61, 0x73, 0x00, 0x01, 0x00, 0x00, 0x00]));
      expect(() => analyzeWasmUnreachable(file)).toThrow(WasmUnreachableValidationError);
    });

    it('throws WasmUnreachableValidationError for truncated input', () => {
      const file = tmpFile(Buffer.from([0x00, 0x61]));
      expect(() => analyzeWasmUnreachable(file)).toThrow(WasmUnreachableValidationError);
    });

    it('throws WasmUnreachableValidationError for a missing file', () => {
      expect(() => analyzeWasmUnreachable('/nonexistent/unreachable.wasm')).toThrow(
        WasmUnreachableValidationError,
      );
    });

    it('reports malformed else control flow without crashing', () => {
      const file = singleFn([ELSE, NOP]);
      const report = analyzeWasmUnreachable(file);

      expect(report.valid).toBe(true);
      expect(report.warnings.some((warning) => warning.includes('else'))).toBe(true);
    });

    it('reports an out-of-range branch depth without crashing', () => {
      const file = singleFn([...br(5), NOP]);
      const report = analyzeWasmUnreachable(file);

      expect(report.valid).toBe(true);
      expect(report.warnings.some((warning) => warning.includes('branch depth'))).toBe(true);
    });

    it('does not crash on an unsupported SIMD prefix', () => {
      const file = singleFn([0xfd, NOP]);
      const report = analyzeWasmUnreachable(file);

      expect(report.warnings.length).toBeGreaterThan(0);
      expect(report.warnings[0]).toContain('SIMD');
    });

    it('is deterministic across repeated runs', () => {
      const file = singleFn([RETURN, NOP, NOP]);
      const first = analyzeWasmUnreachable(file);
      const second = analyzeWasmUnreachable(file);
      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    });

    it('never executes WASM and still analyzes an infinite loop', () => {
      const file = singleFn([LOOP, EMPTY_BLOCK_TYPE, ...br(0), END]);
      const report = analyzeWasmUnreachable(file);

      expect(report.valid).toBe(true);
      expect(report.statistics.totalFunctions).toBe(1);
    });
  });
});
