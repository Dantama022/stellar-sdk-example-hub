/**
 * Tests for ISSUE-268 (WASM constant propagation analysis).
 *
 * The analysis is conservative and completely offline: values are derived by
 * evaluating operator tables, never by executing the contract.
 */

import {
  analyzeConstantPropagation,
  analyzeConstantPropagationFile,
  compareConstantPropagation,
  constantKey,
  constantPropagationToCsv,
  formatConstantComparison,
  formatConstantPropagationReport,
} from '../src/wasm/constantPropagation';
import * as constantPropagationModule from '../src/wasm/constantPropagation';
import { parseWasmModule, WasmParseError } from '../src/wasm/wasmBinary';
import { buildModule, op } from './helpers/wasmFixtures';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Builds a module with a single function from the given instruction bytes. */
function single(body: number[]): Buffer {
  return buildModule({ bodies: [body] });
}

/** Returns the findings of a single function module. */
function findingsOf(body: number[]) {
  return analyzeConstantPropagation(parseWasmModule(single(body)), 'a.wasm').findings;
}

describe('ISSUE-268: WASM constant propagation analysis', () => {
  // ─── Literals and arithmetic ───────────────────────────────────────────────

  describe('constant detection', () => {
    it('detects a simple integer constant', () => {
      const findings = findingsOf([...op.i32Const(42)]);
      const constant = findings.find((finding) => finding.type === 'constant');

      expect(constant).toBeDefined();
      expect(constant?.opcode).toBe('i32.const');
      expect(constant?.value).toBe('42');
      expect(constant?.valueType).toBe('i32');
      expect(constant?.blockIndex).toBeGreaterThanOrEqual(0);
      expect(constant?.instructionIndex).toBe(0);
    });

    it('detects an i64 constant', () => {
      const findings = findingsOf([...op.i64Const(7)]);
      const constant = findings.find((finding) => finding.type === 'constant');

      expect(constant?.valueType).toBe('i64');
      expect(constant?.value).toBe('7');
    });

    it('evaluates a constant addition', () => {
      const findings = findingsOf([...op.i32Const(2), ...op.i32Const(3), ...op.i32Add()]);
      const derived = findings.find((finding) => finding.type === 'derived');

      expect(derived?.opcode).toBe('i32.add');
      expect(derived?.value).toBe('5');
    });

    it('evaluates a constant subtraction', () => {
      const findings = findingsOf([...op.i32Const(10), ...op.i32Const(4), ...op.i32Sub()]);
      expect(findings.find((finding) => finding.type === 'derived')?.value).toBe('6');
    });

    it('evaluates a constant multiplication', () => {
      const findings = findingsOf([...op.i32Const(6), ...op.i32Const(7), ...op.i32Mul()]);
      expect(findings.find((finding) => finding.type === 'derived')?.value).toBe('42');
    });

    it('evaluates constant bitwise operations', () => {
      const and = findingsOf([...op.i32Const(0xf0), ...op.i32Const(0x0f), ...op.i32And()]);
      const or = findingsOf([...op.i32Const(0xf0), ...op.i32Const(0x0f), ...op.i32Or()]);
      const xor = findingsOf([...op.i32Const(0xff), ...op.i32Const(0x0f), ...op.i32Xor()]);
      const shl = findingsOf([...op.i32Const(1), ...op.i32Const(4), ...op.i32Shl()]);

      expect(and.find((finding) => finding.type === 'derived')?.value).toBe('0');
      expect(or.find((finding) => finding.type === 'derived')?.value).toBe('255');
      expect(xor.find((finding) => finding.type === 'derived')?.value).toBe('240');
      expect(shl.find((finding) => finding.type === 'derived')?.value).toBe('16');
    });

    it('evaluates a constant comparison', () => {
      const findings = findingsOf([...op.i32Const(1), ...op.i32Const(2), ...op.i32Eq()]);
      const comparison = findings.find((finding) => finding.type === 'comparison');

      expect(comparison?.opcode).toBe('i32.eq');
      expect(comparison?.value).toBe('0');
    });

    it('evaluates a constant comparison that is true', () => {
      const findings = findingsOf([...op.i32Const(2), ...op.i32Const(2), ...op.i32Eq()]);
      expect(findings.find((finding) => finding.type === 'comparison')?.value).toBe('1');
    });

    it('does not evaluate an operation with an unknown operand', () => {
      const findings = findingsOf([...op.i32Const(1), ...op.localGet(0), ...op.i32Add()]);
      expect(findings.some((finding) => finding.type === 'derived')).toBe(false);
    });

    it('does not claim a runtime dependent value is constant', () => {
      const findings = findingsOf([...op.localGet(0)]);
      expect(findings.filter((finding) => finding.type === 'constant')).toHaveLength(0);
    });
  });

  // ─── Locals ────────────────────────────────────────────────────────────────

  describe('local propagation', () => {
    it('tracks a constant local assignment', () => {
      const findings = findingsOf([...op.i32Const(5), ...op.localSet(0)]);
      const propagated = findings.find((finding) => finding.type === 'propagated-local');

      expect(propagated).toBeDefined();
      expect(propagated?.opcode).toBe('local.set');
      expect(propagated?.value).toBe('5');
    });

    it('tracks a constant local read', () => {
      const findings = findingsOf([...op.i32Const(5), ...op.localSet(0), ...op.localGet(0)]);
      const read = findings.find((finding) => finding.type === 'local-read');

      expect(read).toBeDefined();
      expect(read?.value).toBe('5');
    });

    it('propagates a local value into a derived constant', () => {
      const findings = findingsOf([
        ...op.i32Const(4),
        ...op.localSet(0),
        ...op.localGet(0),
        ...op.i32Const(6),
        ...op.i32Add(),
        ...op.localSet(1),
      ]);
      const propagated = findings.filter((finding) => finding.type === 'propagated-local');

      expect(propagated).toHaveLength(2);
      expect(propagated[1].value).toBe('10');
    });

    it('propagates a constant through multiple basic blocks', () => {
      const findings = findingsOf([
        ...op.i32Const(9),
        ...op.localSet(0),
        ...op.block(),
        ...op.end(),
        ...op.localGet(0),
        ...op.localSet(1),
      ]);
      const propagated = findings.filter((finding) => finding.type === 'propagated-local');

      expect(propagated).toHaveLength(2);
      expect(propagated[1].value).toBe('9');
    });

    it('reports the maximum propagation depth', () => {
      const report = analyzeConstantPropagation(
        parseWasmModule(
          single([
            ...op.i32Const(1),
            ...op.localSet(0),
            ...op.localGet(0),
            ...op.i32Const(2),
            ...op.i32Add(),
            ...op.localSet(1),
            ...op.localGet(1),
            ...op.i32Const(3),
            ...op.i32Add(),
          ]),
        ),
        'a.wasm',
      );

      expect(report.totals.maxPropagationDepth).toBeGreaterThanOrEqual(3);
    });
  });

  // ─── Branches ──────────────────────────────────────────────────────────────

  describe('branch conditions', () => {
    it('detects an always-true branch', () => {
      const findings = findingsOf([...op.i32Const(1), ...op.brIf(0), ...op.end()]);
      const branch = findings.find((finding) => finding.type === 'branch-condition');

      expect(branch).toBeDefined();
      expect(branch?.opcode).toBe('br_if');
      expect(branch?.detail).toBe('always_true');
    });

    it('detects an always-false branch', () => {
      const findings = findingsOf([...op.i32Const(0), ...op.brIf(0), ...op.end()]);
      const branch = findings.find((finding) => finding.type === 'branch-condition');

      expect(branch?.detail).toBe('always_false');
    });

    it('does not report a branch with an unknown condition', () => {
      const findings = findingsOf([...op.localGet(0), ...op.brIf(0), ...op.end()]);
      expect(findings.some((finding) => finding.type === 'branch-condition')).toBe(false);
    });

    it('reports a control-flow simplification opportunity', () => {
      const report = analyzeConstantPropagation(
        parseWasmModule(single([...op.i32Const(1), ...op.brIf(0), ...op.end()])),
        'a.wasm',
      );

      expect(report.simplificationOpportunities).toHaveLength(1);
      expect(report.simplificationOpportunities[0].detail).toContain('always taken');
      expect(report.totals.alwaysTrueBranches).toBe(1);
      expect(report.totals.alwaysFalseBranches).toBe(0);
    });

    it('counts an always-false branch', () => {
      const report = analyzeConstantPropagation(
        parseWasmModule(single([...op.i32Const(0), ...op.brIf(0), ...op.end()])),
        'a.wasm',
      );

      expect(report.totals.alwaysFalseBranches).toBe(1);
    });
  });

  // ─── Merge points and loops ────────────────────────────────────────────────

  describe('merge points and loops', () => {
    it('represents conflicting incoming values as unknown', () => {
      // if (cond) { local0 = 1 } else { local0 = 2 }
      const body = [
        ...op.localGet(0),
        ...op.if(),
        ...op.i32Const(1),
        ...op.localSet(0),
        ...op.else(),
        ...op.i32Const(2),
        ...op.localSet(0),
        ...op.end(),
      ];
      const report = analyzeConstantPropagation(parseWasmModule(single(body)), 'a.wasm');

      expect(report.merges.length).toBeGreaterThan(0);
      expect(report.merges[0].locals).toContain(0);
      expect(report.totals.unknownValueMerges).toBeGreaterThan(0);
    });

    it('terminates on a loop with converging values', () => {
      const body = [
        ...op.i32Const(5),
        ...op.localSet(0),
        ...op.loop(),
        ...op.i32Const(5),
        ...op.localSet(0),
        ...op.br(0),
        ...op.end(),
      ];
      const report = analyzeConstantPropagation(parseWasmModule(single(body)), 'a.wasm');

      expect(report.totals.unknownValueMerges).toBe(0);
      const propagated = report.findings.filter((finding) => finding.type === 'propagated-local');
      expect(propagated.length).toBeGreaterThan(0);
      expect(propagated.every((finding) => finding.value === '5')).toBe(true);
    });

    it('terminates on a loop that changes the value on every iteration', () => {
      const body = [
        ...op.i32Const(0),
        ...op.localSet(0),
        ...op.loop(),
        ...op.localGet(0),
        ...op.i32Const(1),
        ...op.i32Add(),
        ...op.localSet(0),
        ...op.br(0),
        ...op.end(),
      ];
      const report = analyzeConstantPropagation(parseWasmModule(single(body)), 'a.wasm');

      expect(report.findings.length).toBeGreaterThan(0);
      expect(report.totals.maxPropagationDepth).toBeGreaterThan(0);
    });
  });

  // ─── Unsupported instructions ──────────────────────────────────────────────

  describe('unsupported instructions', () => {
    it('does not crash on an unsupported instruction', () => {
      const report = analyzeConstantPropagation(
        parseWasmModule(single([...op.i32Const(1), ...[0xfc, 0x0a, 0x00, 0x00]])),
        'a.wasm',
      );
      expect(report.findings.length).toBeGreaterThan(0);
    });

    it('invalidates only the affected path', () => {
      const findings = findingsOf([
        ...op.i32Const(1),
        ...op.localSet(0),
        ...[0xfc, 0x0a, 0x00, 0x00],
        ...op.i32Const(2),
        ...op.localSet(1),
      ]);
      const propagated = findings.filter((finding) => finding.type === 'propagated-local');

      expect(propagated).toHaveLength(2);
      expect(propagated[1].value).toBe('2');
    });
  });

  // ─── Report shape ──────────────────────────────────────────────────────────

  describe('report', () => {
    it('keeps stable function, block and instruction identifiers', () => {
      const report = analyzeConstantPropagation(
        parseWasmModule(single([...op.i32Const(3), ...op.localSet(0)])),
        'a.wasm',
      );

      for (const finding of report.findings) {
        expect(typeof finding.functionIndex).toBe('number');
        expect(typeof finding.blockIndex).toBe('number');
        expect(typeof finding.instructionIndex).toBe('number');
      }
    });

    it('counts the aggregate statistics', () => {
      const report = analyzeConstantPropagation(
        parseWasmModule(
          single([
            ...op.i32Const(1),
            ...op.localSet(0),
            ...op.i32Const(2),
            ...op.i32Const(3),
            ...op.i32Eq(),
          ]),
        ),
        'a.wasm',
      );

      expect(report.totals.totalFunctions).toBe(1);
      expect(report.totals.constantProducingInstructions).toBe(3);
      expect(report.totals.propagatedValues).toBe(1);
      expect(report.totals.resolvedComparisons).toBe(1);
    });

    it('ranks the functions with the most propagated constants', () => {
      const module = buildModule({
        bodies: [
          [...op.i32Const(1), ...op.localSet(0)],
          [...op.i32Const(2), ...op.localSet(0), ...op.i32Const(3), ...op.localSet(1)],
        ],
      });
      const report = analyzeConstantPropagation(parseWasmModule(module), 'a.wasm');

      expect(report.topFunctionsByConstantCount[0].functionIndex).toBe(1);
      expect(report.topFunctionsByConstantCount[0].count).toBe(2);
    });

    it('renders a human-readable report', () => {
      const report = analyzeConstantPropagation(
        parseWasmModule(single([...op.i32Const(1), ...op.localSet(0)])),
        'a.wasm',
      );
      const text = formatConstantPropagationReport(report);

      expect(text).toContain('WASM constant propagation analysis');
      expect(text).toContain('Constant-producing instructions');
      expect(text).toContain('Findings');
    });

    it('renders one CSV row per finding', () => {
      const report = analyzeConstantPropagation(
        parseWasmModule(single([...op.i32Const(1), ...op.localSet(0)])),
        'a.wasm',
      );
      const rows = constantPropagationToCsv(report).trim().split('\n');

      expect(rows[0]).toContain('function_index');
      expect(rows).toHaveLength(report.findings.length + 1);
    });

    it('produces a JSON-serializable report', () => {
      const report = analyzeConstantPropagation(
        parseWasmModule(single([...op.i32Const(1), ...op.localSet(0)])),
        'a.wasm',
      );
      const json = JSON.parse(JSON.stringify(report));

      expect(json.totals.constantProducingInstructions).toBe(1);
      expect(json.findings[0].value).toBe('1');
    });
  });

  // ─── Comparison mode ───────────────────────────────────────────────────────

  describe('compareConstantPropagation', () => {
    it('reports a newly propagated constant', () => {
      const before = analyzeConstantPropagation(parseWasmModule(single([])), 'old.wasm');
      const after = analyzeConstantPropagation(
        parseWasmModule(single([...op.i32Const(1), ...op.localSet(0)])),
        'new.wasm',
      );
      const comparison = compareConstantPropagation(before, after);

      expect(comparison.newlyPropagated.length).toBeGreaterThan(0);
      expect(comparison.summary.newlyPropagated).toBeGreaterThan(0);
    });

    it('reports a removed propagated constant', () => {
      const before = analyzeConstantPropagation(
        parseWasmModule(single([...op.i32Const(1), ...op.localSet(0)])),
        'old.wasm',
      );
      const after = analyzeConstantPropagation(parseWasmModule(single([])), 'new.wasm');
      const comparison = compareConstantPropagation(before, after);

      expect(comparison.removedPropagated.length).toBeGreaterThan(0);
    });

    it('reports a changed constant value', () => {
      const before = analyzeConstantPropagation(
        parseWasmModule(single([...op.i32Const(1), ...op.localSet(0)])),
        'old.wasm',
      );
      const after = analyzeConstantPropagation(
        parseWasmModule(single([...op.i32Const(9), ...op.localSet(0)])),
        'new.wasm',
      );
      const comparison = compareConstantPropagation(before, after);

      expect(comparison.changedValues.length).toBeGreaterThan(0);
    });

    it('reports a newly constant branch', () => {
      const before = analyzeConstantPropagation(
        parseWasmModule(single([...op.localGet(0), ...op.brIf(0), ...op.end()])),
        'old.wasm',
      );
      const after = analyzeConstantPropagation(
        parseWasmModule(single([...op.i32Const(1), ...op.brIf(0), ...op.end()])),
        'new.wasm',
      );
      const comparison = compareConstantPropagation(before, after);

      expect(comparison.newlyConstantBranches.length).toBeGreaterThan(0);
    });

    it('reports a branch that is no longer statically resolvable', () => {
      const before = analyzeConstantPropagation(
        parseWasmModule(single([...op.i32Const(1), ...op.brIf(0), ...op.end()])),
        'old.wasm',
      );
      const after = analyzeConstantPropagation(
        parseWasmModule(single([...op.localGet(0), ...op.brIf(0), ...op.end()])),
        'new.wasm',
      );
      const comparison = compareConstantPropagation(before, after);

      expect(comparison.unresolvableBranches.length).toBeGreaterThan(0);
    });

    it('renders a human-readable comparison', () => {
      const before = analyzeConstantPropagation(parseWasmModule(single([])), 'old.wasm');
      const after = analyzeConstantPropagation(
        parseWasmModule(single([...op.i32Const(1), ...op.localSet(0)])),
        'new.wasm',
      );
      const text = formatConstantComparison(compareConstantPropagation(before, after));

      expect(text).toContain('WASM constant propagation comparison');
      expect(text).toContain('Newly propagated constants');
    });

    it('builds a stable key for a finding', () => {
      const report = analyzeConstantPropagation(
        parseWasmModule(single([...op.i32Const(1)])),
        'a.wasm',
      );
      expect(constantKey(report.findings[0])).toContain('#');
    });
  });

  // ─── Files, determinism and the offline guarantee ─────────────────────────

  describe('files, determinism and the offline guarantee', () => {
    it('analyzes a file from disk', () => {
      const file = path.join(os.tmpdir(), `wasm-constants-${Date.now()}.wasm`);
      fs.writeFileSync(file, single([...op.i32Const(1), ...op.localSet(0)]));
      const report = analyzeConstantPropagationFile(file);

      expect(report.totals.constantProducingInstructions).toBe(1);
      expect(report.file).toBe(file);
    });

    it('rejects a malformed artifact', () => {
      const file = path.join(os.tmpdir(), `wasm-constants-invalid-${Date.now()}.wasm`);
      fs.writeFileSync(file, Buffer.from('not wasm'));
      expect(() => analyzeConstantPropagationFile(file)).toThrow(WasmParseError);
    });

    it('is deterministic for repeated runs', () => {
      const module = single([
        ...op.i32Const(1),
        ...op.localSet(0),
        ...op.localGet(0),
        ...op.i32Const(2),
        ...op.i32Add(),
        ...op.localSet(1),
      ]);
      const first = analyzeConstantPropagation(parseWasmModule(module), 'a.wasm');
      const second = analyzeConstantPropagation(parseWasmModule(module), 'a.wasm');

      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    });

    it('does not expose any execute or instantiate symbol', () => {
      const exported = Object.keys(constantPropagationModule);
      expect(exported).not.toContain('instantiate');
      expect(exported.some((key: string) => key.toLowerCase().includes('execute'))).toBe(false);
    });

    it('rejects a JavaScript source file instead of running it', () => {
      const js = Buffer.from('function main() { return 1; }\n', 'utf8');
      expect(() => analyzeConstantPropagation(parseWasmModule(js), 'a.wasm')).toThrow(
        WasmParseError,
      );
    });
  });
});
