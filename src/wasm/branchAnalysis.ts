/**
 * WASM branch condition analysis (ISSUE-284).
 *
 * Conditional branches decide which path a function follows, but the raw
 * instruction stream makes those decisions hard to read. This analyzer
 * identifies conditional branch sites, reconstructs the values feeding them
 * where statically possible, and classifies each condition by source.
 *
 * Conservative: a condition that cannot be resolved stays `unknown` rather
 * than being assigned a guessed source. Never executes the module.
 */

import { readFileSync } from 'fs';
import {
  buildModuleCFGs,
  classifySource,
  constValue,
  parseWasmAst,
  type FunctionCFG,
  type Instr,
  type ValueKind,
} from './cfg';

/** How a branch condition's value can be attributed. */
export type ConditionType =
  | 'constant'
  | 'parameter-derived'
  | 'local-derived'
  | 'global-derived'
  | 'memory-derived'
  | 'call-derived'
  | 'composite'
  | 'unknown';

export interface BranchRecord {
  funcIndex: number;
  blockIndex: number;
  instructionIndex: number;
  opcode: string;
  /** Resolved branch targets, when statically known. */
  targets: number[];
  conditionType: ConditionType;
  /** Every source contributing to the condition. */
  conditionSources: ValueKind[];
  /** Locals the condition reads. */
  localIndexes: number[];
  /** Globals the condition reads. */
  globalIndexes: number[];
  /** Constant value, when the condition is a literal. */
  constantValue?: number;
  /** True when this branch sits on a statically constant condition. */
  alwaysTrue?: boolean;
  alwaysFalse?: boolean;
  /** True when the condition reads mutable global state. */
  dependsOnMutableGlobals: boolean;
  /** True when the condition reads a function parameter. */
  dependsOnParameters: boolean;
  /** True when the condition reads memory. */
  dependsOnMemory: boolean;
}

export interface FunctionBranchStats {
  funcIndex: number;
  totalBranchSites: number;
  conditionalBranches: number;
  branchDensity: number;
}

export interface BranchReport {
  totals: {
    totalBranchSites: number;
    conditionalBranches: number;
    constantBranches: number;
    parameterDerived: number;
    localDerived: number;
    globalDerived: number;
    memoryDerived: number;
    callDerived: number;
    compositeBranches: number;
    unknownBranches: number;
    alwaysTrue: number;
    alwaysFalse: number;
  };
  functions: FunctionBranchStats[];
  branches: BranchRecord[];
  /** Conditions whose source set is shared by multiple branch sites. */
  sharedConditions: Array<{ sources: string[]; branchCount: number }>;
}

/** Opcodes that encode a conditional control-flow decision. */
const CONDITIONAL = new Set(['br_if', 'if']);

/** Bounded walk so loop-carried dependencies converge. */
const MAX_DEPTH = 48;

/** Walks backward from a branch to collect the values feeding its condition. */
function traceCondition(
  cfg: FunctionCFG,
  branchIndex: number,
): { sources: Set<ValueKind>; locals: Set<number>; globals: Set<number>; constant?: number } {
  const branch = cfg.instructions[branchIndex];
  const sources = new Set<ValueKind>();
  const locals = new Set<number>();
  const globals = new Set<number>();
  let constant: number | undefined;

  if (!branch) return { sources, locals, globals };

  const block = cfg.blocks[branch.block];
  if (!block) return { sources, locals, globals };

  const pos = block.instructionIndices.indexOf(branchIndex);

  // A br_if/if pops exactly one value: the nearest preceding producer in the
  // same block, or the block's entry condition from a predecessor.
  for (let p = pos - 1; p >= 0; p--) {
    const instr = cfg.instructions[block.instructionIndices[p]];
    if (!instr) continue;
    if (instr.isTerminator && instr.opcode !== 'end') break;

    const source = classifySource(instr);

    if (source === 'const') {
      const value = constValue(instr);
      if (constant === undefined) constant = value;
      sources.add('const');
      continue;
    }
    if (source === 'local') {
      const li = Number(instr.operands[0]);
      if (Number.isInteger(li)) locals.add(li);
      sources.add('local');
      continue;
    }
    if (source === 'global') {
      const gi = Number(instr.operands[0]);
      if (Number.isInteger(gi)) globals.add(gi);
      sources.add('global');
      continue;
    }
    if (source === 'memory') {
      sources.add('memory');
      continue;
    }
    if (source === 'call') {
      sources.add('call');
      continue;
    }
    if (instr.opcode === 'local.tee' || instr.opcode === 'local.set' || instr.opcode === 'global.set') {
      const idx = Number(instr.operands[0]);
      if (Number.isInteger(idx)) {
        if (instr.opcode.startsWith('local')) locals.add(idx);
        else globals.add(idx);
      }
      continue;
    }
    // Arithmetic feeding the condition: keep walking for its operands.
    sources.add('unknown');
  }

  // Fall back to predecessor blocks when the local block yields nothing.
  if (sources.size === 0) {
    for (const pred of block.predecessors) {
      const predBlock = cfg.blocks[pred];
      const last = predBlock?.instructionIndices[predBlock.instructionIndices.length - 1];
      if (last === undefined) continue;
      const instr = cfg.instructions[last];
      if (!instr) continue;
      sources.add(classifySource(instr));
      if (instr.opcode === 'local.get') {
        const li = Number(instr.operands[0]);
        if (Number.isInteger(li)) locals.add(li);
      }
    }
  }

  return { sources, locals, globals, constant };
}

/** Classifies a traced condition into a single ConditionType. */
function classifyCondition(
  sources: Set<ValueKind>,
  locals: Set<number>,
  constant: number | undefined,
  localCount: number,
): ConditionType {
  if (sources.size === 0) return 'unknown';

  const has = (k: ValueKind) => sources.has(k);

  // A literal alone is the only case we can decide outright.
  if (sources.size === 1 && has('const')) return 'constant';

  // Parameters occupy the low local indexes (params first, then declared locals).
  const touchesParam = [...locals].some((l) => l < localCount);
  const touchesLocal = [...locals].some((l) => l >= localCount);

  if (has('global') && (has('memory') || has('call') || has('local') || touchesLocal)) return 'composite';
  if (has('memory') && (has('call') || has('local') || touchesLocal)) return 'composite';
  if (has('call') && (has('memory') || has('local') || touchesLocal)) return 'composite';

  if (has('global')) return 'global-derived';
  if (has('memory')) return 'memory-derived';
  if (has('call')) return 'call-derived';

  if (touchesParam && touchesLocal) return 'composite';
  if (touchesLocal) return 'local-derived';
  if (touchesParam) return 'parameter-derived';

  if (has('local')) return 'local-derived';
  return 'unknown';
}

/** Analyzes every conditional branch site in a module. */
export function analyzeBranches(buffer: Buffer): BranchReport {
  const ast = parseWasmAst(buffer);
  const cfgs = buildModuleCFGs(ast);

  const branches: BranchRecord[] = [];
  const functions: FunctionBranchStats[] = [];

  cfgs.forEach((cfg) => {
    let totalBranchSites = 0;
    let conditionalBranches = 0;

    for (const instr of cfg.instructions) {
      // Every branch-family opcode counts as a branch site.
      if (!instr.opcode.startsWith('br') && !instr.opcode.startsWith('if') && instr.opcode !== 'return') {
        continue;
      }
      totalBranchSites++;

      if (!CONDITIONAL.has(instr.opcode)) continue;
      conditionalBranches++;

      const traced = traceCondition(cfg, instr.index);
      const conditionType = classifyCondition(
        traced.sources,
        traced.locals,
        traced.constant,
        cfg.localCount,
      );

      const targets = resolveTargets(cfg, instr);
      const constantValue = conditionType === 'constant' ? traced.constant : undefined;

      branches.push({
        funcIndex: cfg.funcIndex,
        blockIndex: instr.block,
        instructionIndex: instr.index,
        opcode: instr.opcode,
        targets,
        conditionType,
        conditionSources: [...traced.sources].sort(),
        localIndexes: [...traced.locals].sort((a, b) => a - b),
        globalIndexes: [...traced.globals].sort((a, b) => a - b),
        constantValue,
        alwaysTrue: conditionType === 'constant' ? constantValue !== 0 : undefined,
        alwaysFalse: conditionType === 'constant' ? constantValue === 0 : undefined,
        dependsOnMutableGlobals: traced.globals.size > 0,
        dependsOnParameters: [...traced.locals].some((l) => l < cfg.localCount),
        dependsOnMemory: traced.sources.has('memory'),
      });
    }

    functions.push({
      funcIndex: cfg.funcIndex,
      totalBranchSites,
      conditionalBranches,
      branchDensity: cfg.instructions.length > 0
        ? Number((conditionalBranches / cfg.instructions.length).toFixed(4))
        : 0,
    });
  });

  branches.sort(
    (a, b) => a.funcIndex - b.funcIndex || a.instructionIndex - b.instructionIndex,
  );

  // Conditions shared by more than one branch site.
  const groups = new Map<string, BranchRecord[]>();
  for (const b of branches) {
    const sig = b.conditionSources.join('+') || 'none';
    const list = groups.get(sig) ?? [];
    list.push(b);
    groups.set(sig, list);
  }
  const sharedConditions = [...groups.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([sources, list]) => ({ sources: sources.split('+'), branchCount: list.length }))
    .sort((a, b) => b.branchCount - a.branchCount);

  const count = (t: ConditionType) => branches.filter((b) => b.conditionType === t).length;

  return {
    totals: {
      totalBranchSites: functions.reduce((a, f) => a + f.totalBranchSites, 0),
      conditionalBranches: branches.length,
      constantBranches: count('constant'),
      parameterDerived: count('parameter-derived'),
      localDerived: count('local-derived'),
      globalDerived: count('global-derived'),
      memoryDerived: count('memory-derived'),
      callDerived: count('call-derived'),
      compositeBranches: count('composite'),
      unknownBranches: count('unknown'),
      alwaysTrue: branches.filter((b) => b.alwaysTrue === true).length,
      alwaysFalse: branches.filter((b) => b.alwaysFalse === true).length,
    },
    functions: functions.sort((a, b) => a.funcIndex - b.funcIndex),
    branches,
    sharedConditions,
  };
}

/** Resolves branch targets, staying conservative when they are not static. */
function resolveTargets(cfg: FunctionCFG, instr: Instr): number[] {
  const targets: number[] = [];
  if (instr.opcode === 'br_table') return targets; // table targets are not statically indexed here

  for (const succ of cfg.blocks[instr.block]?.successors ?? []) {
    if (!targets.includes(succ)) targets.push(succ);
  }
  return targets;
}

/** Convenience wrapper reading from disk. */
export function analyzeBranchesFile(path: string): BranchReport {
  return analyzeBranches(readFileSync(path));
}

/** CSV output — one normalized row per branch. */
export function branchesToCsv(report: BranchReport): string {
  const header = [
    'func_index',
    'block_index',
    'instruction_index',
    'opcode',
    'targets',
    'condition_type',
    'sources',
    'locals',
    'globals',
    'constant_value',
  ].join(',');

  const rows = report.branches.map((b) =>
    [
      b.funcIndex,
      b.blockIndex,
      b.instructionIndex,
      b.opcode,
      `"${b.targets.join(' ')}"`,
      b.conditionType,
      `"${b.conditionSources.join(' ')}"`,
      `"${b.localIndexes.join(' ')}"`,
      `"${b.globalIndexes.join(' ')}"`,
      b.constantValue === undefined ? '' : b.constantValue,
    ].join(','),
  );

  return [header, ...rows].join('\n');
}

/** DOT output of branch decisions and their targets. */
export function branchesToDot(report: BranchReport): string {
  const lines = ['digraph branches {', '  rankdir=LR;'];
  for (const f of report.functions) {
    lines.push(`  subgraph cluster_f${f.funcIndex} {`);
    lines.push(`    label="Function ${f.funcIndex}";`);
    for (const b of report.branches.filter((x) => x.funcIndex === f.funcIndex)) {
      lines.push(`    "${b.instructionIndex}" [label="${b.opcode}\n${b.conditionType}" class="${b.conditionType}"];`);
      for (const t of b.targets) {
        lines.push(`    "${b.instructionIndex}" -> "b${t}";`);
      }
    }
    lines.push('  }');
  }
  lines.push('}');
  return lines.join('\n');
}

/** Comparison of branch logic between two artifacts. */
export interface BranchComparison {
  addedBranchSites: string[];
  removedBranchSites: string[];
  changedBranchTargets: string[];
  changedConditionSources: string[];
  newlyConstantConditions: string[];
  becameUnresolved: string[];
}

export function compareBranches(before: BranchReport, after: BranchReport): BranchComparison {
  const k = (b: BranchRecord) => `${b.funcIndex}:${b.instructionIndex}`;
  const beforeMap = new Map(before.branches.map((b) => [k(b), b]));
  const afterMap = new Map(after.branches.map((b) => [k(b), b]));

  const addedBranchSites: string[] = [];
  const changedBranchTargets: string[] = [];
  const changedConditionSources: string[] = [];
  const newlyConstantConditions: string[] = [];
  const becameUnresolved: string[] = [];

  for (const [key, a] of afterMap) {
    const b = beforeMap.get(key);
    if (!b) {
      addedBranchSites.push(key);
      continue;
    }
    if (a.targets.join(',') !== b.targets.join(',')) changedBranchTargets.push(key);
    if (a.conditionSources.join(',') !== b.conditionSources.join(',')) changedConditionSources.push(key);
    if (a.conditionType === 'constant' && b.conditionType !== 'constant') {
      newlyConstantConditions.push(key);
    }
    if (a.conditionType === 'unknown' && b.conditionType !== 'unknown') {
      becameUnresolved.push(key);
    }
  }

  const removedBranchSites = [...beforeMap.keys()].filter((key) => !afterMap.has(key));

  return {
    addedBranchSites,
    removedBranchSites,
    changedBranchTargets,
    changedConditionSources,
    newlyConstantConditions,
    becameUnresolved,
  };
}