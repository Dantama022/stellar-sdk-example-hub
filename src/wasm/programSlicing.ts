/**
 * WASM program slicing (ISSUE-283).
 *
 * Large compiled functions contain thousands of instructions, which makes it
 * hard to isolate the code that actually contributes to a value. A backward
 * slice keeps the instructions that may influence a target; a forward slice
 * keeps the instructions that may depend on a source.
 *
 * Combines control-flow and data-flow information into a deterministic slice.
 * Never executes WASM — the module is only parsed.
 */

import { readFileSync } from 'fs';
import {
  buildModuleCFGs,
  classifySource,
  constValue,
  globalIndex,
  localIndex,
  parseWasmAst,
  type FunctionCFG,
  type Instr,
  type ValueKind,
} from './cfg';

export type SliceMode = 'backward' | 'forward' | 'bidirectional';

export interface SliceTarget {
  funcIndex?: number;
  blockIndex?: number;
  instructionIndex?: number;
  localIndex?: number;
  /** Target the function's return values instead of an instruction. */
  returnValue?: boolean;
}

/** Why an instruction is in the slice. */
export type DependencyKind = 'data' | 'control' | 'call' | 'cross-function' | 'unresolved';

export interface SliceMember {
  funcIndex: number;
  blockIndex: number;
  instructionIndex: number;
  opcode: string;
  /** How this instruction was reached. */
  dependency: DependencyKind;
  /** The local index involved, when the dependency is a local. */
  localIndex?: number;
}

export interface SlicePathStep {
  instructionIndex: number;
  opcode: string;
  source: ValueKind;
}

export interface SliceReport {
  mode: SliceMode;
  target: SliceTarget;
  stats: {
    originalInstructionCount: number;
    sliceInstructionCount: number;
    reductionPercentage: number;
    includedBlocks: number;
    includedFunctions: number;
    crossFunctionDependencies: number;
    unresolvedDependencies: number;
    controlDependencies: number;
    dataDependencies: number;
  };
  members: SliceMember[];
  /** Ordered path from the target back to its known sources (backward). */
  backwardPath: SlicePathStep[];
  /** Values influenced by the selected source (forward). */
  forwardInfluences: SlicePathStep[];
  /** Instruction indices that could not be resolved exactly. */
  unresolved: Array<{ funcIndex: number; instructionIndex: number; reason: string }>;
}

/** Instructions whose result flows onto the stack and matters for data deps. */
const PRODUCERS = new Set([
  'local.get',
  'global.get',
  'i32.const',
  'i64.const',
  'f32.const',
  'f64.const',
  'i32.load',
  'i64.load',
  'f32.load',
  'f64.load',
  'i32.load8_s',
  'i32.load8_u',
  'i32.load16_s',
  'i32.load16_u',
  'call',
  'call_indirect',
]);

const ARITHMETIC = /^(i32|i64|f32|f64)\.(add|sub|mul|div|rem|and|or|xor|shl|shr|eq|ne|lt|gt|le|ge|lt_u|gt_u|le_u|ge_u)$/;

/** Branch-table depth guard: keeps loop-carried analysis bounded. */
const MAX_DEPTH = 64;

const key = (f: number, i: number): string => `${f}:${i}`;

/**
 * Backward slice: instructions that may influence the target.
 *
 * Walks def-use edges backwards from the target instruction, and pulls in the
 * control predicates that decide whether the target executes at all.
 */
function sliceBackward(
  cfgs: Map<number, FunctionCFG>,
  target: SliceTarget,
  limitToFunction: boolean,
): {
  members: Map<string, SliceMember>;
  unresolved: SliceReport['unresolved'];
  crossFunction: number;
  path: SlicePathStep[];
} {
  const members = new Map<string, SliceMember>();
  const unresolved: SliceReport['unresolved'] = [];
  let crossFunction = 0;

  if (target.funcIndex === undefined || target.instructionIndex === undefined) {
    return { members, unresolved, crossFunction, path: [] };
  }

  const roots: Array<{ f: number; i: number }> = [];

  if (target.returnValue) {
    // Every terminator in the function can contribute to its return value.
    const cfg = cfgs.get(target.funcIndex);
    cfg?.instructions.filter((ins) => ins.isTerminator || ins.opcode === 'drop').forEach((ins) => {
      roots.push({ f: target.funcIndex, i: ins.index });
    });
  } else {
    roots.push({ f: target.funcIndex, i: target.instructionIndex });
  }

  const path: SlicePathStep[] = [];
  const queue = [...roots];
  const seen = new Set<string>();
  let depth = 0;

  while (queue.length > 0) {
    if (++depth > MAX_DEPTH * 64) break; // hard stop for pathological input

    const node = queue.shift()!;
    const k = key(node.f, node.i);
    if (seen.has(k)) continue;
    seen.add(k);

    const cfg = cfgs.get(node.f);
    const instr: Instr | undefined = cfg?.instructions[node.i];
    if (!cfg || !instr) continue;

    if (!members.has(k)) {
      members.set(k, {
        funcIndex: node.f,
        blockIndex: instr.block,
        instructionIndex: node.i,
        opcode: instr.opcode,
        dependency: 'data',
      });
    }

    const block = cfg.blocks[instr.block];
    if (!block) continue;

    // Control dependency: a predecessor block ending in br_if/br gates this.
    for (const pred of block.predecessors) {
      const predBlock = cfg.blocks[pred];
      const last = predBlock?.instructionIndices[predBlock.instructionIndices.length - 1];
      if (last === undefined) continue;
      const predInstr = cfg.instructions[last];
      if (!predInstr) continue;
      if (predInstr.opcode === 'br_if' || predInstr.opcode === 'br' || predInstr.opcode === 'br_table') {
        members.set(key(node.f, last), {
          funcIndex: node.f,
          blockIndex: predInstr.block,
          instructionIndex: last,
          opcode: predInstr.opcode,
          dependency: 'control',
        });
        // The condition feeding the branch also matters.
        const conditionProducer = findConditionProducer(cfg, last);
        if (conditionProducer !== undefined) {
          queue.push({ f: node.f, i: conditionProducer });
        }
      } else {
        // Straight-line predecessor still contributes values.
        queue.push({ f: node.f, i: last });
      }
    }

    // Same-block predecessors contribute stack values.
    const pos = block.instructionIndices.indexOf(node.i);
    if (pos > 0) {
      for (let p = pos - 1; p >= 0; p--) {
        const prev = block.instructionIndices[p];
        const prevInstr = cfg.instructions[prev];
        if (!prevInstr) continue;
        if (PRODUCERS.has(prevInstr.opcode) || ARITHMETIC.test(prevInstr.opcode)) {
          members.set(key(node.f, prev), {
            funcIndex: node.f,
            blockIndex: prevInstr.block,
            instructionIndex: prev,
            opcode: prevInstr.opcode,
            dependency: 'data',
          });
          queue.push({ f: node.f, i: prev });
          if (path.length < 64) {
            path.push({ instructionIndex: prev, opcode: prevInstr.opcode, source: classifySource(prevInstr) });
          }
        } else if (prevInstr.opcode.startsWith('local.set') || prevInstr.opcode.startsWith('global.set')) {
          queue.push({ f: node.f, i: prev });
        }
      }
    }

    // Cross-function: follow direct calls.
    if (instr.opcode === 'call') {
      const callee = Number(instr.operands[0]);
      const calleeCfg = cfgs.get(callee);
      if (calleeCfg) {
        crossFunction++;
        members.get(k)!.dependency = 'cross-function';
        calleeCfg.instructions
          .filter((i2) => i2.opcode === 'local.get' || i2.opcode.endsWith('.const'))
          .forEach((i2) => {
            if (!limitToFunction) {
              members.set(key(callee, i2.index), {
                funcIndex: callee,
                blockIndex: i2.block,
                instructionIndex: i2.index,
                opcode: i2.opcode,
                dependency: 'cross-function',
                localIndex: localIndex(i2),
              });
            }
          });
      } else {
        unresolved.push({ funcIndex: node.f, instructionIndex: node.i, reason: 'call target not in module' });
      }
    }

    if (instr.opcode === 'call_indirect') {
      unresolved.push({
        funcIndex: node.f,
        instructionIndex: node.i,
        reason: 'indirect call target not statically resolvable',
      });
      members.get(k)!.dependency = 'unresolved';
    }
  }

  return { members, unresolved, crossFunction, path };
}

/** Walks back from a branch to the last value producer — its condition. */
function findConditionProducer(cfg: FunctionCFG, branchIndex: number): number | undefined {
  const block = cfg.blocks[cfg.instructions[branchIndex]?.block ?? 0];
  if (!block) return undefined;
  const pos = block.instructionIndices.indexOf(branchIndex);
  for (let p = pos - 1; p >= 0; p--) {
    const instr = cfg.instructions[block.instructionIndices[p]];
    if (!instr) continue;
    if (PRODUCERS.has(instr.opcode) || ARITHMETIC.test(instr.opcode)) {
      return block.instructionIndices[p];
    }
    if (instr.isTerminator) return undefined;
  }
  return undefined;
}

/**
 * Forward slice: instructions that may depend on the source.
 *
 * Scans forward from the source definition, collecting consumers until a
 * fixed point.
 */
function sliceForward(
  cfgs: Map<number, FunctionCFG>,
  target: SliceTarget,
  limitToFunction: boolean,
): { members: Map<string, SliceMember>; influences: SlicePathStep[]; crossFunction: number } {
  const members = new Map<string, SliceMember>();
  const influences: SlicePathStep[] = [];
  let crossFunction = 0;

  if (target.funcIndex === undefined) {
    return { members, influences, crossFunction };
  }

  const cfg = cfgs.get(target.funcIndex);
  if (!cfg) return { members, influences, crossFunction };

  const seeds: number[] = [];
  if (target.instructionIndex !== undefined) {
    seeds.push(target.instructionIndex);
  } else if (target.localIndex !== undefined) {
    cfg.instructions
      .filter((i) => localIndex(i) === target.localIndex && i.opcode === 'local.get')
      .forEach((i) => seeds.push(i.index));
  } else if (target.returnValue) {
    cfg.instructions.filter((i) => i.isTerminator).forEach((i) => seeds.push(i.index));
  }

  const seedSet = new Set<string>();
  seeds.forEach((s) => {
    const k = key(target.funcIndex!, s);
    const instr = cfg.instructions[s];
    if (!instr) return;
    seedSet.add(k);
    members.set(k, {
      funcIndex: target.funcIndex!,
      blockIndex: instr.block,
      instructionIndex: s,
      opcode: instr.opcode,
      dependency: 'data',
      localIndex: localIndex(instr),
    });
  });

  // Propagate: any instruction consuming a tracked local/global joins the slice.
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    for (const instr of cfg.instructions) {
      const li = localIndex(instr);
      const gi = globalIndex(instr);
      const isConsumer =
        li !== undefined || gi !== undefined || ARITHMETIC.test(instr.opcode) || PRODUCERS.has(instr.opcode);

      if (!isConsumer) continue;

      const dependsOnSeed =
        (li !== undefined && target.localIndex !== undefined && li === target.localIndex) ||
        (instr.opcode === 'call') ||
        (target.instructionIndex !== undefined && instr.index > target.instructionIndex);

      if (!dependsOnSeed) continue;

      const k = key(cfg.funcIndex, instr.index);
      if (members.has(k)) continue;

      members.set(k, {
        funcIndex: cfg.funcIndex,
        blockIndex: instr.block,
        instructionIndex: instr.index,
        opcode: instr.opcode,
        dependency: instr.opcode === 'call' ? 'cross-function' : 'data',
        localIndex: li,
      });
      if (influences.length < 64) {
        influences.push({ instructionIndex: instr.index, opcode: instr.opcode, source: classifySource(instr) });
      }
      changed = true;
    }
    if (!changed) break;
  }

  // Propagate into directly-called functions.
  for (const m of [...members.values()]) {
    if (m.opcode !== 'call') continue;
    const callee = Number(m.operands?.[0] ?? NaN);
    const calleeCfg = cfgs.get(callee);
    if (!calleeCfg) continue;
    if (limitToFunction) continue;
    crossFunction++;
    calleeCfg.instructions
      .filter((i) => i.opcode === 'local.get')
      .forEach((i) => {
        members.set(key(callee, i.index), {
          funcIndex: callee,
          blockIndex: i.block,
          instructionIndex: i.index,
          opcode: i.opcode,
          dependency: 'cross-function',
          localIndex: localIndex(i),
        });
      });
  }

  return { members, influences, crossFunction };
}

/** Runs the slice analysis for a target and mode. */
export function sliceWasm(
  buffer: Buffer,
  target: SliceTarget,
  mode: SliceMode = 'backward',
): SliceReport {
  const ast = parseWasmAst(buffer);
  const cfgs = buildModuleCFGs(ast);

  let original = 0;
  cfgs.forEach((cfg) => { original += cfg.instructions.length; });

  const limitToFunction = target.funcIndex !== undefined && !target.crossFunction;

  const members = new Map<string, SliceMember>();
  let unresolved: SliceReport['unresolved'] = [];
  let crossFunction = 0;
  let backwardPath: SlicePathStep[] = [];
  let forwardInfluences: SlicePathStep[] = [];

  if (mode === 'backward' || mode === 'bidirectional') {
    const back = sliceBackward(cfgs, target, limitToFunction);
    back.members.forEach((v, k) => members.set(k, v));
    unresolved = unresolved.concat(back.unresolved);
    crossFunction += back.crossFunction;
    backwardPath = back.path;
  }

  if (mode === 'forward' || mode === 'bidirectional') {
    const fwd = sliceForward(cfgs, target, limitToFunction);
    fwd.members.forEach((v, k) => members.set(k, v));
    crossFunction += fwd.crossFunction;
    forwardInfluences = fwd.influences;
  }

  const memberList = [...members.values()].sort(
    (a, b) => a.funcIndex - b.funcIndex || a.instructionIndex - b.instructionIndex,
  );

  const includedBlocks = new Set(memberList.map((m) => `${m.funcIndex}:${m.blockIndex}`));
  const includedFunctions = new Set(memberList.map((m) => m.funcIndex));
  const controlDependencies = memberList.filter((m) => m.dependency === 'control').length;
  const dataDependencies = memberList.filter((m) => m.dependency === 'data').length;

  const sliceCount = memberList.length;
  const reduction =
    original > 0 ? Number((((original - sliceCount) / original) * 100).toFixed(2)) : 0;

  return {
    mode,
    target,
    stats: {
      originalInstructionCount: original,
      sliceInstructionCount: sliceCount,
      reductionPercentage: reduction,
      includedBlocks: includedBlocks.size,
      includedFunctions: includedFunctions.size,
      crossFunctionDependencies: crossFunction,
      unresolvedDependencies: unresolved.length,
      controlDependencies,
      dataDependencies,
    },
    members: memberList,
    backwardPath,
    forwardInfluences,
    unresolved,
  };
}

/** Convenience wrapper reading from disk. */
export function sliceWasmFile(path: string, target: SliceTarget, mode: SliceMode = 'backward'): SliceReport {
  return sliceWasm(readFileSync(path), target, mode);
}

/** DOT output of the slice dependency graph. */
export function sliceToDot(report: SliceReport): string {
  const lines = ['digraph slice {', '  rankdir=LR;'];
  for (const m of report.members) {
    lines.push(`  "${m.funcIndex}:${m.instructionIndex}" [label="${m.opcode}" class="${m.dependency}"];`);
  }
  lines.push(`  // mode=${report.mode} members=${report.members.length}`);
  for (const u of report.unresolved) {
    lines.push(`  // unresolved ${u.funcIndex}:${u.instructionIndex} — ${u.reason}`);
  }
  lines.push('}');
  return lines.join('\n');
}

/** Compares two artifacts' slices for the same target. */
export interface SliceComparison {
  addedInstructions: string[];
  removedInstructions: string[];
  addedDependencies: string[];
  removedDependencies: string[];
  newUnresolved: string[];
  changedCrossFunctionDependencies: number;
}

export function compareSlices(before: SliceReport, after: SliceReport): SliceComparison {
  const k = (m: SliceMember) => `${m.funcIndex}:${m.instructionIndex}`;
  const beforeSet = new Set(before.members.map(k));
  const afterSet = new Set(after.members.map(k));

  const depKey = (m: SliceMember) => `${k(m)}:${m.dependency}`;

  return {
    addedInstructions: [...afterSet].filter((x) => !beforeSet.has(x)),
    removedInstructions: [...beforeSet].filter((x) => !afterSet.has(x)),
    addedDependencies: after.members.map(depKey).filter((x) => !before.members.map(depKey).includes(x)),
    removedDependencies: before.members.map(depKey).filter((x) => !after.members.map(depKey).includes(x)),
    newUnresolved: after.unresolved
      .map((u) => `${u.funcIndex}:${u.instructionIndex}`)
      .filter((x) => !before.unresolved.map((u) => `${u.funcIndex}:${u.instructionIndex}`).includes(x)),
    changedCrossFunctionDependencies:
      after.stats.crossFunctionDependencies - before.stats.crossFunctionDependencies,
  };
}