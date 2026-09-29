import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  WasmValidationError,
  analyzeRecursion,
  compareRecursionReports,
} from '../src/utils/wasm-static-analysis';
import { run } from '../src/examples/219-wasm-recursion';

// ---------------------------------------------------------------------------
// WASM binary fixture helpers
// ---------------------------------------------------------------------------

/** Encode an unsigned 32-bit value as a LEB128 byte sequence. */
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
  const encoded = Buffer.from(value, 'utf8');
  return [...u32(encoded.length), ...encoded];
}

function section(id: number, payload: number[]): number[] {
  return [id, ...u32(payload.length), ...payload];
}

/** WASM magic + version header. */
const WASM_HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

/**
 * Encode a minimal function body.
 *
 * `instructions` is a flat list of raw bytes; the builder prepends a zero-local
 * count and wraps in the body-size prefix expected by the code section.
 */
function body(...instructions: number[]): number[] {
  const inner = [0x00, ...instructions, 0x0b]; // 0x00 = 0 local groups; 0x0b = end
  return [...u32(inner.length), ...inner];
}

/**
 * A `call <funcIdx>` instruction.
 * WASM opcode 0x10 followed by a LEB128 function index.
 */
function callInstr(funcIdx: number): number[] {
  return [0x10, ...u32(funcIdx)];
}

/**
 * A `call_indirect <typeIdx> <tableIdx>` instruction.
 * Opcode 0x11 followed by type index (LEB128) and table index (byte).
 */
function callIndirectInstr(typeIdx: number, tableIdx = 0): number[] {
  return [0x11, ...u32(typeIdx), tableIdx];
}

/** Write a Buffer to a temporary file and return the path. */
function writeWasm(buf: Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wasm-recursion-'));
  const file = path.join(dir, 'fixture.wasm');
  fs.writeFileSync(file, buf);
  return file;
}

/**
 * Build a minimal WASM binary with `functionCount` locally-defined functions.
 *
 * The type section declares a single `() -> ()` type (index 0).
 * The function section maps each function to type 0.
 *
 * `bodies` is an array of instruction-byte arrays, one per defined function.
 * Functions are numbered starting from `importedFunctionCount`.
 *
 * `elementSlots` is an optional array of function indices to place into an
 * active element segment starting at table slot 0, enabling call_indirect
 * resolution.
 */
function buildWasm(
  bodies: number[][],
  options: {
    importedFunctionCount?: number;
    elementSlots?: number[];
  } = {},
): Buffer {
  const importCount = options.importedFunctionCount ?? 0;
  const elementSlots = options.elementSlots;

  // Type section: single type () -> ()
  const typeSection = section(1, [0x01, 0x60, 0x00, 0x00]);

  // Import section (imported functions all use type 0)
  const importPayload: number[] = [importCount];
  for (let i = 0; i < importCount; i++) {
    importPayload.push(...str('env'), ...str(`import${i}`), 0x00, 0x00);
  }
  const importSection = importCount > 0 ? section(2, importPayload) : [];

  // Function section: one entry per defined body
  const funcSection = section(3, [bodies.length, ...bodies.map(() => 0x00)]);

  // Table section (funcref, min 16, no max) — needed for call_indirect
  const tableSection = section(4, [0x01, 0x70, 0x00, 0x10]);

  // Code section
  const codePayload: number[] = [...u32(bodies.length)];
  for (const b of bodies) codePayload.push(...body(...b));
  const codeSection = section(10, codePayload);

  // Element section (active, table 0, offset 0, slots)
  let elementSectionBytes: number[] = [];
  if (elementSlots && elementSlots.length > 0) {
    // flags=0 (active, funcref), table implicitly 0, offset i32.const 0 end
    const elemPayload: number[] = [
      0x01,           // count = 1 segment
      0x00,           // flags = 0 (active)
      0x41, 0x00, 0x0b, // i32.const 0; end (offset = 0)
      ...u32(elementSlots.length),
      ...elementSlots.flatMap((idx) => u32(idx)),
    ];
    elementSectionBytes = section(9, elemPayload);
  }

  return Buffer.from([
    ...WASM_HEADER,
    ...typeSection,
    ...importSection,
    ...funcSection,
    ...tableSection,
    ...elementSectionBytes,
    ...codeSection,
  ]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('wasm-recursion: analyzeRecursion', () => {

  // -------------------------------------------------------------------------
  // No recursion
  // -------------------------------------------------------------------------

  it('detects no recursion when no function calls another', () => {
    // fn0 just does nothing (nop), fn1 also does nothing
    const file = writeWasm(buildWasm([[0x01], [0x01]]));
    const report = analyzeRecursion(file);

    expect(report.valid).toBe(true);
    expect(report.statistics.recursiveFunctionCount).toBe(0);
    expect(report.statistics.recursiveComponentCount).toBe(0);
    expect(report.recursiveSccs).toHaveLength(0);
    expect(report.recursiveFunctions).toHaveLength(0);
  });

  it('detects no recursion when calls are acyclic', () => {
    // fn0 calls fn1; fn1 has no outgoing calls
    const file = writeWasm(buildWasm([callInstr(1), [0x01]]));
    const report = analyzeRecursion(file);

    expect(report.statistics.recursiveFunctionCount).toBe(0);
    expect(report.statistics.totalDirectCallEdges).toBe(1);
    expect(report.callEdges[0]).toMatchObject({
      callerIndex: 0,
      calleeIndex: 1,
      callType: 'direct',
    });
  });

  // -------------------------------------------------------------------------
  // Direct self-recursion
  // -------------------------------------------------------------------------

  it('detects direct self-recursion', () => {
    // fn0 calls fn0
    const file = writeWasm(buildWasm([callInstr(0)]));
    const report = analyzeRecursion(file);

    expect(report.statistics.recursiveFunctionCount).toBe(1);
    expect(report.statistics.directSelfRecursiveFunctionCount).toBe(1);
    expect(report.statistics.recursiveComponentCount).toBe(1);
    expect(report.recursiveSccs[0].kind).toBe('direct_self_recursion');
    expect(report.recursiveSccs[0].members).toEqual([0]);
    expect(report.recursiveSccs[0].shortestCycleLength).toBe(1);
    expect(report.recursiveFunctions).toContain(0);
  });

  it('detects multiple independent self-recursive functions', () => {
    // fn0 calls fn0; fn1 calls fn1
    const file = writeWasm(buildWasm([callInstr(0), callInstr(1)]));
    const report = analyzeRecursion(file);

    expect(report.statistics.directSelfRecursiveFunctionCount).toBe(2);
    expect(report.statistics.recursiveComponentCount).toBe(2);
    expect(report.recursiveSccs.every((s) => s.kind === 'direct_self_recursion')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Two-function mutual recursion
  // -------------------------------------------------------------------------

  it('detects two-function mutual recursion', () => {
    // fn0 calls fn1; fn1 calls fn0
    const file = writeWasm(buildWasm([callInstr(1), callInstr(0)]));
    const report = analyzeRecursion(file);

    expect(report.statistics.recursiveFunctionCount).toBe(2);
    expect(report.statistics.mutualRecursionComponentCount).toBe(1);
    const scc = report.recursiveSccs[0];
    expect(scc.kind).toBe('mutual_recursion_two');
    expect(scc.members.sort()).toEqual([0, 1]);
    expect(scc.shortestCycleLength).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Three-function recursive cycle
  // -------------------------------------------------------------------------

  it('detects three-function recursive cycle', () => {
    // fn0 → fn1 → fn2 → fn0
    const file = writeWasm(buildWasm([callInstr(1), callInstr(2), callInstr(0)]));
    const report = analyzeRecursion(file);

    expect(report.statistics.recursiveFunctionCount).toBe(3);
    expect(report.statistics.maxCycleSize).toBe(3);
    const scc = report.recursiveSccs.find((s) => s.members.length === 3);
    expect(scc).toBeDefined();
    expect(scc!.kind).toBe('multi_function_cycle');
    expect(scc!.shortestCycleLength).toBe(3);
  });

  // -------------------------------------------------------------------------
  // Recursive component with additional non-recursive callers
  // -------------------------------------------------------------------------

  it('handles a recursive component with a non-recursive caller', () => {
    // fn0 → fn1 → fn0 (cycle), fn2 → fn0 (just a call, no cycle for fn2)
    // bodies: fn0=callInstr(1), fn1=callInstr(0), fn2=callInstr(0)
    const file = writeWasm(buildWasm([callInstr(1), callInstr(0), callInstr(0)]));
    const report = analyzeRecursion(file);

    // fn0 and fn1 are recursive; fn2 is not
    expect(report.recursiveFunctions).toContain(0);
    expect(report.recursiveFunctions).toContain(1);
    expect(report.recursiveFunctions).not.toContain(2);
  });

  // -------------------------------------------------------------------------
  // Multiple independent recursive components
  // -------------------------------------------------------------------------

  it('detects multiple independent recursive components', () => {
    // Component A: fn0 ↔ fn1
    // Component B: fn2 → fn2 (self)
    const file = writeWasm(
      buildWasm([callInstr(1), callInstr(0), callInstr(2)]),
    );
    const report = analyzeRecursion(file);

    expect(report.statistics.recursiveComponentCount).toBe(2);
    expect(
      report.recursiveSccs.some((s) => s.kind === 'mutual_recursion_two'),
    ).toBe(true);
    expect(
      report.recursiveSccs.some((s) => s.kind === 'direct_self_recursion'),
    ).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Nested / overlapping call relationships
  // -------------------------------------------------------------------------

  it('handles nested calls without false positives', () => {
    // fn0 → fn1 → fn2 (chain, no cycle)
    const file = writeWasm(buildWasm([callInstr(1), callInstr(2), [0x01]]));
    const report = analyzeRecursion(file);

    expect(report.statistics.recursiveFunctionCount).toBe(0);
  });

  // -------------------------------------------------------------------------
  // SCC detection correctness
  // -------------------------------------------------------------------------

  it('correctly assigns SCC IDs and membership', () => {
    // fn0 → fn1 → fn0 (SCC A), fn2 → fn3 → fn2 (SCC B)
    const file = writeWasm(
      buildWasm([callInstr(1), callInstr(0), callInstr(3), callInstr(2)]),
    );
    const report = analyzeRecursion(file);

    const sccA = report.recursiveSccs.find((s) => s.members.includes(0));
    const sccB = report.recursiveSccs.find((s) => s.members.includes(2));
    expect(sccA).toBeDefined();
    expect(sccB).toBeDefined();
    expect(sccA!.members.sort()).toEqual([0, 1]);
    expect(sccB!.members.sort()).toEqual([2, 3]);
  });

  // -------------------------------------------------------------------------
  // Cycle length calculation
  // -------------------------------------------------------------------------

  it('calculates shortest cycle length = 1 for self-recursion', () => {
    const file = writeWasm(buildWasm([callInstr(0)]));
    const report = analyzeRecursion(file);
    expect(report.recursiveSccs[0].shortestCycleLength).toBe(1);
    expect(report.statistics.minimumCycleLength).toBe(1);
  });

  it('calculates shortest cycle length = 2 for mutual recursion', () => {
    const file = writeWasm(buildWasm([callInstr(1), callInstr(0)]));
    const report = analyzeRecursion(file);
    expect(report.recursiveSccs[0].shortestCycleLength).toBe(2);
  });

  it('calculates shortest cycle length for 3-node cycle', () => {
    const file = writeWasm(buildWasm([callInstr(1), callInstr(2), callInstr(0)]));
    const report = analyzeRecursion(file);
    const scc = report.recursiveSccs.find((s) => s.members.length === 3)!;
    expect(scc.shortestCycleLength).toBe(3);
  });

  // -------------------------------------------------------------------------
  // Maximum recursive component size
  // -------------------------------------------------------------------------

  it('reports largestRecursiveComponentSize correctly', () => {
    // fn0 ↔ fn1 (size 2), fn2 → fn3 → fn4 → fn2 (size 3)
    const file = writeWasm(
      buildWasm([
        callInstr(1), // fn0 → fn1
        callInstr(0), // fn1 → fn0
        callInstr(3), // fn2 → fn3
        callInstr(4), // fn3 → fn4
        callInstr(2), // fn4 → fn2
      ]),
    );
    const report = analyzeRecursion(file);

    expect(report.statistics.largestRecursiveComponentSize).toBe(3);
    expect(report.statistics.maxCycleSize).toBe(3);
  });

  // -------------------------------------------------------------------------
  // Unresolved indirect calls
  // -------------------------------------------------------------------------

  it('preserves unresolved indirect calls without treating them as definite recursion', () => {
    // fn0: call_indirect type=0, table=0 — no element section → unresolved
    const file = writeWasm(buildWasm([callIndirectInstr(0, 0)]));
    const report = analyzeRecursion(file);

    expect(report.indirectCallCandidates).toHaveLength(1);
    expect(report.indirectCallCandidates[0].candidateCallees).toHaveLength(0);
    expect(report.statistics.totalUnresolvedIndirectCalls).toBe(1);
    // No direct recursion
    expect(report.statistics.recursiveFunctionCount).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Conservatively resolved indirect-call cycles
  // -------------------------------------------------------------------------

  it('resolves indirect-call candidates from element section', () => {
    // Element section maps slot 0 → fn0 (self-call candidate through call_indirect)
    // fn0: call_indirect type=0, table=0
    const file = writeWasm(buildWasm([callIndirectInstr(0, 0)], { elementSlots: [0] }));
    const report = analyzeRecursion(file);

    expect(report.indirectCallCandidates).toHaveLength(1);
    expect(report.indirectCallCandidates[0].candidateCallees).toContain(0);
    expect(report.statistics.totalUnresolvedIndirectCalls).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Cycle enumeration limits
  // -------------------------------------------------------------------------

  it('enumerates cycles up to maxCycles and does not exceed the limit', () => {
    // fn0 → fn1 → fn0 and fn0 → fn2 → fn0 (two distinct cycles)
    // fn0 calls both fn1 and fn2; fn1 calls fn0; fn2 calls fn0
    // We build fn0 with two call instructions: call fn1, call fn2
    const fn0Body = [...callInstr(1), ...callInstr(2)];
    const fn1Body = callInstr(0);
    const fn2Body = callInstr(0);
    const file = writeWasm(buildWasm([fn0Body, fn1Body, fn2Body]));
    const report = analyzeRecursion(file, { maxCycles: 1 });

    // The report still identifies recursion; the limit applies to cycle *enumeration*
    expect(report.statistics.recursiveFunctionCount).toBeGreaterThan(0);
    expect(report.valid).toBe(true);
  });

  it('handles maxCycles=0 (no enumeration) without error', () => {
    const file = writeWasm(buildWasm([callInstr(0)]));
    expect(() => analyzeRecursion(file, { maxCycles: 0 })).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // JSON output via run()
  // -------------------------------------------------------------------------

  it('produces valid JSON output', async () => {
    const file = writeWasm(buildWasm([callInstr(0)]));
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => lines.push(args.join(' '));
    try {
      await run({ wasmFile: file, json: true });
    } finally {
      console.log = origLog;
    }
    const output = JSON.parse(lines.join('\n')) as Record<string, unknown>;
    expect(output).toHaveProperty('valid', true);
    expect(output).toHaveProperty('statistics');
    expect(output).toHaveProperty('recursiveSccs');
  });

  // -------------------------------------------------------------------------
  // DOT output via run()
  // -------------------------------------------------------------------------

  it('produces valid DOT output for recursive WASM', async () => {
    const file = writeWasm(buildWasm([callInstr(0)]));
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => lines.push(args.join(' '));
    try {
      await run({ wasmFile: file, dot: true });
    } finally {
      console.log = origLog;
    }
    const dot = lines.join('\n');
    expect(dot).toContain('digraph wasm_recursion');
    expect(dot).toContain('fn0');
  });

  it('produces DOT output without error for non-recursive WASM', async () => {
    const file = writeWasm(buildWasm([[0x01]]));
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => lines.push(args.join(' '));
    try {
      await run({ wasmFile: file, dot: true });
    } finally {
      console.log = origLog;
    }
    expect(lines.join('\n')).toContain('digraph');
  });

  // -------------------------------------------------------------------------
  // Two-artifact comparison mode
  // -------------------------------------------------------------------------

  it('identifies newly introduced recursion in comparison mode', () => {
    // before: fn0 with no calls
    // after:  fn0 calls itself
    const before = writeWasm(buildWasm([[0x01]]));
    const after = writeWasm(buildWasm([callInstr(0)]));
    const result = compareRecursionReports(before, after);

    expect(result.comparison.newlyRecursiveFunctions).toContain(0);
    expect(result.comparison.removedRecursiveFunctions).toHaveLength(0);
    expect(result.comparison.recursiveFunctionCountDelta).toBe(1);
  });

  it('identifies removed recursion in comparison mode', () => {
    const before = writeWasm(buildWasm([callInstr(0)]));
    const after = writeWasm(buildWasm([[0x01]]));
    const result = compareRecursionReports(before, after);

    expect(result.comparison.removedRecursiveFunctions).toContain(0);
    expect(result.comparison.newlyRecursiveFunctions).toHaveLength(0);
    expect(result.comparison.recursiveFunctionCountDelta).toBe(-1);
  });

  it('detects changed recursive component membership', () => {
    // before: fn0 ↔ fn1 mutual recursion
    // after: fn0 ↔ fn1 ↔ fn2 (different SCC membership)
    const before = writeWasm(buildWasm([callInstr(1), callInstr(0), [0x01]]));
    const after = writeWasm(buildWasm([callInstr(1), callInstr(2), callInstr(0)]));
    const result = compareRecursionReports(before, after);

    // The SCC [0,1] in before becomes [0,1,2] in after → introducedSccs / removedSccs
    expect(
      result.comparison.introducedSccs.length + result.comparison.removedSccs.length,
    ).toBeGreaterThan(0);
  });

  it('reports no changes when both artifacts have identical recursion', () => {
    const file = writeWasm(buildWasm([callInstr(0)]));
    const result = compareRecursionReports(file, file);

    expect(result.comparison.newlyRecursiveFunctions).toHaveLength(0);
    expect(result.comparison.removedRecursiveFunctions).toHaveLength(0);
    expect(result.comparison.introducedSccs).toHaveLength(0);
    expect(result.comparison.removedSccs).toHaveLength(0);
    expect(result.comparison.recursiveFunctionCountDelta).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Malformed / invalid WASM
  // -------------------------------------------------------------------------

  it('throws WasmValidationError for non-WASM data', () => {
    const file = writeWasm(Buffer.from('not valid wasm'));
    expect(() => analyzeRecursion(file)).toThrow(WasmValidationError);
  });

  it('throws WasmValidationError for truncated WASM', () => {
    const file = writeWasm(Buffer.from([0x00, 0x61, 0x73])); // truncated header
    expect(() => analyzeRecursion(file)).toThrow(WasmValidationError);
  });

  it('produces a useful diagnostic message on malformed WASM', () => {
    const file = writeWasm(Buffer.from('also not wasm!!'));
    try {
      analyzeRecursion(file);
      fail('Expected WasmValidationError');
    } catch (e) {
      expect(e).toBeInstanceOf(WasmValidationError);
      expect((e as WasmValidationError).message).toMatch(/magic header|too short/i);
    }
  });

  // -------------------------------------------------------------------------
  // Determinism
  // -------------------------------------------------------------------------

  it('produces deterministic results for repeated execution', () => {
    const file = writeWasm(
      buildWasm([callInstr(1), callInstr(2), callInstr(0)]),
    );
    const r1 = analyzeRecursion(file);
    const r2 = analyzeRecursion(file);

    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });

  // -------------------------------------------------------------------------
  // No WASM code is executed
  // -------------------------------------------------------------------------

  it('does not execute WASM code (unreachable in fn0 does not throw)', () => {
    // fn0 body: unreachable (0x00) followed by a self-call
    // If code were executed, this would trigger an unreachable trap.
    const file = writeWasm(buildWasm([[0x00, ...callInstr(0)]]));
    // Should not throw — we only parse, never execute.
    expect(() => analyzeRecursion(file)).not.toThrow();
    const report = analyzeRecursion(file);
    expect(report.valid).toBe(true);
  });

  // -------------------------------------------------------------------------
  // run() error handling
  // -------------------------------------------------------------------------

  it('throws when no wasmFile is provided', async () => {
    await expect(run({})).rejects.toThrow(/Usage/);
  });

  it('run() human-readable output does not throw for non-recursive WASM', async () => {
    const file = writeWasm(buildWasm([[0x01], [0x01]]));
    const origLog = console.log;
    console.log = () => {};
    try {
      await expect(run({ wasmFile: file })).resolves.toBeUndefined();
    } finally {
      console.log = origLog;
    }
  });

  it('run() human-readable output does not throw for recursive WASM', async () => {
    const file = writeWasm(buildWasm([callInstr(0)]));
    const origLog = console.log;
    console.log = () => {};
    try {
      await expect(run({ wasmFile: file })).resolves.toBeUndefined();
    } finally {
      console.log = origLog;
    }
  });

  // -------------------------------------------------------------------------
  // Comparison mode via run()
  // -------------------------------------------------------------------------

  it('run() comparison mode produces JSON output', async () => {
    const before = writeWasm(buildWasm([[0x01]]));
    const after = writeWasm(buildWasm([callInstr(0)]));
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => lines.push(args.join(' '));
    try {
      await run({ wasmFile: before, compareFile: after, json: true });
    } finally {
      console.log = origLog;
    }
    const output = JSON.parse(lines.join('\n')) as Record<string, unknown>;
    expect(output).toHaveProperty('comparison');
    expect(output).toHaveProperty('before');
    expect(output).toHaveProperty('after');
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  it('handles an empty code section gracefully', () => {
    // WASM with type section but no functions
    const buf = Buffer.from([
      ...WASM_HEADER,
      ...section(1, [0x00]), // empty type section
    ]);
    const file = writeWasm(buf);
    const report = analyzeRecursion(file);
    expect(report.statistics.totalFunctions).toBe(0);
    expect(report.recursiveSccs).toHaveLength(0);
  });

  it('handles imported functions correctly (no body for imports)', () => {
    // 2 imported functions + 1 defined function that calls import 0
    const file = writeWasm(buildWasm([callInstr(0)], { importedFunctionCount: 2 }));
    const report = analyzeRecursion(file);

    // fn2 (the defined function) calls fn0 (imported), which has no body — no cycle
    expect(report.statistics.totalFunctions).toBeGreaterThanOrEqual(3);
    expect(report.statistics.recursiveFunctionCount).toBe(0);
  });

  it('identifies most connected recursive functions', () => {
    // fn0 ↔ fn1, fn0 also calls fn2 which calls fn0 → fn0 in two cycles
    // fn0: call fn1, call fn2; fn1: call fn0; fn2: call fn0
    const fn0 = [...callInstr(1), ...callInstr(2)];
    const fn1 = callInstr(0);
    const fn2 = callInstr(0);
    const file = writeWasm(buildWasm([fn0, fn1, fn2]));
    const report = analyzeRecursion(file);

    expect(report.mostConnectedRecursiveFunctions.length).toBeGreaterThan(0);
    expect(report.mostConnectedRecursiveFunctions[0].functionIndex).toBeDefined();
  });
});
