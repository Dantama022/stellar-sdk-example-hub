import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  analyzeSideEffects,
  compareSideEffectReports,
  WasmValidationError,
} from '../src/utils/wasm-static-analysis';
import { reportToCsv, reportToDot } from '../src/examples/280-wasm-side-effects';

// ---------------------------------------------------------------------------
// WASM binary building helpers
// ---------------------------------------------------------------------------

function uLEB(value: number): number[] {
  const bytes: number[] = [];
  let v = value >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    bytes.push(b);
  } while (v !== 0);
  return bytes;
}

const MAGIC = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

function makeSection(id: number, payload: number[]): number[] {
  return [id, ...uLEB(payload.length), ...payload];
}

function makeStr(s: string): number[] {
  const b = Buffer.from(s, 'utf8');
  return [...uLEB(b.length), ...b];
}

/**
 * Build a minimal WASM binary.
 * @param bodies      Array of function body bytes (one per defined function, no trailing end needed)
 * @param imports     Array of {module, name} import entries (all functions using type 0)
 * @param mutGlobals  Number of mutable i32 globals to define
 * @param immGlobals  Number of immutable i32 globals to define
 * @param exportFns   Map of functionIndex -> exportName
 */
function buildWasm(options: {
  bodies?: number[][];
  imports?: Array<{ module: string; name: string }>;
  mutGlobals?: number;
  immGlobals?: number;
  exportFns?: Map<number, string>;
}): Buffer {
  const {
    bodies = [],
    imports = [],
    mutGlobals = 0,
    immGlobals = 0,
    exportFns = new Map(),
  } = options;

  const numImports = imports.length;
  const numDefined = bodies.length;
  const numGlobals = mutGlobals + immGlobals;

  const sections: number[] = [];

  // Type section: one type () -> ()
  sections.push(...makeSection(1, [0x01, 0x60, 0x00, 0x00]));

  // Import section (if any)
  if (numImports > 0) {
    const importPayload: number[] = [...uLEB(numImports)];
    for (const imp of imports) {
      importPayload.push(...makeStr(imp.module), ...makeStr(imp.name), 0x00, 0x00); // kind=func, typeIdx=0
    }
    sections.push(...makeSection(2, importPayload));
  }

  // Function section: each defined function uses type 0
  if (numDefined > 0) {
    sections.push(...makeSection(3, [...uLEB(numDefined), ...new Array(numDefined).fill(0x00)]));
  }

  // Global section
  if (numGlobals > 0) {
    const globalPayload: number[] = [...uLEB(numGlobals)];
    for (let i = 0; i < mutGlobals; i++) {
      globalPayload.push(0x7f, 0x01, 0x41, 0x00, 0x0b); // i32, mutable, i32.const 0, end
    }
    for (let i = 0; i < immGlobals; i++) {
      globalPayload.push(0x7f, 0x00, 0x41, 0x2a, 0x0b); // i32, immutable, i32.const 42, end
    }
    sections.push(...makeSection(6, globalPayload));
  }

  // Export section
  const exports: Array<{ name: string; kind: number; idx: number }> = [];
  exportFns.forEach((name, idx) => exports.push({ name, kind: 0x00, idx }));
  if (exports.length > 0) {
    const exportPayload: number[] = [...uLEB(exports.length)];
    for (const exp of exports) {
      exportPayload.push(...makeStr(exp.name), exp.kind, ...uLEB(exp.idx));
    }
    sections.push(...makeSection(7, exportPayload));
  }

  // Code section
  if (numDefined > 0) {
    const codePayload: number[] = [...uLEB(numDefined)];
    for (const body of bodies) {
      // Each body: [0x00 (no locals), ...body, 0x0b (end)]
      const fullBody = [0x00, ...body, 0x0b];
      codePayload.push(...uLEB(fullBody.length), ...fullBody);
    }
    sections.push(...makeSection(10, codePayload));
  }

  return Buffer.from([...MAGIC, ...sections]);
}

function tmpFile(buf: Buffer): string {
  const p = path.join(
    os.tmpdir(),
    `se-test-${Date.now()}-${Math.random().toString(36).slice(2)}.wasm`,
  );
  fs.writeFileSync(p, buf);
  return p;
}

// Opcode shorthands
const NOP = 0x01;
const I32_CONST_0 = [0x41, 0x00];
const I32_CONST_1 = [0x41, 0x01];
const I32_ADD = 0x6a;
const DROP = 0x1a;
const I32_STORE = [0x36, 0x00, 0x00]; // i32.store align=0 offset=0
const I32_LOAD = [0x28, 0x00, 0x00];  // i32.load align=0 offset=0
const GLOBAL_GET_0 = [0x23, 0x00];
const GLOBAL_SET_0 = [0x24, 0x00];
const CALL_0 = [0x10, 0x00];
const CALL_1 = [0x10, 0x01];
const CALL_INDIRECT = [0x11, 0x00, 0x00]; // call_indirect type=0 table=0
const UNREACHABLE = 0x00;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WASM side-effect analysis', () => {
  // -------------------------------------------------------------------------
  // Pure functions
  // -------------------------------------------------------------------------
  describe('pure function', () => {
    it('classifies arithmetic-only function as pure', () => {
      const file = tmpFile(buildWasm({ bodies: [[...I32_CONST_0, ...I32_CONST_1, I32_ADD, DROP]] }));
      const report = analyzeSideEffects(file);
      const fn = report.functions.find((f) => f.source === 'defined')!;
      expect(fn.classification).toBe('pure');
    });

    it('pure function has empty side-effect evidence', () => {
      const file = tmpFile(buildWasm({ bodies: [[...I32_CONST_0, DROP]] }));
      const report = analyzeSideEffects(file);
      const fn = report.functions.find((f) => f.source === 'defined')!;
      expect(fn.evidence.memoryStores).toHaveLength(0);
      expect(fn.evidence.globalWrites).toHaveLength(0);
      expect(fn.evidence.importedCalls).toHaveLength(0);
      expect(fn.evidence.hasIndirectCall).toBe(false);
    });

    it('calling a pure function keeps the caller pure', () => {
      const file = tmpFile(
        buildWasm({
          bodies: [
            [...I32_CONST_0, DROP], // fn0: pure
            [...CALL_0, NOP],       // fn1: calls fn0
          ],
        }),
      );
      const report = analyzeSideEffects(file);
      const fn1 = report.functions.find((f) => f.functionIndex === 1)!;
      expect(fn1.classification).toBe('pure');
    });
  });

  // -------------------------------------------------------------------------
  // Immutable globals → pure
  // -------------------------------------------------------------------------
  describe('immutable global reads', () => {
    it('reading immutable global keeps function pure', () => {
      const file = tmpFile(
        buildWasm({ bodies: [[...GLOBAL_GET_0, DROP]], immGlobals: 1 }),
      );
      const report = analyzeSideEffects(file);
      const fn = report.functions.find((f) => f.source === 'defined')!;
      expect(fn.classification).toBe('pure');
      expect(fn.evidence.immutableGlobalReads).toContain(0);
    });
  });

  // -------------------------------------------------------------------------
  // Mutable global reads → read_only
  // -------------------------------------------------------------------------
  describe('mutable global reads', () => {
    it('reading a mutable global produces read_only classification', () => {
      const file = tmpFile(
        buildWasm({ bodies: [[...GLOBAL_GET_0, DROP]], mutGlobals: 1 }),
      );
      const report = analyzeSideEffects(file);
      const fn = report.functions.find((f) => f.source === 'defined')!;
      expect(fn.classification).toBe('read_only');
      expect(fn.evidence.mutableGlobalReads).toContain(0);
    });

    it('reading memory produces read_only classification', () => {
      const file = tmpFile(buildWasm({ bodies: [[...I32_CONST_0, ...I32_LOAD, DROP]] }));
      const report = analyzeSideEffects(file);
      const fn = report.functions.find((f) => f.source === 'defined')!;
      expect(fn.classification).toBe('read_only');
      expect(fn.evidence.memoryLoads).toContain('i32.load');
    });
  });

  // -------------------------------------------------------------------------
  // Mutable global writes → state_mutating
  // -------------------------------------------------------------------------
  describe('mutable global writes', () => {
    it('writing a mutable global produces state_mutating classification', () => {
      const file = tmpFile(
        buildWasm({ bodies: [[...I32_CONST_0, ...GLOBAL_SET_0]], mutGlobals: 1 }),
      );
      const report = analyzeSideEffects(file);
      const fn = report.functions.find((f) => f.source === 'defined')!;
      expect(fn.classification).toBe('state_mutating');
      expect(fn.evidence.globalWrites).toContain(0);
    });
  });

  // -------------------------------------------------------------------------
  // Memory writes → state_mutating
  // -------------------------------------------------------------------------
  describe('memory writes', () => {
    it('i32.store produces state_mutating classification', () => {
      const file = tmpFile(
        buildWasm({ bodies: [[...I32_CONST_0, ...I32_CONST_1, ...I32_STORE]] }),
      );
      const report = analyzeSideEffects(file);
      const fn = report.functions.find((f) => f.source === 'defined')!;
      expect(fn.classification).toBe('state_mutating');
      expect(fn.evidence.memoryStores).toContain('i32.store');
    });
  });

  // -------------------------------------------------------------------------
  // Imported function calls → externally_dependent
  // -------------------------------------------------------------------------
  describe('imported function calls', () => {
    it('calling an imported function produces externally_dependent', () => {
      const file = tmpFile(
        buildWasm({
          imports: [{ module: 'env', name: 'log' }],
          bodies: [[...CALL_0]],
        }),
      );
      const report = analyzeSideEffects(file);
      const imp = report.functions.find((f) => f.source === 'imported')!;
      expect(imp.classification).toBe('externally_dependent');
      const fn1 = report.functions.find((f) => f.functionIndex === 1)!;
      expect(fn1.classification).toBe('externally_dependent');
      expect(fn1.evidence.importedCalls).toContain(0);
    });

    it('imported functions appear in report statistics', () => {
      const file = tmpFile(
        buildWasm({ imports: [{ module: 'env', name: 'abort' }], bodies: [[]] }),
      );
      const report = analyzeSideEffects(file);
      expect(report.statistics.importedFunctionCount).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Transitive side effects
  // -------------------------------------------------------------------------
  describe('transitive side effects', () => {
    it('propagates state_mutating through a multi-level call chain', () => {
      const file = tmpFile(
        buildWasm({
          bodies: [
            [...I32_CONST_0, ...I32_CONST_1, ...I32_STORE], // fn0: state_mutating
            [...CALL_0],                                      // fn1: calls fn0
            [...CALL_1],                                      // fn2: calls fn1
          ],
        }),
      );
      const report = analyzeSideEffects(file);
      const fn1 = report.functions.find((f) => f.functionIndex === 1)!;
      const fn2 = report.functions.find((f) => f.functionIndex === 2)!;
      expect(fn1.classification).toBe('state_mutating');
      expect(fn1.hasTransitiveEffects).toBe(true);
      expect(fn2.classification).toBe('state_mutating');
      expect(fn2.hasTransitiveEffects).toBe(true);
    });

    it('propagates externally_dependent through call chain', () => {
      const file = tmpFile(
        buildWasm({
          imports: [{ module: 'env', name: 'ext' }],
          bodies: [
            [...CALL_0], // fn1 (idx=1): calls import
            [...CALL_1], // fn2 (idx=2): calls fn1
          ],
        }),
      );
      const report = analyzeSideEffects(file);
      const fn2 = report.functions.find((f) => f.functionIndex === 2)!;
      expect(fn2.classification).toBe('externally_dependent');
      expect(fn2.hasTransitiveEffects).toBe(true);
    });

    it('detects locally-pure functions that are transitively effectful', () => {
      const file = tmpFile(
        buildWasm({
          bodies: [
            [...I32_CONST_0, ...I32_CONST_1, ...I32_STORE], // fn0: state_mutating
            [...CALL_0],                                      // fn1: no direct effects
          ],
        }),
      );
      const report = analyzeSideEffects(file);
      const fn1 = report.functions.find((f) => f.functionIndex === 1)!;
      expect(fn1.classification).toBe('state_mutating');
      expect(fn1.hasTransitiveEffects).toBe(true);
      expect(fn1.evidence.transitiveMutatingCallees).toContain(0);
    });

    it('caller inherits state_mutating from callee via global write', () => {
      const file = tmpFile(
        buildWasm({
          bodies: [
            [...I32_CONST_0, ...GLOBAL_SET_0], // fn0: writes global
            [...CALL_0],                        // fn1: calls fn0
          ],
          mutGlobals: 1,
        }),
      );
      const report = analyzeSideEffects(file);
      const fn1 = report.functions.find((f) => f.functionIndex === 1)!;
      expect(fn1.classification).toBe('state_mutating');
    });
  });

  // -------------------------------------------------------------------------
  // Effectful: both state_mutating + externally_dependent
  // -------------------------------------------------------------------------
  describe('effectful classification', () => {
    it('function writing memory AND calling import is effectful', () => {
      const file = tmpFile(
        buildWasm({
          imports: [{ module: 'env', name: 'log' }],
          bodies: [
            [...I32_CONST_0, ...I32_CONST_1, ...I32_STORE, ...CALL_0],
          ],
        }),
      );
      const report = analyzeSideEffects(file);
      const fn1 = report.functions.find((f) => f.functionIndex === 1)!;
      expect(fn1.classification).toBe('effectful');
    });
  });

  // -------------------------------------------------------------------------
  // Indirect calls → unknown
  // -------------------------------------------------------------------------
  describe('indirect calls (unknown)', () => {
    it('call_indirect produces unknown classification', () => {
      const file = tmpFile(buildWasm({ bodies: [[...I32_CONST_0, ...CALL_INDIRECT]] }));
      const report = analyzeSideEffects(file);
      const fn = report.functions.find((f) => f.source === 'defined')!;
      expect(fn.classification).toBe('unknown');
      expect(fn.evidence.hasIndirectCall).toBe(true);
    });

    it('unresolved indirect calls do not produce false purity claims', () => {
      // fn0 has call_indirect (unknown), fn1 calls fn0
      const file = tmpFile(
        buildWasm({
          bodies: [
            [...I32_CONST_0, ...CALL_INDIRECT], // fn0: unknown
            [...CALL_0],                         // fn1: calls fn0
          ],
        }),
      );
      const report = analyzeSideEffects(file);
      const fn1 = report.functions.find((f) => f.functionIndex === 1)!;
      // fn1 calls unknown fn0 → should not be classified as pure
      expect(fn1.classification).not.toBe('pure');
    });
  });

  // -------------------------------------------------------------------------
  // Recursive functions
  // -------------------------------------------------------------------------
  describe('recursive functions', () => {
    it('self-recursive pure function converges to pure', () => {
      const file = tmpFile(
        buildWasm({ bodies: [[...I32_CONST_0, DROP, ...CALL_0]] }),
      );
      const report = analyzeSideEffects(file);
      const fn0 = report.functions.find((f) => f.functionIndex === 0)!;
      expect(fn0.classification).toBe('pure');
    });

    it('self-recursive memory-writing function stays state_mutating', () => {
      const file = tmpFile(
        buildWasm({ bodies: [[...I32_CONST_0, ...I32_CONST_1, ...I32_STORE, ...CALL_0]] }),
      );
      const report = analyzeSideEffects(file);
      const fn0 = report.functions.find((f) => f.functionIndex === 0)!;
      expect(fn0.classification).toBe('state_mutating');
    });

    it('mutually recursive pure functions converge to pure', () => {
      const file = tmpFile(
        buildWasm({
          bodies: [
            [...CALL_1], // fn0 calls fn1
            [...CALL_0], // fn1 calls fn0
          ],
        }),
      );
      const report = analyzeSideEffects(file);
      const fn0 = report.functions.find((f) => f.functionIndex === 0)!;
      const fn1 = report.functions.find((f) => f.functionIndex === 1)!;
      expect(fn0.classification).toBe('pure');
      expect(fn1.classification).toBe('pure');
    });

    it('mutually recursive with one side-effecting function → both state_mutating', () => {
      const file = tmpFile(
        buildWasm({
          bodies: [
            [...I32_CONST_0, ...I32_CONST_1, ...I32_STORE, ...CALL_1], // fn0: writes + calls fn1
            [...CALL_0],                                                  // fn1: calls fn0
          ],
        }),
      );
      const report = analyzeSideEffects(file);
      const fn1 = report.functions.find((f) => f.functionIndex === 1)!;
      expect(fn1.classification).toBe('state_mutating');
    });
  });

  // -------------------------------------------------------------------------
  // Unreachable instructions
  // -------------------------------------------------------------------------
  describe('unreachable instructions', () => {
    it('unreachable instruction is flagged in evidence', () => {
      const file = tmpFile(buildWasm({ bodies: [[UNREACHABLE]] }));
      const report = analyzeSideEffects(file);
      const fn = report.functions.find((f) => f.source === 'defined')!;
      expect(fn.evidence.hasUnreachable).toBe(true);
    });

    it('memory store after unreachable is excluded from reachable evidence', () => {
      // unreachable, then i32.store — store is in dead code
      const file = tmpFile(
        buildWasm({ bodies: [[UNREACHABLE, ...I32_CONST_0, ...I32_CONST_1, ...I32_STORE]] }),
      );
      const report = analyzeSideEffects(file);
      const fn = report.functions.find((f) => f.source === 'defined')!;
      expect(fn.evidence.memoryStores).toHaveLength(0);
      expect(fn.evidence.hasUnreachable).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Statistics
  // -------------------------------------------------------------------------
  describe('statistics', () => {
    it('calculates correct summary counts', () => {
      const file = tmpFile(
        buildWasm({
          imports: [{ module: 'env', name: 'log' }],
          bodies: [
            [...I32_CONST_0, DROP],                           // fn1: pure
            [...I32_CONST_0, ...I32_CONST_1, ...I32_STORE],  // fn2: state_mutating
          ],
        }),
      );
      const report = analyzeSideEffects(file);
      expect(report.statistics.importedFunctionCount).toBe(1);
      expect(report.statistics.definedFunctionCount).toBe(2);
      expect(report.statistics.totalAnalyzedFunctions).toBe(3);
      expect(report.statistics.pureFunctions).toBe(1);
      expect(report.statistics.stateMutatingFunctions).toBe(1);
      expect(report.statistics.externallyDependentFunctions).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Call graph
  // -------------------------------------------------------------------------
  describe('call graph', () => {
    it('produces normalized call graph with correct edges', () => {
      const file = tmpFile(
        buildWasm({
          bodies: [
            [...CALL_1], // fn0 calls fn1
            [],          // fn1: no calls
          ],
        }),
      );
      const report = analyzeSideEffects(file);
      expect(report.callGraph[0]).toContain(1);
      expect(report.callGraph[1]).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // JSON output
  // -------------------------------------------------------------------------
  describe('JSON output', () => {
    it('produces valid serializable JSON with required fields', () => {
      const file = tmpFile(buildWasm({ bodies: [[...I32_CONST_0, DROP]] }));
      const report = analyzeSideEffects(file);
      const json = JSON.stringify(report);
      const parsed = JSON.parse(json);
      expect(parsed.valid).toBe(true);
      expect(parsed.functions).toBeDefined();
      expect(parsed.statistics).toBeDefined();
      expect(parsed.callGraph).toBeDefined();
    });

    it('JSON output contains stable function identifiers', () => {
      const file = tmpFile(buildWasm({ bodies: [[...I32_CONST_0, DROP]] }));
      const report = analyzeSideEffects(file);
      const fn = report.functions.find((f) => f.source === 'defined')!;
      expect(typeof fn.functionIndex).toBe('number');
      expect(fn.classification).toBe('pure');
    });
  });

  // -------------------------------------------------------------------------
  // CSV output
  // -------------------------------------------------------------------------
  describe('CSV output', () => {
    it('produces CSV with header row and one row per function', () => {
      const file = tmpFile(
        buildWasm({
          imports: [{ module: 'env', name: 'log' }],
          bodies: [[...I32_CONST_0, DROP]],
        }),
      );
      const report = analyzeSideEffects(file);
      const csv = reportToCsv(report);
      const lines = csv.split('\n');
      expect(lines.length).toBe(3); // header + 2 functions
      expect(lines[0]).toContain('functionIndex');
      expect(lines[0]).toContain('classification');
    });

    it('CSV row contains classification value', () => {
      const file = tmpFile(buildWasm({ bodies: [[...I32_CONST_0, DROP]] }));
      const report = analyzeSideEffects(file);
      const csv = reportToCsv(report);
      expect(csv).toContain('pure');
    });
  });

  // -------------------------------------------------------------------------
  // DOT output
  // -------------------------------------------------------------------------
  describe('DOT output', () => {
    it('produces valid DOT digraph header', () => {
      const file = tmpFile(buildWasm({ bodies: [[...I32_CONST_0, DROP]] }));
      const report = analyzeSideEffects(file);
      const dot = reportToDot(report);
      expect(dot).toContain('digraph side_effects');
      expect(dot).toContain('fn0');
    });

    it('DOT output includes edges for direct calls', () => {
      const file = tmpFile(
        buildWasm({
          bodies: [
            [...I32_CONST_0, DROP],
            [...CALL_0], // fn1 calls fn0
          ],
        }),
      );
      const report = analyzeSideEffects(file);
      const dot = reportToDot(report);
      expect(dot).toContain('fn1 -> fn0');
    });
  });

  // -------------------------------------------------------------------------
  // Two-artifact comparison mode
  // -------------------------------------------------------------------------
  describe('two-artifact comparison', () => {
    it('detects functions that became effectful', () => {
      const before = tmpFile(buildWasm({ bodies: [[...I32_CONST_0, DROP]] }));
      const after = tmpFile(buildWasm({ bodies: [[...I32_CONST_0, ...I32_CONST_1, ...I32_STORE]] }));
      const result = compareSideEffectReports(before, after);
      expect(result.comparison.becameEffectful).toContain(0);
    });

    it('detects functions that became side-effect-free', () => {
      const before = tmpFile(buildWasm({ bodies: [[...I32_CONST_0, ...I32_CONST_1, ...I32_STORE]] }));
      const after = tmpFile(buildWasm({ bodies: [[...I32_CONST_0, DROP]] }));
      const result = compareSideEffectReports(before, after);
      expect(result.comparison.becameSideEffectFree).toContain(0);
    });

    it('detects newly introduced memory writes', () => {
      const before = tmpFile(buildWasm({ bodies: [[...I32_CONST_0, DROP]] }));
      const after = tmpFile(buildWasm({ bodies: [[...I32_CONST_0, ...I32_CONST_1, ...I32_STORE]] }));
      const result = compareSideEffectReports(before, after);
      expect(result.comparison.newMemoryWrites).toContain(0);
    });

    it('detects newly introduced global writes', () => {
      const before = tmpFile(buildWasm({ bodies: [[...I32_CONST_0, DROP]], mutGlobals: 1 }));
      const after = tmpFile(buildWasm({ bodies: [[...I32_CONST_0, ...GLOBAL_SET_0]], mutGlobals: 1 }));
      const result = compareSideEffectReports(before, after);
      expect(result.comparison.newGlobalWrites).toContain(0);
    });

    it('populates classificationChanges for modified functions', () => {
      const before = tmpFile(buildWasm({ bodies: [[...I32_CONST_0, DROP]] }));
      const after = tmpFile(buildWasm({ bodies: [[...I32_CONST_0, ...I32_CONST_1, ...I32_STORE]] }));
      const result = compareSideEffectReports(before, after);
      const change = result.comparison.classificationChanges.find((c) => c.functionIndex === 0);
      expect(change).toBeDefined();
      expect(change!.before).toBe('pure');
      expect(change!.after).toBe('state_mutating');
    });

    it('detects changed transitive side effects', () => {
      // before: fn0 pure, fn1 calls fn0 (pure)
      const before = tmpFile(
        buildWasm({
          bodies: [
            [...I32_CONST_0, DROP], // fn0: pure
            [...CALL_0],             // fn1: pure transitively
          ],
        }),
      );
      // after: fn0 state_mutating, fn1 calls fn0 (now has transitive)
      const after = tmpFile(
        buildWasm({
          bodies: [
            [...I32_CONST_0, ...I32_CONST_1, ...I32_STORE], // fn0: state_mutating
            [...CALL_0],                                      // fn1: transitive
          ],
        }),
      );
      const result = compareSideEffectReports(before, after);
      expect(result.comparison.changedTransitiveEffects).toContain(1);
    });
  });

  // -------------------------------------------------------------------------
  // Malformed WASM input
  // -------------------------------------------------------------------------
  describe('malformed WASM input', () => {
    it('throws WasmValidationError for non-WASM input', () => {
      const file = tmpFile(Buffer.from('not wasm binary'));
      expect(() => analyzeSideEffects(file)).toThrow(WasmValidationError);
    });

    it('throws WasmValidationError for truncated WASM (too short)', () => {
      const file = tmpFile(Buffer.from([0x00, 0x61, 0x73, 0x6d]));
      expect(() => analyzeSideEffects(file)).toThrow(WasmValidationError);
    });
  });

  // -------------------------------------------------------------------------
  // Deterministic results
  // -------------------------------------------------------------------------
  describe('determinism', () => {
    it('produces identical results on repeated execution', () => {
      const file = tmpFile(
        buildWasm({
          imports: [{ module: 'env', name: 'ext' }],
          bodies: [
            [...I32_CONST_0, DROP],
            [...I32_CONST_0, ...I32_CONST_1, ...I32_STORE],
            [...CALL_0],
          ],
        }),
      );
      const r1 = analyzeSideEffects(file);
      const r2 = analyzeSideEffects(file);
      expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
    });
  });

  // -------------------------------------------------------------------------
  // No WASM code execution
  // -------------------------------------------------------------------------
  describe('no code execution', () => {
    it('returns valid offline analysis without executing contract code', () => {
      const file = tmpFile(buildWasm({ bodies: [[...I32_CONST_0, DROP]] }));
      const report = analyzeSideEffects(file);
      expect(report.valid).toBe(true);
      // Evidence is from byte-level parsing, not runtime
      expect(typeof report.callGraph).toBe('object');
    });
  });

  // -------------------------------------------------------------------------
  // Export names
  // -------------------------------------------------------------------------
  describe('export names', () => {
    it('includes export name in function info when exported', () => {
      const file = tmpFile(
        buildWasm({
          bodies: [[...I32_CONST_0, DROP]],
          exportFns: new Map([[0, 'main']]),
        }),
      );
      const report = analyzeSideEffects(file);
      const fn = report.functions.find((f) => f.functionIndex === 0)!;
      expect(fn.exportName).toBe('main');
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------
  describe('edge cases', () => {
    it('handles empty module (no functions) without error', () => {
      const file = tmpFile(buildWasm({}));
      const report = analyzeSideEffects(file);
      expect(report.statistics.totalAnalyzedFunctions).toBe(0);
    });

    it('handles module with only imports without error', () => {
      const file = tmpFile(
        buildWasm({ imports: [{ module: 'wasi', name: 'proc_exit' }] }),
      );
      const report = analyzeSideEffects(file);
      expect(report.statistics.importedFunctionCount).toBe(1);
      expect(report.statistics.definedFunctionCount).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Pure classification smoke test
  // -------------------------------------------------------------------------
  describe('pure classification', () => {
    it('function with only NOP is pure', () => {
      const file = tmpFile(buildWasm({ bodies: [[NOP]] }));
      const report = analyzeSideEffects(file);
      const fn = report.functions.find((f) => f.source === 'defined')!;
      expect(fn.classification).toBe('pure');
    });
  });

  // -------------------------------------------------------------------------
  // Read-only classification
  // -------------------------------------------------------------------------
  describe('read_only classification', () => {
    it('function reading mutable global is read_only not pure', () => {
      const file = tmpFile(
        buildWasm({ bodies: [[...GLOBAL_GET_0, DROP]], mutGlobals: 1 }),
      );
      const report = analyzeSideEffects(file);
      const fn = report.functions.find((f) => f.source === 'defined')!;
      expect(fn.classification).toBe('read_only');
    });
  });

  // -------------------------------------------------------------------------
  // Unknown classification
  // -------------------------------------------------------------------------
  describe('unknown classification', () => {
    it('function with call_indirect is unknown', () => {
      const file = tmpFile(buildWasm({ bodies: [[...I32_CONST_0, ...CALL_INDIRECT]] }));
      const report = analyzeSideEffects(file);
      const fn = report.functions.find((f) => f.source === 'defined')!;
      expect(fn.classification).toBe('unknown');
    });

    it('unknown remains unknown — not incorrectly labeled pure', () => {
      const file = tmpFile(buildWasm({ bodies: [[...I32_CONST_0, ...CALL_INDIRECT]] }));
      const report = analyzeSideEffects(file);
      const fn = report.functions.find((f) => f.source === 'defined')!;
      expect(fn.classification).not.toBe('pure');
    });
  });
});
