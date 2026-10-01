/**
 * Tests for ISSUE-282 (WASM initialization-expression analysis).
 *
 * Focused on the pure parts: constant folding, classification, depth
 * resolution, output formats, and comparison. The analyzer never instantiates
 * or executes the module — `evaluateConstant` folds opcodes directly.
 */

import {
  analyzeInitExprs,
  collectInitExprs,
  compareInitExprs,
  entryKey,
  evaluateConstant,
  indexGlobals,
  resolveDepths,
  toCsv,
  toDot,
  type InitExprRecord,
} from '../src/wasm/initExprAnalysis';

describe('ISSUE-282: WASM initialization expression analysis', () => {
  // ─── Constant folding ──────────────────────────────────────────────────────

  describe('evaluateConstant', () => {
    it('evaluates a single i32.const', () => {
      expect(evaluateConstant(['i32.const', 'end'], [42, ''])).toBe(BigInt(42));
    });

    it('evaluates i32.add', () => {
      expect(evaluateConstant(['i32.const', 'i32.const', 'i32.add', 'end'], [2, 3, '', ''])).toBe(BigInt(5));
    });

    it('evaluates i32.sub', () => {
      expect(evaluateConstant(['i32.const', 'i32.const', 'i32.sub', 'end'], [10, 4, '', ''])).toBe(BigInt(6));
    });

    it('evaluates i32.mul', () => {
      expect(evaluateConstant(['i32.const', 'i32.const', 'i32.mul', 'end'], [6, 7, '', ''])).toBe(BigInt(42));
    });

    it('folds chained arithmetic left to right', () => {
      // ((1 + 2) * 3) - 4 = 5
      expect(
        evaluateConstant(
          ['i32.const', 'i32.const', 'i32.add', 'i32.const', 'i32.mul', 'i32.const', 'i32.sub', 'end'],
          [1, 2, '', 3, '', 4, '', ''],
        ),
      ).toBe(BigInt(5));
    });

    it('evaluates i64 constants', () => {
      expect(evaluateConstant(['i64.const', 'end'], ['9007199254740993', ''])).toBe(BigInt('9007199254740993'));
    });

    it('handles negative constants', () => {
      expect(evaluateConstant(['i32.const', 'end'], [-8, ''])).toBe(BigInt(-8));
    });

    it('returns undefined for an unsupported instruction', () => {
      // f32.const is not in the foldable set.
      expect(evaluateConstant(['f32.const', 'end'], [1.5, ''])).toBeUndefined();
    });

    it('returns undefined for a global.get expression', () => {
      expect(evaluateConstant(['global.get', 'end'], [0, ''])).toBeUndefined();
    });

    it('returns undefined when the stack underflows', () => {
      expect(evaluateConstant(['i32.add', 'end'], ['', ''])).toBeUndefined();
    });

    it('returns undefined when the stack has leftover values', () => {
      expect(evaluateConstant(['i32.const', 'i32.const', 'end'], [1, 2, ''])).toBeUndefined();
    });

    it('returns undefined for an empty expression', () => {
      expect(evaluateConstant([], [])).toBeUndefined();
    });
  });

  // ─── Entry keys ────────────────────────────────────────────────────────────

  describe('entryKey', () => {
    it('formats section and index', () => {
      expect(entryKey('global', 3)).toBe('global:3');
      expect(entryKey('data', 0)).toBe('data:0');
      expect(entryKey('element', 7)).toBe('element:7');
    });
  });

  // ─── Depth resolution ──────────────────────────────────────────────────────

  describe('resolveDepths', () => {
    const rec = (
      section: InitExprRecord['section'],
      entryIndex: number,
      referencedGlobals: number[],
      classification: InitExprRecord['classification'] = 'fully-constant',
    ): InitExprRecord => ({
      section,
      entryIndex,
      opcodes: [],
      operands: [],
      referencedGlobals,
      dependsOnImportedGlobals: false,
      definesGlobal: section === 'global',
      classification,
      dependencyDepth: 1,
      dependencies: referencedGlobals,
    });

    it('assigns depth 1 to a fully constant global', () => {
      const { depths } = resolveDepths([rec('global', 0, [])]);
      expect(depths).toEqual([1]);
    });

    it('computes depth for a chain of three globals', () => {
      // g0 const, g1 -> g0, g2 -> g1  =>  depths 1, 2, 3
      const { depths } = resolveDepths([
        rec('global', 0, []),
        rec('global', 1, [0], 'locally-state-dependent'),
        rec('global', 2, [1], 'locally-state-dependent'),
      ]);
      expect(depths).toEqual([1, 2, 3]);
    });

    it('computes the same depth for a data offset referencing a chain', () => {
      const { depths } = resolveDepths([
        rec('global', 0, []),
        rec('global', 1, [0], 'locally-state-dependent'),
        rec('data', 0, [1]),
      ]);
      expect(depths).toEqual([1, 2, 2]);
    });

    it('assigns depth 1 to a data offset with no global references', () => {
      const { depths } = resolveDepths([rec('data', 0, [])]);
      expect(depths).toEqual([1]);
    });

    it('handles a diamond dependency without inflating depth', () => {
      // g1 -> g0, g2 -> g0, g3 -> [g1, g2]; max path is still 3.
      const { depths } = resolveDepths([
        rec('global', 0, []),
        rec('global', 1, [0], 'locally-state-dependent'),
        rec('global', 2, [0], 'locally-state-dependent'),
        rec('global', 3, [1, 2], 'locally-state-dependent'),
      ]);
      expect(depths[3]).toBe(3);
    });

    it('terminates on a self-referencing cycle and reports it', () => {
      const { depths, cycles } = resolveDepths([
        rec('global', 0, [0], 'locally-state-dependent'),
      ]);
      expect(depths).toHaveLength(1);
      expect(cycles.length).toBeGreaterThan(0);
    });

    it('terminates on a two-node cycle', () => {
      const { cycles } = resolveDepths([
        rec('global', 0, [1], 'locally-state-dependent'),
        rec('global', 1, [0], 'locally-state-dependent'),
      ]);
      expect(cycles.length).toBeGreaterThan(0);
    });

    it('converges on a longer cyclic chain', () => {
      const { depths } = resolveDepths([
        rec('global', 0, [2], 'locally-state-dependent'),
        rec('global', 1, [0], 'locally-state-dependent'),
        rec('global', 2, [1], 'locally-state-dependent'),
      ]);
      expect(depths).toHaveLength(3);
      expect(depths.every((d) => Number.isFinite(d))).toBe(true);
    });

    it('treats a reference to a non-existent global as depth 1', () => {
      const { depths } = resolveDepths([
        rec('global', 0, [99], 'locally-state-dependent'),
      ]);
      expect(depths).toEqual([1]);
    });

    it('returns empty depths for no records', () => {
      const { depths, cycles } = resolveDepths([]);
      expect(depths).toEqual([]);
      expect(cycles).toEqual([]);
    });
  });

  // ─── Globals indexing ──────────────────────────────────────────────────────

  describe('indexGlobals', () => {
    it('returns an empty list for an AST with no globals', () => {
      expect(indexGlobals({ body: [] })).toEqual([]);
    });

    it('numbers imported globals before defined globals', () => {
      const ast = {
        body: [
          { type: 'Import', entries: [{ module: 'env', kind: 'global', name: 'a', type: { value: 'i32', mutable: true } }] },
          { type: 'Import', entries: [{ module: 'env', kind: 'global', name: 'b', type: { value: 'i64', mutable: false } }] },
          { type: 'Global', entries: [{ type: { value: 'i32', mutable: false }, init: {} }] },
        ],
      };
      const globals = indexGlobals(ast);
      expect(globals).toHaveLength(3);
      expect(globals[0]).toMatchObject({ index: 0, imported: true, mutable: true });
      expect(globals[2]).toMatchObject({ index: 2, imported: false });
    });

    it('ignores non-global imports', () => {
      const ast = {
        body: [{ type: 'Import', entries: [{ module: 'env', kind: 'func', name: 'f' }] }],
      };
      expect(indexGlobals(ast)).toEqual([]);
    });
  });

  // ─── Collection and classification ─────────────────────────────────────────

  describe('collectInitExprs', () => {
    const withGlobals = (initNode: any) => ({
      body: [{ type: 'Global', entries: [{ type: { value: 'i32', mutable: false }, init: initNode }] }],
    });

    const constInstr = (value: number) => ({
      type: 'Instr',
      id: { type: 'i32.const', value },
    });

    it('classifies a constant global as fully-constant', () => {
      const globals = indexGlobals(withGlobals(constInstr(16)));
      const records = collectInitExprs(withGlobals(constInstr(16)), globals);
      expect(records).toHaveLength(1);
      expect(records[0].classification).toBe('fully-constant');
      expect(records[0].constantValue).toBe(BigInt(16));
    });

    it('classifies a global.get on an imported global', () => {
      const ast = {
        body: [
          { type: 'Import', entries: [{ module: 'env', kind: 'global', name: 'g', type: { value: 'i32', mutable: false } }] },
          { type: 'Global', entries: [{ type: { value: 'i32', mutable: false }, init: { type: 'Instr', id: { type: 'global.get', value: 0 } } }] },
        ],
      };
      const globals = indexGlobals(ast);
      const records = collectInitExprs(ast, globals);
      expect(records[0].classification).toBe('imported-state-dependent');
      expect(records[0].referencedGlobals).toEqual([0]);
      expect(records[0].dependsOnImportedGlobals).toBe(true);
    });

    it('classifies a global.get on a locally defined global', () => {
      const ast = {
        body: [
          { type: 'Global', entries: [{ type: { value: 'i32', mutable: false }, init: constInstr(1) }] },
          { type: 'Global', entries: [{ type: { value: 'i32', mutable: false }, init: { type: 'Instr', id: { type: 'global.get', value: 0 } } }] },
        ],
      };
      const globals = indexGlobals(ast);
      const records = collectInitExprs(ast, globals);
      expect(records[0].classification).toBe('fully-constant');
      expect(records[1].classification).toBe('locally-state-dependent');
      expect(records[1].dependsOnImportedGlobals).toBe(false);
    });

    it('marks an unsupported instruction as unsupported, not constant', () => {
      const globals = indexGlobals(withGlobals({ type: 'Instr', id: { type: 'f32.const', value: 1.5 } }));
      const records = collectInitExprs(withGlobals({ type: 'Instr', id: { type: 'f32.const', value: 1.5 } }), globals);
      expect(records[0].classification).toBe('unsupported');
      expect(records[0].constantValue).toBeUndefined();
    });

    it('records a referenced global on the globals index', () => {
      const ast = {
        body: [
          { type: 'Global', entries: [{ type: { value: 'i32', mutable: false }, init: constInstr(0) }] },
          { type: 'Global', entries: [{ type: { value: 'i32', mutable: false }, init: { type: 'Instr', id: { type: 'global.get', value: 0 } } }] },
        ],
      };
      const globals = indexGlobals(ast);
      collectInitExprs(ast, globals);
      expect(globals[0].referencedBy).toEqual([1]);
    });

    it('extracts a constant data-segment offset', () => {
      const ast = {
        body: [
          { type: 'Data', entries: [{ offset: constInstr(1024), init: [] }] },
        ],
      };
      const globals = indexGlobals(ast);
      const records = collectInitExprs(ast, globals);
      expect(records[0].section).toBe('data');
      expect(records[0].classification).toBe('fully-constant');
      expect(records[0].constantValue).toBe(BigInt(1024));
    });

    it('extracts a constant element-segment offset', () => {
      const ast = {
        body: [{ type: 'Element', entries: [{ offset: constInstr(64) }] }],
      };
      const globals = indexGlobals(ast);
      const records = collectInitExprs(ast, globals);
      expect(records[0].section).toBe('element');
      expect(records[0].constantValue).toBe(BigInt(64));
    });

    it('returns nothing for an AST with no init expressions', () => {
      expect(collectInitExprs({ body: [] }, [])).toEqual([]);
    });
  });

  // ─── Output formats ────────────────────────────────────────────────────────

  describe('toCsv', () => {
    const sampleReport = {
      totals: {
        totalInitExprs: 1,
        fullyConstant: 1,
        globalDependent: 0,
        importedGlobalDependent: 0,
        unsupported: 0,
        totalReferencedGlobals: 0,
        maxDependencyDepth: 1,
        totalExpressions: 1,
      },
      expressions: [
        {
          section: 'global' as const,
          entryIndex: 0,
          opcodes: ['i32.const', 'end'],
          operands: [8, ''],
          referencedGlobals: [],
          dependsOnImportedGlobals: false,
          definesGlobal: true,
          resultType: 'i32',
          classification: 'fully-constant' as const,
          constantValue: BigInt(8),
          dependencyDepth: 1,
          dependencies: [],
        },
      ],
      referencedGlobals: [],
      dependencies: [],
      cycles: [],
    };

    it('emits a header row', () => {
      const [header] = toCsv(sampleReport).split('\n');
      expect(header).toBe(
        'section,entry_index,opcodes,referenced_globals,result_type,classification,constant_value,dependency_depth',
      );
    });

    it('emits one row per expression', () => {
      expect(toCsv(sampleReport).trim().split('\n')).toHaveLength(2);
    });

    it('includes the constant value', () => {
      expect(toCsv(sampleReport)).toContain('fully-constant');
      expect(toCsv(sampleReport)).toContain('8');
    });

    it('leaves the constant blank when unresolved', () => {
      const unresolved = {
        ...sampleReport,
        expressions: [{ ...sampleReport.expressions[0], constantValue: undefined, classification: 'unsupported' as const }],
      };
      const row = toCsv(unresolved).split('\n')[1];
      expect(row).toContain('unsupported');
      expect(row.endsWith(',1')).toBe(true);
    });
  });

  describe('toDot', () => {
    const base = {
      totals: {
        totalInitExprs: 2, fullyConstant: 1, globalDependent: 1, importedGlobalDependent: 0,
        unsupported: 0, totalReferencedGlobals: 1, maxDependencyDepth: 2, totalExpressions: 2,
      },
      expressions: [
        {
          section: 'global' as const, entryIndex: 0, opcodes: [], operands: [],
          referencedGlobals: [], dependsOnImportedGlobals: false, definesGlobal: true,
          classification: 'fully-constant' as const, dependencyDepth: 1, dependencies: [],
        },
        {
          section: 'data' as const, entryIndex: 0, opcodes: [], operands: [],
          referencedGlobals: [0], dependsOnImportedGlobals: false, definesGlobal: false,
          classification: 'locally-state-dependent' as const, dependencyDepth: 2, dependencies: [0],
        },
      ],
      referencedGlobals: [],
      dependencies: [{ from: 'data:0', to: 'global:0', kind: 'data' as const }],
      cycles: [],
    };

    it('emits a digraph', () => {
      expect(toDot(base)).toContain('digraph init_exprs {');
      expect(toDot(base).trimEnd().endsWith('}')).toBe(true);
    });

    it('renders each dependency edge', () => {
      expect(toDot(base)).toContain('"data:0" -> "global:0"');
    });

    it('emits a node per expression', () => {
      expect(toDot(base)).toContain('"global:0"');
    });
  });

  // ─── Comparison ────────────────────────────────────────────────────────────

  describe('compareInitExprs', () => {
    const mk = (index: number, section: 'global' | 'data', value?: bigint, globals: number[] = []) => ({
      section,
      entryIndex: index,
      opcodes: [],
      operands: [],
      referencedGlobals: globals,
      dependsOnImportedGlobals: false,
      definesGlobal: section === 'global',
      classification: (globals.length ? 'locally-state-dependent' : 'fully-constant') as InitExprRecord['classification'],
      constantValue: value,
      dependencyDepth: 1,
      dependencies: globals,
    });

    const report = (exprs: InitExprRecord[]) => ({
      totals: {
        totalInitExprs: exprs.length, fullyConstant: 0, globalDependent: 0, importedGlobalDependent: 0,
        unsupported: 0, totalReferencedGlobals: 0, maxDependencyDepth: 1, totalExpressions: exprs.length,
      },
      expressions: exprs,
      referencedGlobals: [],
      dependencies: [],
      cycles: [],
    });

    it('reports an added expression', () => {
      const diff = compareInitExprs(report([mk(0, 'global', BigInt(1))]), report([mk(0, 'global', BigInt(1)), mk(1, 'global', BigInt(2))]));
      expect(diff.added).toEqual(['global:1']);
    });

    it('reports a removed expression', () => {
      const diff = compareInitExprs(report([mk(0, 'global', BigInt(1)), mk(1, 'global', BigInt(2))]), report([mk(0, 'global', BigInt(1))]));
      expect(diff.removed).toEqual(['global:1']);
    });

    it('reports a changed constant value', () => {
      const diff = compareInitExprs(report([mk(0, 'global', BigInt(1))]), report([mk(0, 'global', BigInt(9))]));
      expect(diff.changedConstantValues).toEqual(['global:0']);
    });

    it('reports changed global dependencies', () => {
      const diff = compareInitExprs(report([mk(1, 'global', undefined, [0])]), report([mk(1, 'global', undefined, [1])]));
      expect(diff.changedGlobalDependencies).toEqual(['global:1']);
    });

    it('reports a changed data offset', () => {
      const diff = compareInitExprs(report([mk(0, 'data', BigInt(16))]), report([mk(0, 'data', BigInt(32))]));
      expect(diff.changedDataOffsets).toEqual(['data:0']);
    });

    it('reports a changed element offset', () => {
      const diff = compareInitExprs(report([mk(0, 'element' as any, BigInt(16))]), report([mk(0, 'element' as any, BigInt(32))]));
      expect(diff.changedElementOffsets).toEqual(['element:0']);
    });

    it('reports a changed dependency depth', () => {
      const before = report([mk(0, 'global'), mk(1, 'global', undefined, [0])]);
      before.expressions[1].dependencyDepth = 1;
      const after = report([mk(0, 'global'), mk(1, 'global', undefined, [0])]);
      after.expressions[1].dependencyDepth = 5;
      expect(compareInitExprs(before, after).changedDependencyDepth).toEqual(['global:1']);
    });

    it('reports nothing for two identical reports', () => {
      const diff = compareInitExprs(report([mk(0, 'global', BigInt(1))]), report([mk(0, 'global', BigInt(1))]));
      expect(diff).toEqual({
        added: [], removed: [], changedConstantValues: [],
        changedGlobalDependencies: [], changedDataOffsets: [], changedElementOffsets: [],
        changedDependencyDepth: [],
      });
    });
  });

  // ─── Offline guarantee ─────────────────────────────────────────────────────

  describe('offline / no-execution guarantee', () => {
    it('does not expose any execute or instantiate symbol', () => {
      const module = require('../src/wasm/initExprAnalysis');
      const exported = Object.keys(module);
      expect(exported).not.toContain('instantiate');
      expect(exported.some((k: string) => k.toLowerCase().includes('execute'))).toBe(false);
    });

    it('throws rather than executing when given a non-WASM buffer', () => {
      // A JS source file must be rejected by the parser, not run.
      const js = Buffer.from('function main() { return 1; }\n', 'utf8');
      expect(() => analyzeInitExprs(js)).toThrow();
    });

    it('is deterministic for the same input', () => {
      const ast = {
        body: [{ type: 'Global', entries: [{ type: { value: 'i32', mutable: false }, init: { type: 'Instr', id: { type: 'i32.const', value: 7 } } }] }],
      };
      const globals = indexGlobals(ast);
      const first = collectInitExprs(ast, globals);
      const second = collectInitExprs(ast, globals);
      expect(JSON.stringify(first, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))
        .toEqual(JSON.stringify(second, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    });
  });
});