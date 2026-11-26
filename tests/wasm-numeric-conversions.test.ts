/**
 * tests/wasm-numeric-conversions.test.ts
 *
 * Unit tests for the offline WASM numeric conversion analysis (ISSUE-269).
 *
 * Every test uses in-memory Buffer fixtures written to temporary files. No
 * network access is required and no WASM instruction is ever executed.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  WasmValidationError,
  analyzeNumericConversions,
  compareNumericConversionsReports,
} from '../src/utils/wasm-static-analysis';
import {
  compareNumericConversionsFiles,
  parseNumericConversionArgs,
  run,
  toCsv,
} from '../src/examples/269-wasm-numeric-conversions';

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

function section(id: number, payload: number[]): number[] {
  return [id, ...u32le(payload.length), ...payload];
}

const WASM_HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

function buildWasm(bodies: number[][]): Buffer {
  const typeCount = bodies.length;
  const typeSection = section(1, [
    typeCount,
    ...Array.from({ length: typeCount }, () => [0x60, 0x00, 0x00]).flat(),
  ]);
  const funcSection = section(3, [typeCount, ...Array(typeCount).fill(0x00)]);

  const codeBodies: number[] = [typeCount];
  for (const body of bodies) {
    const full = [0x00, ...body];
    codeBodies.push(...u32le(full.length), ...full);
  }
  const codeSection = section(10, codeBodies);

  return Buffer.from([...WASM_HEADER, ...typeSection, ...funcSection, ...codeSection]);
}

function writeTmp(buf: Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wasm-numeric-conversions-'));
  const file = path.join(dir, 'test.wasm');
  fs.writeFileSync(file, buf);
  return file;
}

// ---------------------------------------------------------------------------
// Opcode constants
// ---------------------------------------------------------------------------

const END = 0x0b;
const BLOCK = 0x02;
const EMPTY_BLOCK_TYPE = 0x40;
const UNREACHABLE = 0x00;
const NOP = 0x01;
const I32_CONST = 0x41;
const I32_ADD = 0x6a;

const I32_WRAP_I64 = 0xa7;
const I32_TRUNC_F32_S = 0xa8;
const I32_TRUNC_F32_U = 0xa9;
const I32_TRUNC_F64_S = 0xaa;
const I32_TRUNC_F64_U = 0xab;
const I64_TRUNC_F32_S = 0xae;
const I64_TRUNC_F32_U = 0xaf;
const I64_TRUNC_F64_S = 0xb0;
const I64_TRUNC_F64_U = 0xb1;
const I64_EXTEND_I32_S = 0xac;
const I64_EXTEND_I32_U = 0xad;
const F32_CONVERT_I32_S = 0xb2;
const F32_CONVERT_I32_U = 0xb3;
const F32_CONVERT_I64_S = 0xb4;
const F32_CONVERT_I64_U = 0xb5;
const F64_CONVERT_I32_S = 0xb7;
const F64_CONVERT_I32_U = 0xb8;
const F64_CONVERT_I64_S = 0xb9;
const F64_CONVERT_I64_U = 0xba;
const F32_DEMOTE_F64 = 0xb6;
const F64_PROMOTE_F32 = 0xbb;
const I32_REINTERPRET_F32 = 0xbc;
const I64_REINTERPRET_F64 = 0xbd;
const F32_REINTERPRET_I32 = 0xbe;
const F64_REINTERPRET_I64 = 0xbf;
const I32_EXTEND8_S = 0xc0;
const I32_EXTEND16_S = 0xc1;
const I64_EXTEND8_S = 0xc2;
const I64_EXTEND16_S = 0xc3;
const I64_EXTEND32_S = 0xc4;
const FC_PREFIX = 0xfc;
const SIMD_PREFIX = 0xfd;
const SAT_I32_F32_S = [FC_PREFIX, 0x00];
const SAT_I32_F32_U = [FC_PREFIX, 0x01];
const SAT_I32_F64_S = [FC_PREFIX, 0x02];
const SAT_I32_F64_U = [FC_PREFIX, 0x03];
const SAT_I64_F32_S = [FC_PREFIX, 0x04];
const SAT_I64_F32_U = [FC_PREFIX, 0x05];
const SAT_I64_F64_S = [FC_PREFIX, 0x06];
const SAT_I64_F64_U = [FC_PREFIX, 0x07];

function singleFnWasm(instructions: number[]): string {
  return writeTmp(buildWasm([[...instructions, END]]));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('wasm-numeric-conversions', () => {
  describe('conversion classes', () => {
    it('detects integer extension as widening', () => {
      const file = singleFnWasm([I64_EXTEND_I32_S, I64_EXTEND_I32_U]);
      const report = analyzeNumericConversions(file);

      expect(report.statistics.totalNumericConversions).toBe(2);
      expect(report.statistics.conversionsByCategory['integer-extension']).toBe(2);
      expect(report.statistics.wideningConversions).toBe(2);
      expect(report.statistics.narrowingConversions).toBe(0);
      for (const record of report.records) {
        expect(record.sourceType).toBe('i32');
        expect(record.destinationType).toBe('i64');
        expect(record.widening).toBe(true);
        expect(record.diagnostics).toContain('widening');
        expect(record.diagnostics).not.toContain('lossy');
      }
    });

    it('detects integer truncation as narrowing that may discard high-order bits', () => {
      const file = singleFnWasm([I32_WRAP_I64]);
      const report = analyzeNumericConversions(file);
      const record = report.records[0];

      expect(record.category).toBe('integer-truncation');
      expect(record.sourceType).toBe('i64');
      expect(record.destinationType).toBe('i32');
      expect(record.narrowing).toBe(true);
      expect(record.mayDiscardHighOrderBits).toBe(true);
      expect(record.mayLosePrecision).toBe(true);
      expect(record.diagnostics).toEqual(
        expect.arrayContaining(['lossy', 'representation-change']),
      );
      expect(report.statistics.narrowingConversions).toBe(1);
      expect(report.statistics.highOrderBitDiscardConversions).toBe(1);
    });

    it('detects every sign-extension instruction', () => {
      const file = singleFnWasm([
        I32_EXTEND8_S,
        I32_EXTEND16_S,
        I64_EXTEND8_S,
        I64_EXTEND16_S,
        I64_EXTEND32_S,
      ]);
      const report = analyzeNumericConversions(file);

      expect(report.statistics.conversionsByCategory['sign-extension']).toBe(5);
      for (const record of report.records) {
        expect(record.category).toBe('sign-extension');
        expect(record.mayDiscardHighOrderBits).toBe(true);
        expect(record.sourceSignedness).toBe('signed');
        expect(record.destinationSignedness).toBe('signed');
      }
    });

    it('detects integer-to-floating-point conversions and their precision risk', () => {
      const file = singleFnWasm([
        F32_CONVERT_I32_S,
        F32_CONVERT_I32_U,
        F32_CONVERT_I64_S,
        F32_CONVERT_I64_U,
        F64_CONVERT_I32_S,
        F64_CONVERT_I32_U,
        F64_CONVERT_I64_S,
        F64_CONVERT_I64_U,
      ]);
      const report = analyzeNumericConversions(file);

      expect(report.statistics.conversionsByCategory['int-to-float']).toBe(8);
      const f32I32 = report.records.find((record) => record.opcode === 'f32.convert_i32_s');
      const f64I32 = report.records.find((record) => record.opcode === 'f64.convert_i32_s');
      const f64I64 = report.records.find((record) => record.opcode === 'f64.convert_i64_s');

      expect(f32I32?.mayLosePrecision).toBe(true);
      expect(f64I32?.mayLosePrecision).toBe(false);
      expect(f64I32?.exact).toBe(true);
      expect(f64I64?.mayLosePrecision).toBe(true);
      expect(f32I32?.sourceSignedness).toBe('signed');
      expect(f32I32?.destinationType).toBe('f32');
    });

    it('detects floating-point widening and narrowing', () => {
      const file = singleFnWasm([F64_PROMOTE_F32, F32_DEMOTE_F64]);
      const report = analyzeNumericConversions(file);

      const promote = report.records.find((record) => record.opcode === 'f64.promote_f32');
      const demote = report.records.find((record) => record.opcode === 'f32.demote_f64');

      expect(promote?.category).toBe('float-widening');
      expect(promote?.widening).toBe(true);
      expect(promote?.exact).toBe(true);
      expect(demote?.category).toBe('float-narrowing');
      expect(demote?.narrowing).toBe(true);
      expect(demote?.mayLosePrecision).toBe(true);
      expect(report.statistics.wideningConversions).toBe(1);
      expect(report.statistics.narrowingConversions).toBe(1);
    });

    it('distinguishes trapping float-to-integer conversions from saturating conversions', () => {
      const file = singleFnWasm([
        I32_TRUNC_F32_S,
        I32_TRUNC_F32_U,
        I32_TRUNC_F64_S,
        I32_TRUNC_F64_U,
        I64_TRUNC_F32_S,
        I64_TRUNC_F32_U,
        I64_TRUNC_F64_S,
        I64_TRUNC_F64_U,
        ...SAT_I32_F32_S,
        ...SAT_I32_F32_U,
        ...SAT_I32_F64_S,
        ...SAT_I32_F64_U,
        ...SAT_I64_F32_S,
        ...SAT_I64_F32_U,
        ...SAT_I64_F64_S,
        ...SAT_I64_F64_U,
      ]);
      const report = analyzeNumericConversions(file);

      expect(report.statistics.conversionsByCategory['float-to-int']).toBe(8);
      expect(report.statistics.conversionsByCategory['saturating-conversion']).toBe(8);
      expect(report.statistics.trappingConversions).toBe(8);
      expect(report.statistics.saturatingConversions).toBe(8);
      for (const record of report.records) {
        if (record.category === 'float-to-int') {
          expect(record.trapping).toBe(true);
          expect(record.saturating).toBe(false);
        } else {
          expect(record.category).toBe('saturating-conversion');
          expect(record.trapping).toBe(false);
          expect(record.saturating).toBe(true);
        }
      }
    });

    it('classifies all reinterpretation instructions', () => {
      const file = singleFnWasm([
        I32_REINTERPRET_F32,
        I64_REINTERPRET_F64,
        F32_REINTERPRET_I32,
        F64_REINTERPRET_I64,
      ]);
      const report = analyzeNumericConversions(file);

      expect(report.statistics.conversionsByCategory.reinterpretation).toBe(4);
      for (const record of report.records) {
        expect(record.category).toBe('reinterpretation');
        expect(record.diagnostics).toContain('reinterpretation');
        expect(record.diagnostics).toContain('representation-change');
        expect(record.mayLosePrecision).toBe(false);
      }
    });

    it('records stable function, block, instruction, and byte locations', () => {
      const file = writeTmp(buildWasm([[BLOCK, EMPTY_BLOCK_TYPE, I32_WRAP_I64, END, END]]));
      const report = analyzeNumericConversions(file);
      const record = report.records[0];

      expect(record.functionIndex).toBe(0);
      expect(record.blockIndex).toBe(1);
      expect(record.instructionIndex).toBe(1);
      expect(typeof record.instructionOffset).toBe('number');
      expect(record.instructionOffset).toBeGreaterThanOrEqual(1);
    });
  });

  describe('statistics', () => {
    it('reports zero counts for a module without numeric conversions', () => {
      const file = singleFnWasm([I32_CONST, 0x01, I32_CONST, 0x02, I32_ADD]);
      const report = analyzeNumericConversions(file);

      expect(report.valid).toBe(true);
      expect(report.statistics.totalNumericConversions).toBe(0);
      expect(report.statistics.functionsWithConversions).toBe(0);
      expect(report.statistics.highestConversionDensityFunction).toBeNull();
      expect(report.records).toHaveLength(0);
    });

    it('computes per-function conversion density and highest-density functions', () => {
      const file = writeTmp(
        buildWasm([
          [NOP, I32_WRAP_I64, END],
          [I64_EXTEND_I32_S, F64_CONVERT_I64_S, I32_TRUNC_F64_S, END],
          [I32_CONST, 0x01, I32_ADD, END],
        ]),
      );
      const report = analyzeNumericConversions(file);

      const fn0 = report.functions.find((summary) => summary.functionIndex === 0);
      const fn1 = report.functions.find((summary) => summary.functionIndex === 1);
      expect(fn0?.totalConversions).toBe(1);
      expect(fn0?.totalInstructions).toBe(3);
      expect(fn1?.totalConversions).toBe(3);
      expect(fn1?.conversionDensity).toBeGreaterThan(fn0!.conversionDensity);
      expect(report.statistics.highestConversionDensityFunctions[0].functionIndex).toBe(1);
      expect(report.statistics.highestConversionDensityFunction?.functionIndex).toBe(1);
    });

    it('handles an empty module without a code section', () => {
      const file = writeTmp(Buffer.from(WASM_HEADER));
      const report = analyzeNumericConversions(file);

      expect(report.valid).toBe(true);
      expect(report.records).toHaveLength(0);
      expect(report.functions).toHaveLength(0);
      expect(report.chains).toHaveLength(0);
    });
  });

  describe('conversion chains', () => {
    it('detects a redundant widen then narrow round trip', () => {
      const file = singleFnWasm([I64_EXTEND_I32_S, I32_WRAP_I64]);
      const report = analyzeNumericConversions(file);

      expect(report.chains).toHaveLength(1);
      const chain = report.chains[0];
      expect(chain.length).toBe(2);
      expect(chain.patterns).toContain('widen->narrow');
      expect(chain.redundant).toBe(true);
      expect(chain.suspicious).toBe(true);
      expect(report.statistics.redundantChainCount).toBe(1);
    });

    it('detects a narrow then widen round trip', () => {
      const file = singleFnWasm([I32_WRAP_I64, I64_EXTEND_I32_S]);
      const report = analyzeNumericConversions(file);

      expect(report.chains[0].patterns).toContain('narrow->widen');
      expect(report.chains[0].redundant).toBe(true);
    });

    it('detects integer to float to integer chains', () => {
      const file = singleFnWasm([F32_CONVERT_I32_S, I32_TRUNC_F32_S]);
      const report = analyzeNumericConversions(file);

      expect(report.chains).toHaveLength(1);
      expect(report.chains[0].patterns).toContain('int->float->int');
      expect(report.chains[0].precisionLoss).toBe(true);
      expect(report.chains[0].redundant).toBe(true);
    });

    it('detects repeated signed/unsigned interpretation changes', () => {
      // f32 -> i32 (signed), then i32 -> i64 (unsigned)
      const file = singleFnWasm([I32_TRUNC_F32_S, I64_EXTEND_I32_U]);
      const report = analyzeNumericConversions(file);

      expect(report.chains[0].patterns).toContain('repeated-signed-unsigned');
      expect(report.chains[0].suspicious).toBe(true);
    });

    it('detects repeated conversion classes', () => {
      const file = singleFnWasm([I32_EXTEND8_S, I32_EXTEND16_S]);
      const report = analyzeNumericConversions(file);

      expect(report.chains[0].patterns).toContain('repeated-conversion');
      expect(report.chains[0].suspicious).toBe(true);
    });

    it('does not link non-adjacent conversions', () => {
      const file = singleFnWasm([I64_EXTEND_I32_S, NOP, I32_WRAP_I64]);
      const report = analyzeNumericConversions(file);

      expect(report.chains).toHaveLength(0);
      expect(report.statistics.conversionChainCount).toBe(0);
    });
  });

  describe('output formats', () => {
    it('produces valid JSON through run()', async () => {
      const file = singleFnWasm([I32_WRAP_I64, I64_EXTEND_I32_S]);
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
      expect(parsed.statistics.totalNumericConversions).toBe(2);
      expect(Array.isArray(parsed.records)).toBe(true);
      expect(Array.isArray(parsed.chains)).toBe(true);
    });

    it('produces CSV with one row per conversion', () => {
      const file = singleFnWasm([I32_WRAP_I64, F32_DEMOTE_F64]);
      const report = analyzeNumericConversions(file);
      const lines = toCsv(report.records).split('\n');

      expect(lines[0]).toBe(
        'functionIndex,blockIndex,instructionIndex,instructionOffset,opcode,sourceType,destinationType,category,sourceSignedness,destinationSignedness,widening,narrowing,mayDiscardHighOrderBits,mayLosePrecision,trapping,saturating,diagnostics',
      );
      expect(lines).toHaveLength(3);
      expect(lines[1]).toContain('i32.wrap_i64');
      expect(lines[2]).toContain('f32.demote_f64');
    });

    it('produces only a CSV header when there are no conversions', () => {
      const file = singleFnWasm([NOP]);
      const report = analyzeNumericConversions(file);
      const lines = toCsv(report.records).split('\n');
      expect(lines).toHaveLength(1);
    });

    it('prints human-readable output by default', async () => {
      const file = singleFnWasm([I32_WRAP_I64]);
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (message: string) => logs.push(message);
      try {
        await run({ wasmFile: file });
      } finally {
        console.log = originalLog;
      }
      expect(logs.join('\n')).toContain('WASM Numeric Conversion Analysis');
    });

    it('throws a usage error when no file is provided', async () => {
      await expect(run({})).rejects.toThrow(/Usage/);
    });

    it('parses CLI arguments', () => {
      expect(parseNumericConversionArgs(['a.wasm', 'b.wasm', '--json', '--csv'])).toEqual({
        wasmFile: 'a.wasm',
        compareFile: 'b.wasm',
        json: true,
        csv: true,
      });
      expect(() => parseNumericConversionArgs(['a.wasm', 'b.wasm', 'c.wasm'])).toThrow(/Usage/);
    });
  });

  describe('two-artifact comparison', () => {
    it('detects added and removed conversions', () => {
      const before = writeTmp(buildWasm([[END]]));
      const after = writeTmp(buildWasm([[I32_WRAP_I64, END]]));
      const added = compareNumericConversionsFiles(before, after);

      expect(added.comparison.addedConversions).toHaveLength(1);
      expect(added.comparison.removedConversions).toHaveLength(0);
      expect(added.comparison.totalConversionDelta).toBe(1);

      const removed = compareNumericConversionsReports(after, before);
      expect(removed.comparison.removedConversions).toHaveLength(1);
      expect(removed.comparison.addedConversions).toHaveLength(0);
      expect(removed.comparison.totalConversionDelta).toBe(-1);
    });

    it('detects changed types and categories at the same location', () => {
      const before = writeTmp(buildWasm([[I64_EXTEND_I32_S, END]]));
      const after = writeTmp(buildWasm([[I32_WRAP_I64, END]]));
      const result = compareNumericConversionsReports(before, after);

      expect(result.comparison.changedConversions).toHaveLength(1);
      const change = result.comparison.changedConversions[0];
      expect(change.changes).toEqual(
        expect.arrayContaining(['opcode', 'sourceType', 'destinationType', 'category']),
      );
      expect(change.before.category).toBe('integer-extension');
      expect(change.after.category).toBe('integer-truncation');
    });

    it('detects newly introduced narrowing and precision-loss patterns', () => {
      const before = writeTmp(buildWasm([[I64_EXTEND_I32_S, END]]));
      const after = writeTmp(buildWasm([[I32_WRAP_I64, END]]));
      const result = compareNumericConversionsReports(before, after);

      expect(result.comparison.newlyIntroducedNarrowing).toHaveLength(1);
      expect(result.comparison.newlyIntroducedPrecisionLoss).toHaveLength(1);
      expect(result.comparison.narrowingDelta).toBe(1);
      expect(result.comparison.precisionLossDelta).toBe(1);
      expect(result.comparison.categoryDeltas['integer-truncation']).toBe(1);
      expect(result.comparison.categoryDeltas['integer-extension']).toBe(-1);
    });

    it('detects newly introduced suspicious chains', () => {
      const before = writeTmp(buildWasm([[I64_EXTEND_I32_S, END]]));
      const after = writeTmp(buildWasm([[I64_EXTEND_I32_S, I32_WRAP_I64, END]]));
      const result = compareNumericConversionsReports(before, after);

      expect(result.comparison.newSuspiciousChains).toHaveLength(1);
      expect(result.comparison.newSuspiciousChains[0].patterns).toContain('widen->narrow');
    });

    it('reports no changes for identical artifacts', () => {
      const file = writeTmp(buildWasm([[I64_EXTEND_I32_S, I32_WRAP_I64, END]]));
      const result = compareNumericConversionsReports(file, file);

      expect(result.comparison.addedConversions).toHaveLength(0);
      expect(result.comparison.removedConversions).toHaveLength(0);
      expect(result.comparison.changedConversions).toHaveLength(0);
      expect(result.comparison.newSuspiciousChains).toHaveLength(0);
      expect(result.comparison.totalConversionDelta).toBe(0);
    });
  });

  describe('robustness', () => {
    it('throws WasmValidationError for malformed magic bytes', () => {
      const file = writeTmp(Buffer.from([0x00, 0x61, 0x73, 0x00, 0x01, 0x00, 0x00, 0x00]));
      expect(() => analyzeNumericConversions(file)).toThrow(WasmValidationError);
    });

    it('throws WasmValidationError for truncated input', () => {
      const file = writeTmp(Buffer.from([0x00, 0x61]));
      expect(() => analyzeNumericConversions(file)).toThrow(WasmValidationError);
    });

    it('throws WasmValidationError for a missing file', () => {
      expect(() => analyzeNumericConversions('/nonexistent/numeric.wasm')).toThrow(
        WasmValidationError,
      );
    });

    it('does not crash on unknown opcodes', () => {
      const file = singleFnWasm([0xf9, I32_WRAP_I64]);
      const report = analyzeNumericConversions(file);
      expect(report.statistics.totalNumericConversions).toBe(1);
      expect(report.records[0].opcode).toBe('i32.wrap_i64');
    });

    it('stops scanning unsupported SIMD prefixes and emits a warning', () => {
      const file = singleFnWasm([SIMD_PREFIX, I32_WRAP_I64]);
      const report = analyzeNumericConversions(file);
      expect(report.warnings.length).toBe(1);
      expect(report.warnings[0]).toContain('SIMD');
      expect(report.statistics.totalNumericConversions).toBe(0);
    });

    it('is deterministic across repeated runs', () => {
      const file = writeTmp(
        buildWasm([
          [I64_EXTEND_I32_S, I32_WRAP_I64, END],
          [F32_CONVERT_I32_S, I32_TRUNC_F32_U, END],
        ]),
      );
      const first = analyzeNumericConversions(file);
      const second = analyzeNumericConversions(file);
      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    });

    it('never executes WASM and still reports conversions after a trap instruction', () => {
      const file = singleFnWasm([UNREACHABLE, I32_WRAP_I64, I64_EXTEND_I32_S]);
      const report = analyzeNumericConversions(file);

      expect(report.valid).toBe(true);
      expect(report.statistics.totalNumericConversions).toBe(2);
      expect(report.statistics.narrowingConversions).toBe(1);
      expect(report.statistics.wideningConversions).toBe(1);
    });
  });
});
