/**
 * WASM initialization-expression analysis (ISSUE-282).
 *
 * Initialization expressions establish the initial values of globals and the
 * offsets of data and element segments. They are evaluated during module
 * *initialization*, not ordinary function execution, and they can establish
 * relationships between globals, memory offsets, tables, and static data.
 *
 * This analyzer extracts them, records their dependencies, and evaluates the
 * constant subset — entirely offline. It never instantiates or executes the
 * module: the input is parsed to an AST and nothing more.
 */

import { readFileSync } from 'fs';
import { decode } from '@webassemblyjs/wasm-parser';

/**
 * How an initialization expression's value can be resolved.
 *
 * `unsupported` is the important one: an expression we cannot model stays
 * `unsupported` rather than being assigned a guessed value.
 */
export type InitExprClassification =
  | 'fully-constant'
  | 'global-dependent'
  | 'imported-state-dependent'
  | 'locally-state-dependent'
  | 'unsupported';

/** WASM section an expression was found in. */
export type InitExprSection = 'global' | 'data' | 'element';

/** One extracted initialization expression. */
export interface InitExprRecord {
  /** Section the expression came from. */
  section: InitExprSection;
  /** Index of the entry within its section, as encoded in the binary. */
  entryIndex: number;
  /** Init expression opcodes, in order. */
  opcodes: string[];
  /** Immediates paired with the opcodes above (same length). */
  operands: (string | number)[];
  /** Global indexes this expression reads via `global.get`. */
  referencedGlobals: number[];
  /** True when every referenced global is imported. */
  dependsOnImportedGlobals: boolean;
  /** True when this expression defines a global (section === 'global'). */
  definesGlobal: boolean;
  /** Value type when determinable from context. */
  resultType?: string;
  classification: InitExprClassification;
  /**
   * Statically evaluated constant, when the expression is fully constant and
   * uses only supported arithmetic. `undefined` otherwise — deliberately
   * absent rather than `null` so it can be omitted from JSON.
   */
  constantValue?: bigint | number;
  /** 1-based hop count from this expression to a fully-constant root. */
  dependencyDepth: number;
  /** Global indexes this expression depends on, transitively. */
  dependencies: number[];
}

/** A global referenced by at least one initialization expression. */
export interface ReferencedGlobal {
  index: number;
  type?: string;
  mutable: boolean;
  imported: boolean;
  /** Init expressions that read this global. */
  referencedBy: number[];
}

/** A directed dependency edge between initialization expressions. */
export interface DependencyEdge {
  /** Entry key of the dependent expression, e.g. `global:2`. */
  from: string;
  /** Entry key of the expression it reads, e.g. `global:0`. */
  to: string;
  /** `data` when this is a segment offset, otherwise `global`. */
  kind: 'global' | 'data' | 'element';
}

export interface InitExprReport {
  totals: {
    totalInitExprs: number;
    fullyConstant: number;
    globalDependent: number;
    importedGlobalDependent: number;
    unsupported: number;
    totalReferencedGlobals: number;
    maxDependencyDepth: number;
    totalExpressions: number;
  };
  expressions: InitExprRecord[];
  referencedGlobals: ReferencedGlobal[];
  dependencies: DependencyEdge[];
  /** Cycles found among global init dependencies. */
  cycles: string[][];
}

/** Stable key for an entry, used in edges and cycle reports. */
export const entryKey = (section: InitExprSection, index: number): string =>
  `${section}:${index}`;

/**
 * Instructions we can evaluate with integer constant folding.
 *
 * Deliberately conservative: anything outside this set marks the expression
 * `unsupported` rather than risking an incorrect constant.
 */
const FOLDABLE = new Set([
  'i32.const',
  'i64.const',
  'i32.add',
  'i32.sub',
  'i32.mul',
  'i64.add',
  'i64.sub',
  'i64.mul',
  'end',
]);

/** Extract the flat (opcode, operand) sequence from a webassemblyjs init node. */
function flattenInit(node: any): { opcodes: string[]; operands: (string | number)[] } {
  const opcodes: string[] = [];
  const operands: (string | number)[] = [];

  const walk = (n: any): void => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    if (n.type === 'Instr' && typeof n.id === 'object') {
      const id = n.id as Record<string, any>;
      const name = String(id.type ?? '').replace('Instr', '').toLowerCase();
      opcodes.push(name);
      if (id.value !== undefined) operands.push(id.value as string | number);
      else operands.push('');
      return;
    }
    // Init expressions nest under `args`, `id`, `value`, etc.
    for (const key of Object.keys(n)) {
      if (key === 'loc') continue;
      walk(n[key]);
    }
  };

  walk(node);
  return { opcodes, operands };
}

/**
 * Evaluates an op/operand list by constant folding.
 *
 * Returns `undefined` when the expression is not fully constant or uses an
 * instruction outside {@link FOLDABLE}.
 */
export function evaluateConstant(
  opcodes: string[],
  operands: (string | number)[],
): bigint | undefined {
  const stack: bigint[] = [];

  for (let i = 0; i < opcodes.length; i++) {
    const op = opcodes[i];

    if (op === 'end') continue;

    if (op.endsWith('.const')) {
      const raw = operands[i];
      const value = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(value)) return undefined;
      stack.push(BigInt(Math.trunc(value)));
      continue;
    }

    if (!FOLDABLE.has(op)) return undefined;

    // Binary arithmetic: pop b then a, push a op b.
    const b = stack.pop();
    const a = stack.pop();
    if (a === undefined || b === undefined) return undefined;

    if (op.endsWith('.add')) stack.push(a + b);
    else if (op.endsWith('.sub')) stack.push(a - b);
    else if (op.endsWith('.mul')) stack.push(a * b);
    else return undefined;
  }

  return stack.length === 1 ? stack[0] : undefined;
}

/** Parse a WASM binary to an AST. Never instantiates the module. */
export function parseWasm(buffer: Buffer): any {
  return decode(buffer, { dump: false, ignoreCodeSection: false, ignoreDataSection: false });
}

/** Index globals as imported-then-defined, matching the binary's numbering. */
export function indexGlobals(ast: any): ReferencedGlobal[] {
  const globals: ReferencedGlobal[] = [];

  for (const section of ast.body ?? []) {
    if (section.type === 'Import') {
      for (const entry of section.entries ?? []) {
        if (entry.module === 'env' && entry.kind === 'global') {
          globals.push({
            index: globals.length,
            type: entry.type?.value,
            mutable: Boolean(entry.type?.mutable),
            imported: true,
            referencedBy: [],
          });
        }
      }
    }
  }

  for (const section of ast.body ?? []) {
    if (section.type === 'Global') {
      const g = section.entries?.[0];
      globals.push({
        index: globals.length,
        type: g?.type?.value,
        mutable: Boolean(g?.type?.mutable),
        imported: false,
        referencedBy: [],
      });
    }
  }

  return globals;
}

/** Collect init expressions from globals, data segments, and element segments. */
export function collectInitExprs(
  ast: any,
  globals: ReferencedGlobal[],
): InitExprRecord[] {
  const records: InitExprRecord[] = [];

  const addRecord = (
    section: InitExprSection,
    entryIndex: number,
    initNode: any,
    extra: { resultType?: string; definesGlobal?: boolean } = {},
  ): void => {
    const { opcodes, operands } = flattenInit(initNode);
    const referencedGlobals: number[] = [];

    opcodes.forEach((op, i) => {
      if (op === 'global.get') {
        const raw = operands[i];
        const idx = typeof raw === 'number' ? raw : Number(raw);
        if (Number.isInteger(idx)) referencedGlobals.push(idx);
      }
    });

    const dependsOnImportedGlobals = referencedGlobals.some(
      (g) => globals[g]?.imported === true,
    );

    let classification: InitExprClassification;
    let constantValue: bigint | number | undefined;

    if (referencedGlobals.length > 0) {
      classification = dependsOnImportedGlobals
        ? 'imported-state-dependent'
        : 'locally-state-dependent';
    } else {
      const folded = evaluateConstant(opcodes, operands);
      if (folded === undefined) {
        classification = 'unsupported';
      } else {
        classification = 'fully-constant';
        constantValue = folded;
      }
    }

    referencedGlobals.forEach((g) => {
      if (globals[g]) globals[g].referencedBy.push(entryIndex);
    });

    records.push({
      section,
      entryIndex,
      opcodes,
      operands,
      referencedGlobals,
      dependsOnImportedGlobals,
      definesGlobal: extra.definesGlobal ?? false,
      resultType: extra.resultType,
      classification,
      constantValue,
      dependencyDepth: 1,
      dependencies: referencedGlobals,
    });
  };

  // Globals. `section.entries` is one entry per global section in this AST.
  let globalIndex = 0;
  for (const section of ast.body ?? []) {
    if (section.type !== 'Global') continue;
    for (const g of section.entries ?? []) {
      addRecord('global', globalIndex, g.init, {
        resultType: g.type?.value,
        definesGlobal: true,
      });
      globalIndex++;
    }
  }

  // Data segments — offset expression.
  for (const section of ast.body ?? []) {
    if (section.type !== 'Data') continue;
    (section.entries ?? []).forEach((entry: any, i: number) => {
      addRecord('data', i, entry.offset);
    });
  }

  // Element segments — offset expression plus per-element initializers.
  for (const section of ast.body ?? []) {
    if (section.type !== 'Element') continue;
    (section.entries ?? []).forEach((entry: any, i: number) => {
      addRecord('element', i, entry.offset);

      const initNodes: any[] = entry.initExpr ?? entry.expr;
      if (Array.isArray(initNodes)) {
        initNodes.forEach((node, j) => {
          addRecord('element', i, node, { resultType: node?.type?.value });
          const last = records[records.length - 1];
          last.entryIndex = i;
          last.opcodes = [...last.opcodes];
          last.operands = [...last.operands];
          // Element initializers are keyed by their position within the segment.
          (last as any).elementInitializerIndex = j;
        });
      }
    });
  }

  return records;
}

/**
 * Computes transitive dependency depth over global init dependencies.
 *
 * Also reports cycles. Both use an iterative walk with a visited set so a
 * cyclic or malformed binary cannot spin forever.
 */
export function resolveDepths(
  records: InitExprRecord[],
): { depths: number[]; cycles: string[][] } {
  const byKey = new Map<string, InitExprRecord>();
  for (const r of records) {
    if (r.section === 'global') byKey.set(entryKey('global', r.entryIndex), r);
  }

  const depths: number[] = records.map(() => 1);
  const cycles: string[][] = [];
  const done = new Set<string>();
  const onPath: string[] = [];
  const onPathSet = new Set<string>();
  const reportedCycles = new Set<string>();

  const depthOf = (key: string): number => {
    if (done.has(key)) {
      const idx = onPath.indexOf(key);
      return idx >= 0 ? 0 : 0;
    }
    if (onPathSet.has(key)) {
      // Cycle: record it once, in canonical rotation.
      const start = onPath.indexOf(key);
      const cycle = [...onPath.slice(start), key];
      const signature = [...new Set(cycle)].sort().join('|');
      if (!reportedCycles.has(signature)) {
        reportedCycles.add(signature);
        cycles.push(cycle);
      }
      return 0;
    }

    const rec = byKey.get(key);
    if (!rec || rec.referencedGlobals.length === 0) {
      done.add(key);
      return rec?.classification === 'fully-constant' ? 1 : 1;
    }

    onPath.push(key);
    onPathSet.add(key);
    let max = 1;
    for (const g of rec.referencedGlobals) {
      const childKey = entryKey('global', g);
      if (byKey.has(childKey)) {
        max = Math.max(max, 1 + depthOf(childKey));
      }
    }
    onPath.pop();
    onPathSet.delete(key);
    done.add(key);
    return max;
  };

  records.forEach((r, i) => {
    const key = entryKey(r.section, r.entryIndex);
    if (r.section === 'global') {
      depths[i] = depthOf(key);
    } else if (r.referencedGlobals.length === 0) {
      depths[i] = 1;
    } else {
      let max = 1;
      for (const g of r.referencedGlobals) {
        const childKey = entryKey('global', g);
        if (byKey.has(childKey)) max = Math.max(max, 1 + depthOf(childKey));
      }
      depths[i] = max;
    }
  });

  return { depths, cycles };
}

/** Full analysis over a WASM buffer. */
export function analyzeInitExprs(buffer: Buffer): InitExprReport {
  const ast = parseWasm(buffer);
  const globals = indexGlobals(ast);
  const expressions = collectInitExprs(ast, globals);
  const { depths, cycles } = resolveDepths(expressions);

  const dependencies: DependencyEdge[] = [];
  expressions.forEach((rec, i) => {
    rec.dependencyDepth = depths[i];
    for (const g of rec.referencedGlobals) {
      dependencies.push({
        from: entryKey(rec.section, rec.entryIndex),
        to: entryKey('global', g),
        kind: rec.section === 'global' ? 'global' : rec.section,
      });
    }
  });

  const referencedGlobals = globals.filter((g) => g.referencedBy.length > 0);

  return {
    totals: {
      totalInitExprs: expressions.length,
      fullyConstant: expressions.filter((e) => e.classification === 'fully-constant').length,
      globalDependent: expressions.filter((e) => e.classification === 'locally-state-dependent').length,
      importedGlobalDependent: expressions.filter((e) => e.classification === 'imported-state-dependent').length,
      unsupported: expressions.filter((e) => e.classification === 'unsupported').length,
      totalReferencedGlobals: referencedGlobals.length,
      maxDependencyDepth: depths.length ? Math.max(...depths) : 0,
      totalExpressions: expressions.length,
    },
    expressions,
    referencedGlobals,
    dependencies,
    cycles,
  };
}

/** Convenience wrapper: read a file from disk and analyze it. */
export function analyzeInitExprsFile(path: string): InitExprReport {
  return analyzeInitExprs(readFileSync(path));
}

/** CSV rows — one per analyzed expression. */
export function toCsv(report: InitExprReport): string {
  const header = [
    'section',
    'entry_index',
    'opcodes',
    'referenced_globals',
    'result_type',
    'classification',
    'constant_value',
    'dependency_depth',
  ].join(',');

  const rows = report.expressions.map((e) =>
    [
      e.section,
      e.entryIndex,
      `"${e.opcodes.join(' ')}"`,
      `"${e.referencedGlobals.join(' ')}"`,
      e.resultType ?? '',
      e.classification,
      e.constantValue === undefined ? '' : String(e.constantValue),
      e.dependencyDepth,
    ].join(','),
  );

  return [header, ...rows].join('\n');
}

/** DOT graph of the initialization dependency edges. */
export function toDot(report: InitExprReport): string {
  const lines = ['digraph init_exprs {', '  rankdir=LR;'];

  for (const e of report.expressions) {
    lines.push(`  "${entryKey(e.section, e.entryIndex)}" [class="${e.classification}"];`);
  }
  for (const d of report.dependencies) {
    lines.push(`  "${d.from}" -> "${d.to}";`);
  }
  for (const cycle of report.cycles) {
    lines.push(`  // cycle: ${cycle.join(' -> ')}`);
  }

  lines.push('}');
  return lines.join('\n');
}

/** Difference between two artifacts' init-expression reports. */
export interface InitExprComparison {
  added: string[];
  removed: string[];
  changedConstantValues: string[];
  changedGlobalDependencies: string[];
  changedDataOffsets: string[];
  changedElementOffsets: string[];
  changedDependencyDepth: string[];
}

export function compareInitExprs(
  before: InitExprReport,
  after: InitExprReport,
): InitExprComparison {
  const keyOf = (e: InitExprRecord) => `${e.section}:${e.entryIndex}`;
  const beforeMap = new Map(before.expressions.map((e) => [keyOf(e), e]));
  const afterMap = new Map(after.expressions.map((e) => [keyOf(e), e]));

  const added: string[] = [];
  const removed: string[] = [];
  const changedConstantValues: string[] = [];
  const changedGlobalDependencies: string[] = [];
  const changedDataOffsets: string[] = [];
  const changedElementOffsets: string[] = [];
  const changedDependencyDepth: string[] = [];

  for (const [key, a] of afterMap) {
    if (!beforeMap.has(key)) {
      added.push(key);
      continue;
    }
    const b = beforeMap.get(key)!;

    const aConst = a.constantValue === undefined ? '' : String(a.constantValue);
    const bConst = b.constantValue === undefined ? '' : String(b.constantValue);
    if (aConst !== bConst) changedConstantValues.push(key);

    if (a.referencedGlobals.join(',') !== b.referencedGlobals.join(',')) {
      changedGlobalDependencies.push(key);
    }

    if (a.dependencyDepth !== b.dependencyDepth) changedDependencyDepth.push(key);

    // Offset comparison for data/element segments only.
    if (a.section === 'data' && aConst !== bConst) changedDataOffsets.push(key);
    if (a.section === 'element' && aConst !== bConst) changedElementOffsets.push(key);
  }

  for (const key of beforeMap.keys()) {
    if (!afterMap.has(key)) removed.push(key);
  }

  return {
    added,
    removed,
    changedConstantValues,
    changedGlobalDependencies,
    changedDataOffsets,
    changedElementOffsets,
    changedDependencyDepth,
  };
}