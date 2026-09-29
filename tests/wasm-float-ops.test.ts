/**
 * tests/wasm-float-ops.test.ts
 *
 * Unit tests for the WASM floating-point operation analysis (ISSUE-278).
 *
 * Every test uses in-memory Buffer fixtures written to tmp files so that no
 * network access or real WASM compilation is needed. No instructions are ever
 * executed.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  WasmValidationError,
  analyzeFloatOps,
  compareFloatOpsReports,
} from '../src/utils/wasm-static-analysis';
import { compareFloatOpsFiles, toCsv, run } from '../src/examples/248-wasm-float-ops';

// ---------------------------------------------------------------------------
// Low-level binary helpers (mirrors the pattern used in wasm-static-analysis.test.ts)
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

/**
 * Build a minimal valid WASM module.
 *
 * @param bodies - Array of raw instruction byte sequences for each function
 *                 body (without locals prefix; locals are prepended as 0 groups).
 *                 Each body MUST end with 0x0b (end).
 */
function buildWasm(bodies: number[][]): Buffer {
  // Type section: one type (void→void) for each function
  const typeCount = bodies.length;
  const typeSection = section(1, [
    typeCount,
    // each type entry: 0x60 param_count result_count
    ...Array.from({ length: typeCount }, () => [0x60, 0x00, 0x00]).flat(),
  ]);

  // Function section: each function references type 0
  const funcSection = section(3, [typeCount, ...Array(typeCount).fill(0x00)]);

  // Code section
  const codeBodies: number[] = [typeCount];
  bodies.forEach((body) => {
    // locals: 0 groups
    const localBytes = [0x00];
    const full = [...localBytes, ...body];
    codeBodies.push(...u32le(full.length), ...full);
  });
  const codeSection = section(10, codeBodies);

  return Buffer.from([...WASM_HEADER, ...typeSection, ...funcSection, ...codeSection]);
}

function writeTmp(buf: Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wasm-float-ops-'));
  const file = path.join(dir, 'test.wasm');
  fs.writeFileSync(file, buf);
  return file;
}

// ---------------------------------------------------------------------------
// Opcode constants used in tests
// ---------------------------------------------------------------------------
const F32_CONST = 0x43;
const F64_CONST = 0x44;
const F32_ADD = 0x92;
const F32_SUB = 0x93;
const F32_MUL = 0x94;
const F32_DIV = 0x95;
const F64_ADD = 0xa0;
const F64_SUB = 0xa1;
const F64_MUL = 0xa2;
const F64_DIV = 0xa3;
const F32_EQ = 0x5b;
const F32_LT = 0x5d;
const F64_EQ = 0x61;
const F64_LT = 0x63;
const F32_CEIL = 0x8d;
const F32_FLOOR = 0x8e;
const F32_TRUNC = 0x8f;
const F32_NEAREST = 0x90;
const F64_CEIL = 0x9b;
const F64_FLOOR = 0x9c;
const F64_TRUNC = 0x9d;
const F64_NEAREST = 0x9e;
const F32_MIN = 0x96;
const F32_MAX = 0x97;
const F64_MIN = 0xa4;
const F64_MAX = 0xa5;
const F32_ABS = 0x8b;
const F32_NEG = 0x8c;
const F64_ABS = 0x99;
const F64_NEG = 0x9a;
const F32_COPYSIGN = 0x98;
const F64_COPYSIGN = 0xa6;
const F32_CONVERT_I32_S = 0xb2;
const F32_CONVERT_I32_U = 0xb3;
const F64_CONVERT_I64_S = 0xb9;
const F64_CONVERT_I32_S = 0xb7;
const I32_TRUNC_F32_S = 0xa8;
const I32_TRUNC_F64_S = 0xaa;
const I64_TRUNC_F64_S = 0xb0;
const F32_DEMOTE_F64 = 0xb6;
const F64_PROMOTE_F32 = 0xbb;
const I32_REINTERPRET_F32 = 0xbc;
const I64_REINTERPRET_F64 = 0xbd;
const F32_REINTERPRET_I32 = 0xbe;
const F64_REINTERPRET_I64 = 0xbf;
const F32_SQRT = 0x91;
const F64_SQRT = 0x9f;
const I32_CONST = 0x41;
const END = 0x0b;

// ---------------------------------------------------------------------------
// Helper to build a single-function WASM with given instructions
// ---------------------------------------------------------------------------
function singleFnWasm(instructions: number[]): string {
  return writeTmp(buildWasm([[...instructions, END]]));
}

function emptyFnWasm(): string {
  return writeTmp(buildWasm([[END]]));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('wasm-float-ops: analyzeFloatOps', () => {
  // -------------------------------------------------------------------------
  // 1. No floating-point instructions
  // -------------------------------------------------------------------------
  it('returns zero counts for a module with no float instructions', () => {
    const file = singleFnWasm([I32_CONST, 0x01, I32_CONST, 0x02, 0x6a /* i32.add */]);
    const report = analyzeFloatOps(file);

    expect(report.valid).toBe(true);
    expect(report.statistics.totalFloatInstructions).toBe(0);
    expect(report.statistics.totalF32Instructions).toBe(0);
    expect(report.statistics.totalF64Instructions).toBe(0);
    expect(report.statistics.functionsUsingFloat).toBe(0);
    expect(report.records).toHaveLength(0);
    expect(report.statistics.highestDensityFunction).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 2. f32 arithmetic
  // -------------------------------------------------------------------------
  it('detects f32 arithmetic instructions', () => {
    const file = singleFnWasm([F32_ADD, F32_SUB, F32_MUL, F32_DIV, F32_SQRT]);
    const report = analyzeFloatOps(file);

    expect(report.statistics.totalF32Instructions).toBe(5);
    expect(report.statistics.totalF64Instructions).toBe(0);
    expect(report.statistics.arithmeticCount).toBe(5);
    expect(report.statistics.comparisonCount).toBe(0);
    report.records.forEach((r) => {
      expect(r.valueType).toBe('f32');
      expect(r.category).toBe('arithmetic');
    });
  });

  // -------------------------------------------------------------------------
  // 3. f64 arithmetic
  // -------------------------------------------------------------------------
  it('detects f64 arithmetic instructions', () => {
    const file = singleFnWasm([F64_ADD, F64_SUB, F64_MUL, F64_DIV, F64_SQRT]);
    const report = analyzeFloatOps(file);

    expect(report.statistics.totalF64Instructions).toBe(5);
    expect(report.statistics.totalF32Instructions).toBe(0);
    expect(report.statistics.arithmeticCount).toBe(5);
    report.records.forEach((r) => {
      expect(r.valueType).toBe('f64');
      expect(r.category).toBe('arithmetic');
    });
  });

  // -------------------------------------------------------------------------
  // 4. Floating-point comparisons
  // -------------------------------------------------------------------------
  it('classifies f32 and f64 comparisons correctly', () => {
    const file = singleFnWasm([F32_EQ, F32_LT, F64_EQ, F64_LT]);
    const report = analyzeFloatOps(file);

    expect(report.statistics.comparisonCount).toBe(4);
    expect(report.statistics.totalF32Instructions).toBe(2);
    expect(report.statistics.totalF64Instructions).toBe(2);
    const opcodes = report.records.map((r) => r.opcode);
    expect(opcodes).toContain('f32.eq');
    expect(opcodes).toContain('f32.lt');
    expect(opcodes).toContain('f64.eq');
    expect(opcodes).toContain('f64.lt');
  });

  // -------------------------------------------------------------------------
  // 5. Rounding instructions
  // -------------------------------------------------------------------------
  it('classifies rounding instructions correctly', () => {
    const file = singleFnWasm([
      F32_CEIL, F32_FLOOR, F32_TRUNC, F32_NEAREST,
      F64_CEIL, F64_FLOOR, F64_TRUNC, F64_NEAREST,
    ]);
    const report = analyzeFloatOps(file);

    expect(report.statistics.roundingCount).toBe(8);
    expect(report.statistics.arithmeticCount).toBe(0);
    report.records.forEach((r) => {
      expect(r.category).toBe('rounding');
    });
  });

  // -------------------------------------------------------------------------
  // 6. Min/max operations
  // -------------------------------------------------------------------------
  it('classifies min/max operations correctly', () => {
    const file = singleFnWasm([F32_MIN, F32_MAX, F64_MIN, F64_MAX]);
    const report = analyzeFloatOps(file);

    expect(report.statistics.minmaxCount).toBe(4);
    expect(report.statistics.totalF32Instructions).toBe(2);
    expect(report.statistics.totalF64Instructions).toBe(2);
    report.records.forEach((r) => expect(r.category).toBe('minmax'));
  });

  // -------------------------------------------------------------------------
  // 7. Absolute / sign operations
  // -------------------------------------------------------------------------
  it('classifies abs/neg/copysign operations correctly', () => {
    const file = singleFnWasm([F32_ABS, F32_NEG, F32_COPYSIGN, F64_ABS, F64_NEG, F64_COPYSIGN]);
    const report = analyzeFloatOps(file);

    expect(report.statistics.absoluteSignCount).toBe(6);
    report.records.forEach((r) => expect(r.category).toBe('absolute_sign'));
  });

  // -------------------------------------------------------------------------
  // 8. Floating-point constants
  // -------------------------------------------------------------------------
  it('detects f32.const and f64.const instructions', () => {
    // f32.const takes 4 bytes of immediate; f64.const takes 8 bytes
    const file = singleFnWasm([
      F32_CONST, 0x00, 0x00, 0x00, 0x00,
      F64_CONST, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    const report = analyzeFloatOps(file);

    expect(report.statistics.constantCount).toBe(2);
    expect(report.statistics.totalF32Instructions).toBe(1);
    expect(report.statistics.totalF64Instructions).toBe(1);
    report.records.forEach((r) => expect(r.category).toBe('constant'));
  });

  // -------------------------------------------------------------------------
  // 9. Integer-to-float conversions
  // -------------------------------------------------------------------------
  it('detects integer-to-float conversions', () => {
    const file = singleFnWasm([F32_CONVERT_I32_S, F32_CONVERT_I32_U, F64_CONVERT_I32_S, F64_CONVERT_I64_S]);
    const report = analyzeFloatOps(file);

    expect(report.statistics.conversionCount).toBe(4);
    const opcodes = report.records.map((r) => r.opcode);
    expect(opcodes).toContain('f32.convert_i32_s');
    expect(opcodes).toContain('f32.convert_i32_u');
    expect(opcodes).toContain('f64.convert_i32_s');
    expect(opcodes).toContain('f64.convert_i64_s');

    const fn = report.functions[0];
    expect(fn.hasConversion).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 10. Float-to-integer conversions
  // -------------------------------------------------------------------------
  it('detects float-to-integer conversions', () => {
    const file = singleFnWasm([I32_TRUNC_F32_S, I32_TRUNC_F64_S, I64_TRUNC_F64_S]);
    const report = analyzeFloatOps(file);

    expect(report.statistics.conversionCount).toBe(3);
    const opcodes = report.records.map((r) => r.opcode);
    expect(opcodes).toContain('i32.trunc_f32_s');
    expect(opcodes).toContain('i32.trunc_f64_s');
    expect(opcodes).toContain('i64.trunc_f64_s');
  });

  // -------------------------------------------------------------------------
  // 11. Float-to-float conversions (promotion / demotion)
  // -------------------------------------------------------------------------
  it('detects f32.demote_f64 and f64.promote_f32', () => {
    const file = singleFnWasm([F32_DEMOTE_F64, F64_PROMOTE_F32]);
    const report = analyzeFloatOps(file);

    expect(report.statistics.conversionCount).toBe(2);
    const opcodes = report.records.map((r) => r.opcode);
    expect(opcodes).toContain('f32.demote_f64');
    expect(opcodes).toContain('f64.promote_f32');
  });

  // -------------------------------------------------------------------------
  // 12. Bit reinterpretation
  // -------------------------------------------------------------------------
  it('classifies all four reinterpretation instructions correctly', () => {
    const file = singleFnWasm([
      I32_REINTERPRET_F32,
      I64_REINTERPRET_F64,
      F32_REINTERPRET_I32,
      F64_REINTERPRET_I64,
    ]);
    const report = analyzeFloatOps(file);

    expect(report.statistics.reinterpretationCount).toBe(4);
    report.records.forEach((r) => expect(r.category).toBe('reinterpretation'));

    const fn = report.functions[0];
    expect(fn.hasReinterpretation).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 13. Mixed f32/f64 usage
  // -------------------------------------------------------------------------
  it('detects mixed f32 and f64 usage within a single function', () => {
    const file = singleFnWasm([F32_ADD, F64_ADD]);
    const report = analyzeFloatOps(file);

    expect(report.statistics.totalF32Instructions).toBe(1);
    expect(report.statistics.totalF64Instructions).toBe(1);
    const fn = report.functions[0];
    expect(fn.hasMixedPrecision).toBe(true);
    expect(fn.f32Count).toBe(1);
    expect(fn.f64Count).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 14. Multiple categories within one function
  // -------------------------------------------------------------------------
  it('records all category counts when multiple categories appear in one function', () => {
    const file = singleFnWasm([
      F32_ADD,
      F32_EQ,
      F32_CONVERT_I32_S,
      F32_CEIL,
      F32_MIN,
      F32_ABS,
      I32_REINTERPRET_F32,
      F32_CONST, 0x00, 0x00, 0x00, 0x00,
    ]);
    const report = analyzeFloatOps(file);

    const fn = report.functions[0];
    expect(fn.categoryCounts.arithmetic).toBe(1);
    expect(fn.categoryCounts.comparison).toBe(1);
    expect(fn.categoryCounts.conversion).toBe(1);
    expect(fn.categoryCounts.rounding).toBe(1);
    expect(fn.categoryCounts.minmax).toBe(1);
    expect(fn.categoryCounts.absolute_sign).toBe(1);
    expect(fn.categoryCounts.reinterpretation).toBe(1);
    expect(fn.categoryCounts.constant).toBe(1);
    expect(fn.hasArithmetic).toBe(true);
    expect(fn.hasComparison).toBe(true);
    expect(fn.hasConversion).toBe(true);
    expect(fn.hasReinterpretation).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 15. Module-level statistics
  // -------------------------------------------------------------------------
  it('reports accurate module-level statistics across multiple functions', () => {
    const buf = buildWasm([
      [F32_ADD, F32_ADD, END],          // 2 f32 arithmetic
      [F64_EQ, F64_EQ, F64_EQ, END],    // 3 f64 comparison
      [END],                             // empty
    ]);
    const file = writeTmp(buf);
    const report = analyzeFloatOps(file);

    expect(report.statistics.totalFloatInstructions).toBe(5);
    expect(report.statistics.totalF32Instructions).toBe(2);
    expect(report.statistics.totalF64Instructions).toBe(3);
    expect(report.statistics.arithmeticCount).toBe(2);
    expect(report.statistics.comparisonCount).toBe(3);
    expect(report.statistics.functionsUsingFloat).toBe(2);
    expect(report.functions).toHaveLength(3);
  });

  // -------------------------------------------------------------------------
  // 16. Per-function float density
  // -------------------------------------------------------------------------
  it('calculates per-function float density correctly', () => {
    // 2 instructions total: 1 float → density = 0.5
    const file = singleFnWasm([I32_CONST, 0x01, F32_ADD]);
    const report = analyzeFloatOps(file);

    const fn = report.functions[0];
    // instructions: i32.const (skips 1 byte immediate internally handled by
    // skipInstructionImmediate), f32.add, end → total 3 instructions (we count
    // each opcode byte separately; the immediate byte is skipped, not counted)
    expect(fn.totalFloatOps).toBe(1);
    expect(fn.floatDensity).toBeGreaterThan(0);
    expect(fn.floatDensity).toBeLessThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // 17. Highest density function
  // -------------------------------------------------------------------------
  it('identifies the function with the highest float density', () => {
    const buf = buildWasm([
      [I32_CONST, 0x01, I32_CONST, 0x02, 0x6a, END], // 0 float
      [F32_ADD, F32_MUL, END],                        // all float → high density
      [I32_CONST, 0x01, F64_ADD, END],                // some float
    ]);
    const file = writeTmp(buf);
    const report = analyzeFloatOps(file);

    const hd = report.statistics.highestDensityFunction;
    expect(hd).not.toBeNull();
    // Function 1 (index 1) has only float ops
    expect(hd!.functionIndex).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 18. Int↔Float roundtrip detection
  // -------------------------------------------------------------------------
  it('detects int-to-float and float-to-int roundtrip within one function', () => {
    const file = singleFnWasm([F32_CONVERT_I32_S, I32_TRUNC_F32_S]);
    const report = analyzeFloatOps(file);

    const fn = report.functions[0];
    expect(fn.hasIntFloatIntRoundtrip).toBe(true);
  });

  it('does not flag int-float roundtrip when only one direction is present', () => {
    const file = singleFnWasm([F32_CONVERT_I32_S]);
    const report = analyzeFloatOps(file);

    expect(report.functions[0].hasIntFloatIntRoundtrip).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 19. Instruction location fields
  // -------------------------------------------------------------------------
  it('records stable function, block, and instruction indexes for every record', () => {
    const file = singleFnWasm([F32_ADD, F32_MUL]);
    const report = analyzeFloatOps(file);

    expect(report.records).toHaveLength(2);
    expect(report.records[0].functionIndex).toBe(0);
    expect(report.records[0].instructionIndex).toBe(0);
    expect(report.records[1].instructionIndex).toBe(1);
    report.records.forEach((r) => {
      expect(typeof r.blockIndex).toBe('number');
      expect(typeof r.functionIndex).toBe('number');
      expect(typeof r.instructionIndex).toBe('number');
      expect(typeof r.opcode).toBe('string');
      expect(['f32', 'f64']).toContain(r.valueType);
    });
  });

  // -------------------------------------------------------------------------
  // 20. JSON output mode
  // -------------------------------------------------------------------------
  it('produces valid JSON output', () => {
    const file = singleFnWasm([F32_ADD, F64_ADD]);
    const report = analyzeFloatOps(file);
    const json = JSON.stringify(report, null, 2);
    const parsed = JSON.parse(json);

    expect(parsed.valid).toBe(true);
    expect(parsed.statistics.totalFloatInstructions).toBe(2);
    expect(Array.isArray(parsed.records)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 21. CSV output
  // -------------------------------------------------------------------------
  it('generates CSV with header and one row per float instruction', () => {
    const file = singleFnWasm([F32_ADD, F64_EQ]);
    const report = analyzeFloatOps(file);
    const csv = toCsv(report.records);
    const lines = csv.split('\n');

    expect(lines[0]).toBe('functionIndex,blockIndex,instructionIndex,opcode,valueType,category');
    expect(lines).toHaveLength(3); // header + 2 records
    expect(lines[1]).toContain('f32.add');
    expect(lines[2]).toContain('f64.eq');
  });

  it('generates CSV with only header row when there are no float instructions', () => {
    const file = emptyFnWasm();
    const report = analyzeFloatOps(file);
    const csv = toCsv(report.records);
    const lines = csv.split('\n');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('functionIndex');
  });

  // -------------------------------------------------------------------------
  // 22. Comparison mode — two-artifact
  // -------------------------------------------------------------------------
  it('comparison mode detects added and removed opcodes between two artifacts', () => {
    const before = writeTmp(buildWasm([[F32_ADD, END]]));
    const after = writeTmp(buildWasm([[F64_ADD, END]]));
    const result = compareFloatOpsFiles(before, after);

    expect(result.comparison.addedOpcodes).toContain('f64.add');
    expect(result.comparison.removedOpcodes).toContain('f32.add');
    expect(result.comparison.newF64Usage).toBe(true);
    expect(result.comparison.newF32Usage).toBe(false);
    expect(result.comparison.totalFloatDelta).toBe(0);
    expect(result.comparison.f32Delta).toBe(-1);
    expect(result.comparison.f64Delta).toBe(1);
  });

  it('comparison mode detects newly float-using functions', () => {
    const before = writeTmp(buildWasm([[END], [END]]));
    const after = writeTmp(buildWasm([[F32_ADD, END], [END]]));
    const result = compareFloatOpsFiles(before, after);

    expect(result.comparison.newlyFloatFunctions).toContain(0);
    expect(result.comparison.removedFloatFunctions).toHaveLength(0);
    expect(result.comparison.totalFloatDelta).toBe(1);
  });

  it('comparison mode detects functions that lost float ops', () => {
    const before = writeTmp(buildWasm([[F32_ADD, END]]));
    const after = writeTmp(buildWasm([[END]]));
    const result = compareFloatOpsFiles(before, after);

    expect(result.comparison.removedFloatFunctions).toContain(0);
    expect(result.comparison.newlyFloatFunctions).toHaveLength(0);
    expect(result.comparison.totalFloatDelta).toBe(-1);
  });

  it('comparison mode shows no changes for identical artifacts', () => {
    const file = writeTmp(buildWasm([[F32_ADD, F64_EQ, END]]));
    const result = compareFloatOpsReports(file, file);

    expect(result.comparison.addedOpcodes).toHaveLength(0);
    expect(result.comparison.removedOpcodes).toHaveLength(0);
    expect(result.comparison.totalFloatDelta).toBe(0);
    expect(result.comparison.newlyFloatFunctions).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 23. Malformed WASM input
  // -------------------------------------------------------------------------
  it('throws WasmValidationError for malformed WASM (bad magic)', () => {
    const file = writeTmp(Buffer.from([0x00, 0x61, 0x73, 0x00, 0x01, 0x00, 0x00, 0x00]));
    expect(() => analyzeFloatOps(file)).toThrow(WasmValidationError);
  });

  it('throws WasmValidationError for files that are too short', () => {
    const file = writeTmp(Buffer.from([0x00, 0x61]));
    expect(() => analyzeFloatOps(file)).toThrow(WasmValidationError);
  });

  it('throws WasmValidationError when the file cannot be read', () => {
    expect(() => analyzeFloatOps('/nonexistent/path/to/file.wasm')).toThrow(WasmValidationError);
  });

  // -------------------------------------------------------------------------
  // 24. Unknown / unsupported opcode handling
  // -------------------------------------------------------------------------
  it('does not crash on unknown opcodes — treats them as non-float instructions', () => {
    // 0xf9 is not a known WASM opcode; include a real float op to verify the
    // rest of parsing continues correctly.
    const file = singleFnWasm([0xf9, F32_ADD]);
    // Should not throw; the unknown opcode is silently skipped
    const report = analyzeFloatOps(file);
    expect(report.statistics.totalFloatInstructions).toBe(1);
    expect(report.records[0].opcode).toBe('f32.add');
  });

  // -------------------------------------------------------------------------
  // 25. Deterministic repeated execution
  // -------------------------------------------------------------------------
  it('produces identical results on repeated calls for the same artifact', () => {
    const file = writeTmp(
      buildWasm([
        [F32_ADD, F64_EQ, F32_CONVERT_I32_S, END],
        [I32_TRUNC_F32_S, F32_MIN, END],
      ]),
    );
    const first = analyzeFloatOps(file);
    const second = analyzeFloatOps(file);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  // -------------------------------------------------------------------------
  // 26. No WASM execution — pure static analysis
  // -------------------------------------------------------------------------
  it('returns accurate analysis for a module with a trap instruction without executing it', () => {
    // 0x00 = unreachable (would trap if executed)
    const file = singleFnWasm([0x00, F32_ADD, F64_MUL]);
    const report = analyzeFloatOps(file);

    // Only the float ops should be counted; unreachable should not affect analysis
    expect(report.statistics.totalFloatInstructions).toBe(2);
    expect(report.statistics.arithmeticCount).toBe(2);
  });

  // -------------------------------------------------------------------------
  // 27. Concentration detection
  // -------------------------------------------------------------------------
  it('detects concentrated float usage when one function dominates', () => {
    // 10 functions: first has 10 float ops, rest have 0
    const bodies: number[][] = [
      [F32_ADD, F32_ADD, F32_ADD, F32_ADD, F32_ADD,
       F32_ADD, F32_ADD, F32_ADD, F32_ADD, F32_ADD, END],
      ...Array.from({ length: 9 }, () => [END]),
    ];
    const file = writeTmp(buildWasm(bodies));
    const report = analyzeFloatOps(file);

    expect(report.statistics.floatConcentrated).toBe(true);
  });

  it('does not flag concentration when float usage is spread evenly', () => {
    const bodies: number[][] = Array.from({ length: 5 }, () => [F32_ADD, F32_ADD, END]);
    const file = writeTmp(buildWasm(bodies));
    const report = analyzeFloatOps(file);

    expect(report.statistics.floatConcentrated).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 28. f32/f64 distinction accuracy
  // -------------------------------------------------------------------------
  it('correctly distinguishes f32 from f64 for every category', () => {
    const file = singleFnWasm([
      F32_ADD, F64_ADD,
      F32_EQ, F64_EQ,
      F32_CONVERT_I32_S, F64_CONVERT_I32_S,
      F32_CEIL, F64_CEIL,
      F32_MIN, F64_MIN,
      F32_ABS, F64_ABS,
      I32_REINTERPRET_F32, I64_REINTERPRET_F64,
      F32_CONST, 0x00, 0x00, 0x00, 0x00,
      F64_CONST, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    const report = analyzeFloatOps(file);

    expect(report.statistics.totalF32Instructions).toBe(8);
    expect(report.statistics.totalF64Instructions).toBe(8);
    expect(report.statistics.totalFloatInstructions).toBe(16);
  });

  // -------------------------------------------------------------------------
  // 29. Empty WASM module (no code section)
  // -------------------------------------------------------------------------
  it('handles a module with no code section gracefully', () => {
    const buf = Buffer.from([...WASM_HEADER]);
    const file = writeTmp(buf);
    const report = analyzeFloatOps(file);

    expect(report.valid).toBe(true);
    expect(report.records).toHaveLength(0);
    expect(report.functions).toHaveLength(0);
    expect(report.statistics.totalFloatInstructions).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 30. run() function integration
  // -------------------------------------------------------------------------
  it('run() throws when no wasmFile is provided', async () => {
    await expect(run({})).rejects.toThrow(/Usage/);
  });

  it('run() outputs JSON when json flag is true', async () => {
    const file = singleFnWasm([F32_ADD]);
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);
    try {
      await run({ wasmFile: file, json: true });
    } finally {
      console.log = origLog;
    }
    const parsed = JSON.parse(logs.join(''));
    expect(parsed.statistics.totalF32Instructions).toBe(1);
  });

  it('run() outputs CSV when csv flag is true', async () => {
    const file = singleFnWasm([F32_ADD, F64_EQ]);
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);
    try {
      await run({ wasmFile: file, csv: true });
    } finally {
      console.log = origLog;
    }
    const output = logs.join('\n');
    expect(output).toContain('functionIndex');
    expect(output).toContain('f32.add');
    expect(output).toContain('f64.eq');
  });

  it('run() prints human-readable output by default', async () => {
    const file = singleFnWasm([F32_ADD]);
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);
    try {
      await run({ wasmFile: file });
    } finally {
      console.log = origLog;
    }
    const output = logs.join('\n');
    expect(output).toContain('WASM Floating-Point');
  });

  it('run() outputs comparison JSON when compareFile and json are set', async () => {
    const before = writeTmp(buildWasm([[F32_ADD, END]]));
    const after = writeTmp(buildWasm([[F64_ADD, END]]));
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);
    try {
      await run({ wasmFile: before, compareFile: after, json: true });
    } finally {
      console.log = origLog;
    }
    const parsed = JSON.parse(logs.join(''));
    expect(parsed.comparison.addedOpcodes).toContain('f64.add');
    expect(parsed.comparison.removedOpcodes).toContain('f32.add');
  });

  // -------------------------------------------------------------------------
  // 31. Sequence detection
  // -------------------------------------------------------------------------
  it('detects consecutive float instruction sequences', () => {
    const file = singleFnWasm([F32_ADD, F32_MUL, F32_SQRT]);
    const report = analyzeFloatOps(file);

    expect(report.sequences.length).toBeGreaterThanOrEqual(1);
    const firstSeq = report.sequences[0];
    expect(firstSeq.opcodes[0]).toBe('f32.add');
    expect(firstSeq.opcodes[1]).toBe('f32.mul');
  });

  // -------------------------------------------------------------------------
  // 32. Promotion and demotion conversions are correctly typed
  // -------------------------------------------------------------------------
  it('records f32.demote_f64 as f32 and f64.promote_f32 as f64', () => {
    const file = singleFnWasm([F32_DEMOTE_F64, F64_PROMOTE_F32]);
    const report = analyzeFloatOps(file);

    const demote = report.records.find((r) => r.opcode === 'f32.demote_f64');
    const promote = report.records.find((r) => r.opcode === 'f64.promote_f32');
    expect(demote?.valueType).toBe('f32');
    expect(promote?.valueType).toBe('f64');
  });
});
